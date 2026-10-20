/**
 * 对账服务 —— 拉平台快照 + 读本地 listing/订单/售后 → 差异引擎 → 幂等落存储 → 审计。
 *
 * 不自动修改任何业务数据（任务硬约束）；只输出"待处理清单 + 可执行修复建议"。
 * 订单/售后维度：t37 的 `orders/order_items/after_sale` 就绪后已接入；表缺失时（旧库）
 * Prisma 查询会直接报错，这正是要暴露的问题，不再静默返回"已检查、无差异"。
 */

import type { PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { AuditService } from '../services/audit.js';
import { diffAll, countByKind } from './engine.js';
import type { PlatformSnapshotReader } from './readers.js';
import type { DriftStore, UpsertResult } from './stores.js';
import type {
  DetectedDrift,
  DriftKind,
  LocalAfterSaleSnapshot,
  LocalListingSnapshot,
  LocalOrderSnapshot,
  Platform,
  PlatformSnapshot,
} from './types.js';

export interface ReconcileRunInput {
  day: string;
  requestId: string;
  actorId: string;
  /** 平台快照来源；默认 recorded（真实 adapter 未核验，会硬拒绝）。 */
  mode?: 'recorded' | 'adapter';
}

export interface ReconcileRunResult {
  reconcile_id: string;
  platform: Platform;
  day: string;
  started_at: string;
  finished_at: string;
  reader_mode: string;
  snapshot: {
    source: PlatformSnapshot['source'];
    verified: boolean;
    complete: boolean;
    orders_complete: boolean;
    after_sales_complete: boolean;
    captured_at: string;
    note: string;
  };
  store: DriftStore['name'];
  store_note: string;
  checked: {
    local_listings: number;
    platform_items: number;
    listings: { checked: true };
    /** 快照不完整时跳过"平台缺失"推断（避免样本不全导致全量误报）。 */
    local_missing_check: { checked: boolean; reason?: string };
    orders: {
      checked: true;
      local_orders: number;
      platform_orders: number;
      complete: boolean;
      /** 记录口径：金额比较 total+paid；状态含退款状态；明细按 platform_sku_ref。 */
      compared_fields: string[];
    };
    after_sale: {
      checked: true;
      local_after_sales: number;
      platform_after_sales: number;
      complete: boolean;
      compared_fields: string[];
    };
  };
  summary: {
    total: number;
    by_kind: Record<string, number>;
    by_severity: Record<string, number>;
  };
  persisted: UpsertResult;
  diffs: DetectedDrift[];
}

export interface ReconcileServiceOptions {
  prisma: PrismaClient;
  store: DriftStore;
  storeNote: string;
  reader: PlatformSnapshotReader;
  audit?: AuditService;
  now?: () => Date;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseBindings(raw: unknown): LocalListingSnapshot['skuBindings'] {
  if (!Array.isArray(raw)) return [];
  const bindings: LocalListingSnapshot['skuBindings'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    bindings.push({
      skuId: typeof record.sku_id === 'string' ? record.sku_id : typeof record.skuId === 'string' ? record.skuId : null,
      platformSkuId:
        typeof record.platform_sku_id === 'string'
          ? record.platform_sku_id
          : typeof record.platformSkuId === 'string'
            ? record.platformSkuId
            : null,
      priceCents: toFiniteNumber(record.price_cents ?? record.priceCents),
      stockQty: toFiniteNumber(record.stock_qty ?? record.stockQty),
    });
  }
  return bindings;
}

export class ReconcileService {
  private readonly prisma: PrismaClient;
  private readonly store: DriftStore;
  private readonly storeNote: string;
  private readonly reader: PlatformSnapshotReader;
  private readonly audit: AuditService | undefined;
  private readonly now: () => Date;

  constructor(options: ReconcileServiceOptions) {
    this.prisma = options.prisma;
    this.store = options.store;
    this.storeNote = options.storeNote;
    this.reader = options.reader;
    this.audit = options.audit;
    this.now = options.now ?? (() => new Date());
  }

  /** 读本地 listing 快照（只读，最多 5000 条；超出时 detail 里会体现平台侧可能更多）。 */
  async loadLocalListings(platform: Platform, limit = 5000): Promise<LocalListingSnapshot[]> {
    const rows = await this.prisma.listing.findMany({
      where: { orgId: 1n, platform, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platformItemId: true,
        status: true,
        platformState: true,
        title: true,
        updatedAt: true,
        rejectMeta: true,
        skuBindings: true,
      },
    });
    return rows.map((row) => ({
      listingId: row.id,
      platformItemId: row.platformItemId,
      status: row.status,
      platformState: row.platformState,
      title: row.title,
      updatedAt: row.updatedAt.toISOString(),
      rejectMeta: row.rejectMeta,
      skuBindings: parseBindings(row.skuBindings),
    }));
  }

  /**
   * 读本地订单 + 明细（t37 `orders`/`order_items`）。Prisma schema 未声明 relation，
   * 因此分两次查询再按 order_id 分组，避免 N+1。
   */
  async loadLocalOrders(platform: Platform, limit = 5000): Promise<LocalOrderSnapshot[]> {
    const orders = await this.prisma.order.findMany({
      where: { orgId: 1n, platform, archivedAt: null },
      orderBy: { platformCreatedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platformOrderId: true,
        status: true,
        totalCents: true,
        paidCents: true,
      },
    });
    if (orders.length === 0) return [];
    const items = await this.prisma.orderItem.findMany({
      where: { orgId: 1n, orderId: { in: orders.map((order) => order.id) }, archivedAt: null },
      select: {
        id: true,
        orderId: true,
        platformSkuRef: true,
        qty: true,
        unitPriceCents: true,
        amountCents: true,
      },
    });
    const itemsByOrder = new Map<string, LocalOrderSnapshot['items']>();
    for (const item of items) {
      const list = itemsByOrder.get(item.orderId) ?? [];
      list.push({
        orderItemId: item.id,
        platformSkuRef: item.platformSkuRef,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
      });
      itemsByOrder.set(item.orderId, list);
    }
    return orders.map((order) => ({
      orderId: order.id,
      platformOrderId: order.platformOrderId,
      status: order.status,
      totalCents: order.totalCents,
      paidCents: order.paidCents,
      refundStatus: null, // 由 loadLocalAfterSales 计算后回填，见 run()
      items: itemsByOrder.get(order.id) ?? [],
    }));
  }

  /** 读本地售后（t37 `after_sale`），并把订单 id 映射成平台订单号。 */
  async loadLocalAfterSales(platform: Platform, limit = 5000): Promise<LocalAfterSaleSnapshot[]> {
    const rows = await this.prisma.afterSale.findMany({
      where: { orgId: 1n, platform, archivedAt: null },
      orderBy: { openedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platformAfterSaleId: true,
        orderId: true,
        status: true,
        amountCents: true,
      },
    });
    if (rows.length === 0) return [];
    const orderIds = [...new Set(rows.map((row) => row.orderId))];
    const orders = await this.prisma.order.findMany({
      where: { orgId: 1n, id: { in: orderIds }, archivedAt: null },
      select: { id: true, platformOrderId: true },
    });
    const platformOrderByLocalId = new Map(orders.map((order) => [order.id, order.platformOrderId]));
    return rows
      .map((row) => {
        const platformOrderId = platformOrderByLocalId.get(row.orderId);
        if (!platformOrderId) return null;
        return {
          afterSaleId: row.id,
          platformAfterSaleId: row.platformAfterSaleId,
          platformOrderId,
          status: row.status,
          amountCents: row.amountCents,
        } satisfies LocalAfterSaleSnapshot;
      })
      .filter((row): row is LocalAfterSaleSnapshot => row !== null);
  }

  /** 本地退款状态：由售后状态推导（refunded > refunding > none）。 */
  private static deriveRefundStatus(afterSales: readonly { status: string }[]): string {
    if (afterSales.some((row) => ['refunded', 'completed', 'success'].includes(row.status))) return 'refunded';
    if (afterSales.some((row) => ['open', 'refunding', 'pending', 'processing'].includes(row.status))) return 'refunding';
    return 'none';
  }

  async run(platform: Platform, input: ReconcileRunInput): Promise<ReconcileRunResult> {
    const startedAt = this.now().toISOString();
    const snapshot = await this.reader.read(platform, { day: input.day, now: startedAt });
    if (snapshot.platform !== platform) {
      throw new ApiError('internal_error', `平台快照与请求不一致：${snapshot.platform} != ${platform}`);
    }
    const local = await this.loadLocalListings(platform);
    const localOrders = await this.loadLocalOrders(platform);
    const localAfterSales = await this.loadLocalAfterSales(platform);

    // 本地订单的退款状态由售后行推导（平台快照里的 refundStatus 是平台口径，两者要能对得上）。
    const afterSalesByPlatformOrder = new Map<string, Array<{ status: string }>>();
    for (const row of localAfterSales) {
      const list = afterSalesByPlatformOrder.get(row.platformOrderId) ?? [];
      list.push({ status: row.status });
      afterSalesByPlatformOrder.set(row.platformOrderId, list);
    }
    for (const order of localOrders) {
      order.refundStatus = ReconcileService.deriveRefundStatus(afterSalesByPlatformOrder.get(order.platformOrderId) ?? []);
    }

    const detected = diffAll(
      { listings: local, orders: localOrders, afterSales: localAfterSales },
      snapshot,
      { platform, day: input.day, now: startedAt },
    );

    const persisted = await this.store.upsert(platform, input.day, detected);

    const byKind: Record<string, number> = countByKind(detected);
    const bySeverity: Record<string, number> = {};
    for (const drift of detected) bySeverity[drift.severity] = (bySeverity[drift.severity] ?? 0) + 1;

    const result: ReconcileRunResult = {
      reconcile_id: uuidv7(this.now().getTime()),
      platform,
      day: input.day,
      started_at: startedAt,
      finished_at: this.now().toISOString(),
      reader_mode: this.reader.mode,
      snapshot: {
        source: snapshot.source,
        verified: snapshot.verified,
        complete: snapshot.complete,
        orders_complete: snapshot.ordersComplete,
        after_sales_complete: snapshot.afterSalesComplete,
        captured_at: snapshot.capturedAt,
        note: snapshot.note,
      },
      store: this.store.name,
      store_note: this.storeNote,
      checked: {
        local_listings: local.length,
        platform_items: snapshot.items.length,
        listings: { checked: true },
        /** 快照不完整时，不做"本地 published 但平台不存在"的推断。 */
        local_missing_check: snapshot.complete
          ? { checked: true }
          : { checked: false, reason: '平台快照不完整（recorded 样本），跳过平台缺失推断' },
        orders: {
          checked: true,
          local_orders: localOrders.length,
          platform_orders: snapshot.orders.length,
          complete: snapshot.ordersComplete,
          compared_fields: ['presence', 'total_cents', 'paid_cents', 'status', 'refund_status', 'items.qty', 'items.unit_price_cents', 'items.amount_cents'],
        },
        after_sale: {
          checked: true,
          local_after_sales: localAfterSales.length,
          platform_after_sales: snapshot.afterSales.length,
          complete: snapshot.afterSalesComplete,
          compared_fields: ['amount_cents', 'status'],
        },
      },
      summary: {
        total: detected.length,
        by_kind: byKind,
        by_severity: bySeverity,
      },
      persisted,
      diffs: detected,
    };

    if (this.audit) {
      await this.audit.record({
        action: 'reconcile.run',
        actorType: input.actorId ? 'user' : 'system',
        actorId: input.actorId || null,
        requestId: input.requestId,
        resourceType: 'platform',
        resourceId: null,
        before: {},
        after: {
          reconcile_id: result.reconcile_id,
          platform,
          day: input.day,
          reader_mode: result.reader_mode,
          store: result.store,
          total: result.summary.total,
          by_kind: byKind,
          persisted,
        },
        meta: { platform, day: input.day, reader_mode: result.reader_mode, store: result.store },
      });
    }

    return result;
  }

  /** 日报用：按天/平台统计差异（存储在文件或 drift_log）。 */
  async count(day: string, platform?: Platform, kind?: DriftKind): Promise<number> {
    return this.store.count(day, platform, kind);
  }

  async countByKind(day: string, platform?: Platform): Promise<Record<string, number>> {
    return this.store.countByKind(day, platform);
  }

  /** 暴露给测试/验收：读取当天差异（含首次发现时间与 seen_count）。 */
  async list(day: string, platform?: Platform) {
    return this.store.list(day, platform);
  }
}
