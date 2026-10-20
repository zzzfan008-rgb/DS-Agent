/**
 * 售后落库 sink —— t49：`syncAfterSale` 从"只推进游标"升级为真实写 `after_sale`。
 *
 * 约束（来自 t37 表结构与 DB 硬约束）：
 * - 幂等键 `(platform, platform_after_sale_id)`（唯一索引 `uq_after_sale ... WHERE archived_at IS NULL`）；
 * - **`after_sale.order_id` 是 NOT NULL + FK RESTRICT**：本地缺订单时**不能**写空值，也不能伪造订单。
 *   这类售后**不静默丢弃**：计入 `pending`（原因 `order_missing`），并由对账的
 *   `after_sale_platform_only` 继续报出来 —— 风险保持可见，等 `orders` 同步补齐后重跑即可落库；
 * - `kind` 受 `ck_after_sale_kind` 约束（`refund_only/return_refund/exchange`），未知值直接拒绝；
 * - `amount_cents >= 0`、`reason` ≤ 1000 字符；
 * - `closed_at` 由状态推导（`closed`/`cancelled` 且平台未给时间时用 `opened_at` 兜底）；
 * - **不删除**任何售后行（对账/审计依赖历史）。
 */

import type { Prisma, PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { Platform } from '../reconcile/types.js';
import type { SyncReader, SyncSink, SyncSinkContext, SyncSinkResult } from './types.js';

/** 与 `ck_after_sale_kind` 一致（DB 硬约束）。 */
const AFTER_SALE_KINDS = new Set(['refund_only', 'return_refund', 'exchange']);

/** 视为"已关闭"的状态词（用于推导 closed_at）。 */
const CLOSED_STATUSES = new Set(['closed', 'cancelled', 'canceled']);

interface RawAfterSale {
  after_sale_id: string;
  order_id: string;
  kind: string;
  status: string;
  amount_cents: number;
  reason?: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
  raw_object_key?: string | null;
}

function fail(field: string, message: string, actual: unknown): never {
  throw new ApiError('validation_failed', `售后同步数据非法：${message}`, {
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

function asOptionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(field, 'ISO 时间戳或 null', value);
  return value;
}

function parseAfterSale(raw: unknown): RawAfterSale {
  if (typeof raw !== 'object' || raw === null) fail('after_sale', '对象', raw);
  const record = raw as Record<string, unknown>;
  const afterSaleId = asString(record.after_sale_id, 'after_sale_id', 128);
  const orderId = asString(record.order_id, 'order_id', 128);
  const kind = asString(record.kind, 'kind', 32);
  if (!AFTER_SALE_KINDS.has(kind)) {
    fail('kind', `DB 允许的售后类型（${[...AFTER_SALE_KINDS].join('|')}）`, kind);
  }
  const status = asString(record.status, 'status', 32);
  const amountCents = asInt(record.amount_cents, 'amount_cents', 0);
  const reason = typeof record.reason === 'string' && record.reason.length > 0 ? record.reason.slice(0, 1000) : null;
  const openedAt = asOptionalIso(record.opened_at, 'opened_at');
  const closedAt = asOptionalIso(record.closed_at, 'closed_at');
  const rawObjectKey =
    typeof record.raw_object_key === 'string' && record.raw_object_key.length > 0
      ? record.raw_object_key.slice(0, 500)
      : null;
  return {
    after_sale_id: afterSaleId,
    order_id: orderId,
    kind,
    status,
    amount_cents: amountCents,
    reason,
    opened_at: openedAt,
    closed_at: closedAt,
    raw_object_key: rawObjectKey,
  };
}

/** closed_at 推导：平台给了就用；状态已关闭但没给时间时用 opened_at 兜底（不编造"现在"）。 */
function deriveClosedAt(row: RawAfterSale, fallback: Date): Date | null {
  if (row.closed_at) return new Date(row.closed_at);
  if (!CLOSED_STATUSES.has(row.status)) return null;
  return row.opened_at ? new Date(row.opened_at) : fallback;
}

function addPending(result: SyncSinkResult, reason: string): void {
  result.pending = (result.pending ?? 0) + 1;
  result.pending_reasons = result.pending_reasons ?? {};
  result.pending_reasons[reason] = (result.pending_reasons[reason] ?? 0) + 1;
}

/**
 * Postgres 实现：售后按 `(platform, platform_after_sale_id)` upsert。
 *
 * 关联订单：先用 `(platform, platform_order_id)` 在本地 `orders` 里找；找不到 → 计入 pending，
 * **不写库**（order_id 是 NOT NULL + FK RESTRICT，写不了，也不该伪造）。
 */
export class PrismaAfterSaleSink implements SyncSink {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly orgId: bigint = 1n,
  ) {}

  async apply(items: readonly unknown[], context: SyncSinkContext): Promise<SyncSinkResult> {
    const result: SyncSinkResult = { created: 0, updated: 0, skipped: 0 };

    // 订单号 → 本地 order.id（批量取，避免逐条查询）。
    const platformOrderIds = [...new Set(items.map((raw) => parseAfterSale(raw).order_id))];
    const orders = await this.prisma.order.findMany({
      where: {
        orgId: this.orgId,
        platform: context.platform,
        platformOrderId: { in: platformOrderIds },
        archivedAt: null,
      },
      select: { id: true, platformOrderId: true },
    });
    const orderIdByPlatformId = new Map(orders.map((row) => [row.platformOrderId, row.id]));

    for (const raw of items) {
      const row = parseAfterSale(raw);
      const orderId = orderIdByPlatformId.get(row.order_id);
      if (!orderId) {
        // 不丢、不伪造：计入 pending，交给对账 `after_sale_platform_only` 继续报。
        addPending(result, 'order_missing');
        continue;
      }

      const openedAt = row.opened_at ? new Date(row.opened_at) : context.now;
      const closedAt = deriveClosedAt(row, openedAt);
      const next = {
        orderId,
        kind: row.kind,
        status: row.status,
        amountCents: row.amount_cents,
        reason: row.reason,
        openedAt,
        closedAt,
        rawObjectKey: row.raw_object_key,
      };

      const existing = await this.prisma.afterSale.findFirst({
        where: {
          orgId: this.orgId,
          platform: context.platform,
          platformAfterSaleId: row.after_sale_id,
          archivedAt: null,
        },
        select: {
          id: true,
          orderId: true,
          kind: true,
          status: true,
          amountCents: true,
          reason: true,
          openedAt: true,
          closedAt: true,
          rawObjectKey: true,
        },
      });

      if (!existing) {
        await this.prisma.afterSale.create({
          data: {
            id: uuidv7(context.now.getTime()),
            orgId: this.orgId,
            platform: context.platform,
            platformAfterSaleId: row.after_sale_id,
            ...next,
            reason: next.reason ?? undefined,
            rawObjectKey: next.rawObjectKey ?? undefined,
          } satisfies Prisma.AfterSaleCreateInput as Prisma.AfterSaleCreateInput,
        });
        result.created += 1;
        continue;
      }

      const changed =
        existing.orderId !== next.orderId ||
        existing.kind !== next.kind ||
        existing.status !== next.status ||
        existing.amountCents !== next.amountCents ||
        existing.reason !== next.reason ||
        existing.openedAt.getTime() !== next.openedAt.getTime() ||
        (existing.closedAt?.getTime() ?? null) !== (next.closedAt?.getTime() ?? null) ||
        existing.rawObjectKey !== next.rawObjectKey;
      if (changed) {
        await this.prisma.afterSale.update({
          where: { id: existing.id },
          data: {
            ...next,
            reason: next.reason ?? null,
            rawObjectKey: next.rawObjectKey ?? null,
          },
        });
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }
}

/** 内存实现（单测；语义同 Prisma 版：幂等键 (platform, platform_after_sale_id)，缺订单计入 pending）。 */
export class MemoryAfterSaleSink implements SyncSink {
  /** key = `${platform}|${after_sale_id}` */
  readonly rows = new Map<string, RawAfterSale & { orderId: string | null }>();
  /** 已知订单号（测试可注入）；为空时视为"所有订单都不存在"。 */
  readonly knownOrders = new Set<string>();

  async apply(items: readonly unknown[], context: SyncSinkContext): Promise<SyncSinkResult> {
    const result: SyncSinkResult = { created: 0, updated: 0, skipped: 0 };
    for (const raw of items) {
      const row = parseAfterSale(raw);
      if (!this.knownOrders.has(row.order_id)) {
        addPending(result, 'order_missing');
        continue;
      }
      const key = `${context.platform}|${row.after_sale_id}`;
      const existing = this.rows.get(key);
      if (!existing) {
        this.rows.set(key, { ...row, orderId: row.order_id });
        result.created += 1;
      } else if (JSON.stringify(existing) === JSON.stringify({ ...row, orderId: row.order_id })) {
        result.skipped += 1;
      } else {
        this.rows.set(key, { ...row, orderId: row.order_id });
        result.updated += 1;
      }
    }
    return result;
  }
}

/** 重放上限默认值：超过就降级为"只处理 pending 那部分"，避免大店量级把 orders 同步拖慢。 */
export const DEFAULT_AFTER_SALE_RETRY_MAX_ITEMS = 5000;

export interface PendingReplayOptions {
  /** 单次重放最多处理多少条售后（默认 {@link DEFAULT_AFTER_SALE_RETRY_MAX_ITEMS}）。 */
  maxItems?: number;
}

export interface PendingReplayOutcome {
  created: number;
  updated: number;
  skipped: number;
  /** 重放后仍然 pending 的条数（订单还是没到）。 */
  pending: number;
  /** 售后总数超过 `maxItems` → 只处理了前 N 条，`degraded=true`。 */
  degraded: boolean;
  /** 本次读取到的售后总条数。 */
  scanned: number;
}

/**
 * pending 重放（t50）：`orders` 同步成功后，把因缺订单而 pending 的售后重新关联落库。
 *
 * 关键设计：
 * - **不推进 after_sale 游标**：这是"重放关联"而非"再同步一遍"；推进游标会让后续增量漏数据；
 * - **不持久化 pending 清单**：pending 的唯一事实源是"平台侧这笔售后挂在哪张订单上"，
 *   持久化一份就是第二份真相，会和平台漂移；每次从 reader 重新读全量即可；
 * - **幂等**：落库仍走 `(platform, platform_after_sale_id)` 唯一索引，重复触发只会 skipped；
 * - **上限**：超过 `maxItems` 时只处理前 N 条并置 `degraded=true`，由调用方打 WARNING。
 */
export async function replayPendingAfterSales(
  reader: SyncReader,
  sink: SyncSink,
  platform: Platform,
  now: Date,
  options: PendingReplayOptions = {},
): Promise<PendingReplayOutcome> {
  const maxItems = options.maxItems ?? DEFAULT_AFTER_SALE_RETRY_MAX_ITEMS;
  // 从 cursor=null 读全量：pending 的那笔可能在任何历史页里，增量读会漏。
  const page = await reader.read({
    platform,
    resource: 'after_sale',
    cursor: null,
    since: null,
    pageSize: Math.max(1, maxItems),
    pageIndex: 0,
  });
  const scanned = page.items.length;
  const degraded = scanned > maxItems;
  const items = degraded ? page.items.slice(0, maxItems) : page.items;
  const result = await sink.apply(items, { platform, now });
  return {
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    pending: result.pending ?? 0,
    degraded,
    scanned,
  };
}

export type { Platform };
