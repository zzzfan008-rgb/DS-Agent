/** 日报组装：指标 + 阈值告警 + 存储来源（文件/drift_log）+ 关键差异告警配置状态（t49）。 */

import type { PrismaClient } from '@dssaas/db';
import type { DriftStore } from '../reconcile/stores.js';
import type { Platform } from '../reconcile/types.js';
import { collectDailyMetrics } from './metrics.js';
import {
  criticalThresholdStatus,
  evaluateAlerts,
  type AlertThresholds,
  type CriticalThresholdStatus,
  type DailyAlert,
  type DailyMetrics,
} from './thresholds.js';

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
  /**
   * 关键差异类型的告警配置状态（t49）。
   *
   * 不配置不算错（与"未配置阈值只报事实"一致），但必须**显式可见** ——
   * 否则 `after_sale_platform_only` 出现时没人知道告警根本没配。
   */
  critical_thresholds: CriticalThresholdStatus[];
  /** 有未配置的关键类型时为 true，日报据此打 warning。 */
  critical_thresholds_missing: boolean;
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
  const critical = criticalThresholdStatus(options.thresholds);
  return {
    date: options.day,
    generated_at: now.toISOString(),
    platform: options.platform,
    metrics,
    alerts,
    thresholds_configured: options.thresholds !== null,
    drift_store: { name: options.driftStore.name, note: options.driftStoreNote },
    critical_thresholds: critical,
    critical_thresholds_missing: critical.some((item) => !item.configured),
  };
}
