/**
 * 同步服务 —— 游标推进、租约、失败计数、状态查询（docs/12 §3.9）。
 *
 * t43 起：`orders` 走**真实落库**（`orders` + `order_items`，幂等键 `(platform, platform_order_id)`），
 * 其余 resource 仍只推进游标（等对应表/契约就绪）。目标是把"断点续跑"的机制做对：
 *   getOrCreate → 抢占租约 → 逐页读取 → sink 落库（可选）→ 每页 checkpoint → 完成/失败
 *
 * 失败的语义：保留最后一次成功游标；`consecutive_failures` 累加，≥5 置 `error` 并供告警读取。
 */

import { ApiError } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { Platform } from '../reconcile/types.js';
import type { SyncCursorStore } from './cursor-store.js';
import type {
  SyncCursorRecord,
  SyncResource,
  SyncReader,
  SyncRunResult,
  SyncSink,
  SyncSinkResult,
  SyncStatusItem,
  SyncStatusResult,
} from './types.js';

export interface SyncServiceOptions {
  store: SyncCursorStore;
  readers: Record<SyncResource, SyncReader>;
  /** 可选落库端口：目前只有 orders 提供（`PrismaOrderSink`）。 */
  sinks?: Partial<Record<SyncResource, SyncSink>>;
  now?: () => Date;
  leaseMs?: number;
  maxPages?: number;
}

export interface SyncRunInput {
  since?: string | null;
  cursor?: string | null;
  owner: string;
  maxPages?: number;
}

export class SyncService {
  private readonly store: SyncCursorStore;
  private readonly readers: Record<SyncResource, SyncReader>;
  private readonly sinks: Partial<Record<SyncResource, SyncSink>>;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxPages: number;

  constructor(options: SyncServiceOptions) {
    this.store = options.store;
    this.readers = options.readers;
    this.sinks = options.sinks ?? {};
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.maxPages = options.maxPages ?? 10;
  }

  async run(platform: Platform, resource: SyncResource, input: SyncRunInput): Promise<SyncRunResult> {
    const startedAt = this.now();
    const cursorRow = await this.store.getOrCreate(platform, resource);
    const acquired = await this.store.tryAcquire(cursorRow.id, input.owner, startedAt, this.leaseMs);
    if (!acquired) {
      throw new ApiError('conflict', `平台 ${platform} 的 ${resource} 同步正在运行（或已暂停）`, {
        detail: {
          platform,
          resource,
          lease_owner: cursorRow.leaseOwner,
          lease_until: cursorRow.leaseUntil?.toISOString() ?? null,
          status: cursorRow.status,
        },
      });
    }

    const reader = this.readers[resource];
    if (!reader) throw new ApiError('validation_failed', `未知同步资源：${resource}`);

    const resumedFrom = input.cursor ?? cursorRow.cursor;
    let cursor = resumedFrom;
    let pages = 0;
    let pulled = 0;
    const totals: SyncSinkResult = { created: 0, updated: 0, skipped: 0 };
    let watermarkAt = cursorRow.watermarkAt;
    const maxPages = input.maxPages ?? this.maxPages;
    const sink = this.sinks[resource];

    const statsNow = (): Record<string, number> => ({
      pulled: (cursorRow.stats.pulled ?? 0) + pulled,
      created: (cursorRow.stats.created ?? 0) + totals.created,
      updated: (cursorRow.stats.updated ?? 0) + totals.updated,
      skipped: (cursorRow.stats.skipped ?? 0) + totals.skipped,
    });

    try {
      while (pages < maxPages) {
        const page = await reader.read({
          platform,
          resource,
          cursor,
          since: input.since ?? null,
          pageSize: cursorRow.pageSize,
          pageIndex: pages,
        });
        pages += 1;
        pulled += page.items.length;
        if (page.watermarkAt) watermarkAt = new Date(page.watermarkAt);

        if (sink && page.items.length > 0) {
          const result = await sink.apply(page.items, { platform, now: this.now() });
          totals.created += result.created;
          totals.updated += result.updated;
          totals.skipped += result.skipped;
        }

        if (page.nextCursor !== null && page.nextCursor !== undefined) cursor = page.nextCursor;
        await this.store.checkpoint(
          cursorRow.id,
          { cursor, watermarkAt, stats: statsNow() },
          this.now(),
        );
        if (!page.hasMore) break;
      }

      const finished = await this.store.checkpoint(
        cursorRow.id,
        { cursor, watermarkAt, stats: statsNow() },
        this.now(),
      );

      return {
        sync_id: uuidv7(startedAt.getTime()),
        platform,
        resource,
        status: 'succeeded',
        dry_run: true,
        source: reader.source,
        started_at: startedAt.toISOString(),
        finished_at: this.now().toISOString(),
        pages,
        stats: { pulled, ...totals },
        resumed_from: resumedFrom,
        cursor: finished.cursor,
        lease_owner: input.owner,
      };
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'upstream_5xx';
      await this.store.recordFailure(cursorRow.id, { errorCode: code }, this.now()).catch(() => undefined);
      throw error;
    } finally {
      // 成功/失败路径都已清租约；这里兜底处理"读到一半抛进程异常"之外的路径。
      await this.store.release(cursorRow.id).catch(() => undefined);
    }
  }

  /**
   * 状态查询：`running`（租约未过期）> `failed`（有连续失败）> `idle`。
   * `lag_seconds` 按 `last_success_at` 计算；`stale` = 任一游标超过阈值或从未成功。
   */
  async status(platform: Platform | undefined, staleAfterSeconds: number): Promise<SyncStatusResult> {
    const now = this.now();
    const rows = await this.store.list(platform);
    let stale = false;
    const items: SyncStatusItem[] = rows.map((row: SyncCursorRecord) => {
      const running = row.leaseUntil !== null && row.leaseUntil.getTime() > now.getTime();
      const status: SyncStatusItem['status'] = running ? 'running' : row.consecutiveFailures > 0 || row.status === 'error' ? 'failed' : 'idle';
      const lagSeconds = row.lastSuccessAt ? Math.max(0, Math.round((now.getTime() - row.lastSuccessAt.getTime()) / 1000)) : null;
      if (lagSeconds === null || lagSeconds > staleAfterSeconds) stale = true;
      return {
        platform: row.platform,
        resource: row.resource,
        status,
        last_success_at: row.lastSuccessAt?.toISOString() ?? null,
        cursor: row.cursor,
        lag_seconds: lagSeconds,
        errors:
          row.consecutiveFailures > 0 && row.errorCode
            ? [{ code: row.errorCode, at: row.lastRunAt?.toISOString() ?? null }]
            : [],
      };
    });
    return {
      items,
      stale,
      stale_after_seconds: staleAfterSeconds,
      store: this.store.name,
    };
  }
}
