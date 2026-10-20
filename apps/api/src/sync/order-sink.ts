/**
 * 订单落库 sink —— t43：`syncOrders` 从"只推进游标"升级为真实写 `orders` + `order_items`。
 *
 * 约束（来自 t37 表结构与队长口径）：
 * - 幂等键 `(platform, platform_order_id)`（唯一索引 `uq_order_platform ... WHERE archived_at IS NULL`）；
 * - `orders.buyer_ref` 必须是 **sha256 hex（64 位小写）**：DB 硬 CHECK，禁止把昵称/手机号原样落库；
 * - `after_sale.order_id` 是 RESTRICT：本 sink **只 upsert，不删除订单**；
 * - `order_items` 对 order_id 是 CASCADE、对 listing/sku 是 SET NULL：不因 listing_id 为空报异常；
 * - 平台状态词表受 DB CHECK 约束（pending/paid/shipped/delivered/completed/refunding/refunded/cancelled），
 *   未知状态直接拒绝（避免把平台新状态静默写坏）。
 */

import type { PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { Platform } from '../reconcile/types.js';
import type { SyncSink, SyncSinkContext, SyncSinkResult } from './types.js';

const ORDER_STATUSES = new Set([
  'pending',
  'paid',
  'shipped',
  'delivered',
  'completed',
  'refunding',
  'refunded',
  'cancelled',
]);

const BUYER_REF_RE = /^[0-9a-f]{64}$/;

interface RawOrderItem {
  platform_sku_ref: string;
  title?: string;
  qty: number;
  unit_price_cents: number;
  amount_cents?: number;
  color_id?: string | null;
  size_code?: string | null;
  attrs?: Record<string, unknown>;
}

interface RawOrder {
  order_id: string;
  status: string;
  total_cents: number;
  freight_cents?: number;
  discount_cents?: number;
  paid_cents: number;
  buyer_ref: string;
  buyer_note?: string | null;
  platform_created_at: string;
  items: RawOrderItem[];
}

function fail(field: string, message: string, actual: unknown): never {
  throw new ApiError('validation_failed', `订单同步数据非法：${message}`, {
    detail: { field, expected: message, actual: typeof actual === 'object' ? '[object]' : String(actual) },
  });
}

function asInt(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(field, `整数且 ≥${min}`, value);
  }
  return value;
}

function asString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    fail(field, `非空字符串（≤${max}）`, value);
  }
  return value;
}

function parseOrder(raw: unknown): RawOrder {
  if (typeof raw !== 'object' || raw === null) fail('order', '对象', raw);
  const record = raw as Record<string, unknown>;
  const platformOrderId = asString(record.order_id, 'order_id', 128);
  const status = asString(record.status, 'status', 32);
  if (!ORDER_STATUSES.has(status)) {
    fail('status', `DB 允许的订单状态（${[...ORDER_STATUSES].join('|')}）`, status);
  }
  const buyerRef = asString(record.buyer_ref, 'buyer_ref', 64);
  if (!BUYER_REF_RE.test(buyerRef)) {
    // 隐私保护：buyer_ref 只能是 sha256 hex；明文昵称/手机号会被 DB 23514 拒绝。
    fail('buyer_ref', 'sha256 hex（64 位小写，禁止明文买家信息）', buyerRef);
  }
  const createdAt = asString(record.platform_created_at, 'platform_created_at', 64);
  if (Number.isNaN(Date.parse(createdAt))) fail('platform_created_at', 'ISO 时间戳', createdAt);
  if (!Array.isArray(record.items) || record.items.length === 0) fail('items', '至少 1 条明细', record.items);
  const items = record.items.map((item, index) => {
    if (typeof item !== 'object' || item === null) fail(`items[${index}]`, '对象', item);
    const entry = item as Record<string, unknown>;
    const qty = asInt(entry.qty, `items[${index}].qty`, 1);
    const unitPriceCents = asInt(entry.unit_price_cents, `items[${index}].unit_price_cents`, 0);
    const amountCents = asInt(entry.amount_cents ?? qty * unitPriceCents, `items[${index}].amount_cents`, 0);
    return {
      platform_sku_ref: asString(entry.platform_sku_ref, `items[${index}].platform_sku_ref`, 128),
      title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title.slice(0, 500) : platformOrderId,
      qty,
      unit_price_cents: unitPriceCents,
      amount_cents: amountCents,
      color_id: typeof entry.color_id === 'string' ? entry.color_id : null,
      size_code: typeof entry.size_code === 'string' ? entry.size_code : null,
      attrs: typeof entry.attrs === 'object' && entry.attrs !== null ? (entry.attrs as Record<string, unknown>) : {},
    };
  });
  return {
    order_id: platformOrderId,
    status,
    total_cents: asInt(record.total_cents, 'total_cents', 0),
    freight_cents: asInt(record.freight_cents ?? 0, 'freight_cents', 0),
    discount_cents: asInt(record.discount_cents ?? 0, 'discount_cents', 0),
    paid_cents: asInt(record.paid_cents, 'paid_cents', 0),
    buyer_ref: buyerRef,
    buyer_note: typeof record.buyer_note === 'string' ? record.buyer_note.slice(0, 1000) : null,
    platform_created_at: createdAt,
    items,
  };
}

/** Postgres 实现：订单按 (platform, platform_order_id) upsert，明细按 (order_id, platform_sku_ref) upsert。 */
export class PrismaOrderSink implements SyncSink {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly orgId: bigint = 1n,
  ) {}

  async apply(items: readonly unknown[], context: SyncSinkContext): Promise<SyncSinkResult> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const raw of items) {
      const order = parseOrder(raw);
      const outcome = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.order.findFirst({
          where: { orgId: this.orgId, platform: context.platform, platformOrderId: order.order_id, archivedAt: null },
        });
        let changed = false;
        let orderId: string;
        if (!existing) {
          const row = await tx.order.create({
            data: {
              id: uuidv7(context.now.getTime()),
              orgId: this.orgId,
              platform: context.platform,
              platformOrderId: order.order_id,
              status: order.status,
              totalCents: order.total_cents,
              freightCents: order.freight_cents ?? 0,
              discountCents: order.discount_cents ?? 0,
              paidCents: order.paid_cents,
              buyerRef: order.buyer_ref,
              buyerNote: order.buyer_note,
              platformCreatedAt: new Date(order.platform_created_at),
              syncedAt: context.now,
            },
            select: { id: true },
          });
          orderId = row.id;
          return { state: 'created' as const, orderId };
        }
        orderId = existing.id;
        const next = {
          status: order.status,
          totalCents: order.total_cents,
          freightCents: order.freight_cents ?? 0,
          discountCents: order.discount_cents ?? 0,
          paidCents: order.paid_cents,
          buyerRef: order.buyer_ref,
          buyerNote: order.buyer_note,
          platformCreatedAt: new Date(order.platform_created_at),
          syncedAt: context.now,
        };
        changed =
          existing.status !== next.status ||
          existing.totalCents !== next.totalCents ||
          existing.freightCents !== next.freightCents ||
          existing.discountCents !== next.discountCents ||
          existing.paidCents !== next.paidCents ||
          existing.buyerRef !== next.buyerRef ||
          existing.buyerNote !== next.buyerNote;
        if (changed) {
          await tx.order.update({ where: { id: orderId }, data: next });
        }
        return { state: 'existing' as const, orderId, orderChanged: changed };
      });

      // 明细：不删除（平台可能漏传），只 upsert。
      let itemChanged = false;
      for (const item of order.items) {
        const existingItem = await this.prisma.orderItem.findFirst({
          where: { orderId: outcome.orderId, platformSkuRef: item.platform_sku_ref, archivedAt: null },
          select: { id: true, qty: true, unitPriceCents: true, amountCents: true, title: true },
        });
        if (!existingItem) {
          await this.prisma.orderItem.create({
            data: {
              id: uuidv7(context.now.getTime()),
              orgId: this.orgId,
              orderId: outcome.orderId,
              platformSkuRef: item.platform_sku_ref,
              title: item.title ?? order.order_id,
              colorId: item.color_id ?? null,
              sizeCode: item.size_code ?? null,
              qty: item.qty,
              unitPriceCents: item.unit_price_cents,
              amountCents: item.amount_cents,
              attrs: item.attrs ?? {},
            },
          });
          itemChanged = true;
          continue;
        }
        if (
          existingItem.qty !== item.qty ||
          existingItem.unitPriceCents !== item.unit_price_cents ||
          existingItem.amountCents !== item.amount_cents ||
          existingItem.title !== (item.title ?? order.order_id)
        ) {
          await this.prisma.orderItem.update({
            where: { id: existingItem.id },
            data: {
              qty: item.qty,
              unitPriceCents: item.unit_price_cents,
              amountCents: item.amount_cents,
              title: item.title ?? order.order_id,
            },
          });
          itemChanged = true;
        }
      }

      if (outcome.state === 'created') created += 1;
      else if ((outcome.orderChanged ?? false) || itemChanged) updated += 1;
      else skipped += 1;
    }
    return { created, updated, skipped };
  }
}

/** 内存实现（单测；语义同 Prisma 版：幂等键 (platform, platform_order_id)）。 */
export class MemoryOrderSink implements SyncSink {
  readonly orders = new Map<string, RawOrder>();

  async apply(items: readonly unknown[], context: SyncSinkContext): Promise<SyncSinkResult> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const raw of items) {
      const order = parseOrder(raw);
      const key = `${context.platform}|${order.order_id}`;
      const existing = this.orders.get(key);
      if (!existing) {
        this.orders.set(key, order);
        created += 1;
      } else if (JSON.stringify(existing) === JSON.stringify(order)) {
        skipped += 1;
      } else {
        this.orders.set(key, order);
        updated += 1;
      }
    }
    return { created, updated, skipped };
  }
}

export type { Platform };
