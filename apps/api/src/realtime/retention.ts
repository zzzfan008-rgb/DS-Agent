/**
 * event_log 保留策略（M5 R5）：删除 7 天前事件，每批 ≤5000 避免长事务。
 * 可被 worker/定时任务直接 import 调用；不依赖 Fastify。
 */
import type { PrismaClient } from '@dssaas/db';

export interface PurgeEventLogOptions {
  retentionDays?: number;
  batchSize?: number;
  maxBatches?: number;
  now?: Date;
  logger?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export interface PurgeEventLogResult {
  deleted: number;
  batches: number;
  retentionDays: number;
  cutoff: string;
  durationMs: number;
  truncated: boolean;
}

export async function purgeEventLog(
  prisma: PrismaClient,
  options: PurgeEventLogOptions = {},
): Promise<PurgeEventLogResult> {
  const retentionDays = options.retentionDays ?? 7;
  const batchSize = Math.min(Math.max(options.batchSize ?? 5000, 1), 5000);
  const maxBatches = options.maxBatches ?? 1000;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86400 * 1000);
  const startedAt = Date.now();
  let deleted = 0;
  let batches = 0;
  let truncated = false;

  while (batches < maxBatches) {
    const affected = await prisma.$executeRaw`
      DELETE FROM event_log
      WHERE seq IN (
        SELECT seq FROM event_log
        WHERE created_at < ${cutoff}
        ORDER BY seq ASC
        LIMIT ${batchSize}
      )
    `;
    batches += 1;
    deleted += Number(affected);
    if (Number(affected) < batchSize) break;
  }
  if (batches >= maxBatches) truncated = true;

  const result: PurgeEventLogResult = {
    deleted,
    batches,
    retentionDays,
    cutoff: cutoff.toISOString(),
    durationMs: Date.now() - startedAt,
    truncated,
  };
  options.logger?.info?.(
    {
      job: 'event_log.purge',
      deleted,
      batches,
      retention_days: retentionDays,
      cutoff: result.cutoff,
      duration_ms: result.durationMs,
      truncated,
    },
    'event_log purge finished',
  );
  if (truncated) {
    options.logger?.warn?.({ batches, max_batches: maxBatches }, 'event_log purge hit max batches');
  }
  return result;
}
