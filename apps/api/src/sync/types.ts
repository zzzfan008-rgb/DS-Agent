/**
 * 同步领域类型 —— docs/12 §3.9、docs/06 §4.5.2 `sync_cursor`。
 *
 * 骨架能力：cursor 推进、租约、失败计数、状态查询；
 * t43 起 `orders` 有真实 sink（写 `orders` + `order_items`），t49 起 `after_sale` 也有真实 sink。
 * 真实平台 reader 依赖 adapter 契约（未核验 → 硬拒绝），录制 reader 用于验证续跑语义。
 */

import type { Platform } from '../reconcile/types.js';

export const SYNC_RESOURCES = ['products', 'orders', 'messages', 'after_sale', 'stock'] as const;
export type SyncResource = (typeof SYNC_RESOURCES)[number];

export interface SyncCursorRecord {
  id: string;
  platform: Platform;
  shopId: string;
  resource: SyncResource;
  cursor: string | null;
  watermarkAt: Date | null;
  pageSize: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  consecutiveFailures: number;
  status: 'active' | 'paused' | 'error';
  leaseOwner: string | null;
  leaseUntil: Date | null;
  errorCode: string | null;
  stats: Record<string, number>;
}

export interface SyncReadInput {
  platform: Platform;
  resource: SyncResource;
  /** 从哪个游标继续（`null` = 从头）。 */
  cursor: string | null;
  /** 增量起点（ISO），由调用方给出；录制 reader 只回显不解释。 */
  since: string | null;
  pageSize: number;
  pageIndex: number;
}

export interface SyncPage {
  items: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
  /** 本页消费到的平台水位（ISO）；用于 `sync_cursor.watermark_at`。 */
  watermarkAt: string | null;
}

export interface SyncReader {
  readonly source: 'recorded' | 'adapter';
  read(input: SyncReadInput): Promise<SyncPage>;
}

/**
 * 同步落库端口（`orders` / `after_sale` 真实落库；其他资源的 reader 暂时只推进游标）。
 *
 * `pending` 用于"拿到数据但当前无法落库"的情形（如 `after_sale.order_id` 是 NOT NULL + FK RESTRICT，
 * 本地缺订单时无法写入）。这类数据**不静默丢弃**：计入 `pending` 并给原因，
 * 对账侧的 `after_sale_platform_only` 仍会把它报出来（风险保持可见）。
 */
export interface SyncSinkResult {
  created: number;
  updated: number;
  skipped: number;
  /** 未能落库但已识别的条数（可选；不填视为 0）。 */
  pending?: number;
  /** pending 原因分布，如 `{ order_missing: 2 }`。 */
  pending_reasons?: Record<string, number>;
}

export interface SyncSinkContext {
  platform: Platform;
  now: Date;
}

export interface SyncSink {
  apply(items: readonly unknown[], context: SyncSinkContext): Promise<SyncSinkResult>;
}

export interface SyncRunStats extends SyncSinkResult {
  pulled: number;
}

export interface SyncRunResult {
  sync_id: string;
  platform: Platform;
  resource: SyncResource;
  status: 'succeeded';
  /** `true` = 只推进游标（未写业务表）；`false` = 已真实落库（orders/order_items、after_sale）。 */
  dry_run: boolean;
  source: SyncReader['source'];
  started_at: string;
  finished_at: string;
  pages: number;
  stats: SyncRunStats;
  /** 续跑起点与最终游标（最终游标写回 `sync_cursor.cursor`）。 */
  resumed_from: string | null;
  cursor: string | null;
  lease_owner: string;
  /**
   * t50：`orders` 同步后自动重放 `after_sale` pending 关联的结果。
   *
   * 只有 `resource='orders'` 且本次真的写入了新订单时才出现。
   * 重放失败不回滚本次同步，而是返回 `{error}`（订单已经落库成功，不能因为重放异常误报失败）。
   */
  after_sale_retry?: {
    created: number;
    updated: number;
    skipped: number;
    pending: number;
    /** 超过 `AFTER_SALE_RETRY_MAX_ITEMS` 时降级为增量，这里为 true。 */
    degraded?: boolean;
    error?: string;
  };
}

export interface SyncStatusItem {
  platform: Platform;
  resource: SyncResource;
  status: 'idle' | 'running' | 'failed';
  last_success_at: string | null;
  cursor: string | null;
  lag_seconds: number | null;
  errors: Array<{ code: string; at: string | null }>;
}

export interface SyncStatusResult {
  items: SyncStatusItem[];
  stale: boolean;
  stale_after_seconds: number;
  store: 'postgres' | 'memory';
}
