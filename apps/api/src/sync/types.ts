/**
 * 同步领域类型 —— docs/12 §3.9、docs/06 §4.5.2 `sync_cursor`。
 *
 * 本轮只做"只读同步的任务骨架"：cursor 推进、租约、失败计数、状态查询；
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

export interface SyncRunResult {
  sync_id: string;
  platform: Platform;
  resource: SyncResource;
  status: 'succeeded';
  dry_run: boolean;
  source: SyncReader['source'];
  started_at: string;
  finished_at: string;
  pages: number;
  stats: { pulled: number };
  /** 续跑起点与最终游标（最终游标写回 `sync_cursor.cursor`）。 */
  resumed_from: string | null;
  cursor: string | null;
  lease_owner: string;
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
