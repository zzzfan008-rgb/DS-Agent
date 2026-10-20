/**
 * 日报指标采集 —— docs/12 §3.11 `GET /dashboard/*`、docs/16 §5 日常巡检。
 *
 * 口径（全部按 `Asia/Shanghai` 业务日，见 lib/day.ts）：
 * - `listed`：当日 `listing.published_at` 落点的上架数（平台可选过滤）；
 * - `rejected`：当日 `updated_at` 且 `status='rejected'` 的 listing 数；
 * - `approvals_pending`：当前 `status='pending'` 的审批数（积压是"现在"，不是"当日"）；
 * - `messages`：当日新建 message 数；
 * - `media_cost_cents`：当日 `cost_ledger` 中 `kind='media'` 的金额合计（无平台列 → global）；
 * - `drift_total` / `drift_by_kind`：来自对账存储（文件或 drift_log）。
 */

import type { PrismaClient } from '@dssaas/db';
import { dayEndUtc, dayStartUtc } from '../lib/day.js';
import type { DriftStore } from '../reconcile/stores.js';
import type { Platform } from '../reconcile/types.js';
import type { DailyMetrics } from './thresholds.js';

export interface CollectMetricsOptions {
  prisma: PrismaClient;
  driftStore: DriftStore;
  day: string;
  platform: Platform | null;
  now?: Date;
  orgId?: bigint;
}

export async function collectDailyMetrics(options: CollectMetricsOptions): Promise<DailyMetrics> {
  const { prisma, driftStore, day, platform } = options;
  const orgId = options.orgId ?? 1n;
  const now = options.now ?? new Date();
  const from = dayStartUtc(day);
  const to = dayEndUtc(day);
  const platformFilter = platform ? { platform } : {};

  const [listed, rejected, approvalsPending, oldestPending, messages, mediaCost] = await Promise.all([
    prisma.listing.count({
      where: { orgId, archivedAt: null, publishedAt: { gte: from, lt: to }, ...platformFilter },
    }),
    prisma.listing.count({
      where: { orgId, archivedAt: null, status: 'rejected', updatedAt: { gte: from, lt: to }, ...platformFilter },
    }),
    prisma.approval.count({
      where: { orgId, archivedAt: null, status: 'pending', ...platformFilter },
    }),
    prisma.approval.findFirst({
      where: { orgId, archivedAt: null, status: 'pending', ...platformFilter },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.message.count({
      where: { orgId, archivedAt: null, createdAt: { gte: from, lt: to }, ...platformFilter },
    }),
    prisma.costLedger.aggregate({
      where: {
        orgId,
        archivedAt: null,
        kind: 'media',
        refType: 'media_job',
        occurredAt: { gte: from, lt: to },
      },
      _sum: { amountCents: true },
    }),
  ]);

  const driftTotal = await driftStore.count(day, platform ?? undefined);
  const driftByKind = await driftStore.countByKind(day, platform ?? undefined);

  return {
    date: day,
    platform,
    listed,
    rejected,
    approvals_pending: approvalsPending,
    approvals_oldest_minutes: oldestPending
      ? Math.max(0, Math.round((now.getTime() - oldestPending.createdAt.getTime()) / 60_000))
      : null,
    messages,
    media_cost_cents: mediaCost._sum.amountCents ?? 0,
    media_cost_scope: 'global',
    drift_total: driftTotal,
    drift_by_kind: driftByKind,
  };
}
