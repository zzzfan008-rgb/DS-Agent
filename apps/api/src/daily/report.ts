/** 日报组装：指标 + 阈值告警 + 存储来源（文件/drift_log）。 */

import type { PrismaClient } from '@dssaas/db';
import type { DriftStore } from '../reconcile/stores.js';
import type { Platform } from '../reconcile/types.js';
import { collectDailyMetrics } from './metrics.js';
import { evaluateAlerts, type AlertThresholds, type DailyAlert, type DailyMetrics } from './thresholds.js';

export interface BuildDailyReportOptions {
  prisma: PrismaClient;
  driftStore: DriftStore;
  driftStoreNote: string;
  day: string;
  platform: Platform | null;
  thresholds: AlertThresholds | null;
  now?: Date;
}

export interface DailyReport {
  date: string;
  generated_at: string;
  platform: Platform | null;
  metrics: DailyMetrics;
  alerts: DailyAlert[];
  thresholds_configured: boolean;
  drift_store: { name: DriftStore['name']; note: string };
}

export async function buildDailyReport(options: BuildDailyReportOptions): Promise<DailyReport> {
  const now = options.now ?? new Date();
  const metrics = await collectDailyMetrics({
    prisma: options.prisma,
    driftStore: options.driftStore,
    day: options.day,
    platform: options.platform,
    now,
  });
  const alerts = evaluateAlerts(metrics, options.thresholds);
  return {
    date: options.day,
    generated_at: now.toISOString(),
    platform: options.platform,
    metrics,
    alerts,
    thresholds_configured: options.thresholds !== null,
    drift_store: { name: options.driftStore.name, note: options.driftStoreNote },
  };
}
