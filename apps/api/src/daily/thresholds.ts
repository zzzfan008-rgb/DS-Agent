/**
 * 日报告警阈值 —— docs/16 §0 结论 5「告警必须带阈值来源」+ 任务要求「阈值配置化，不写死数字」。
 *
 * 规则：
 * - 阈值来自环境变量 `DAILY_ALERT_THRESHOLDS`（JSON）；不配置时**不告警**，日报只报事实；
 * - 非法配置在启动/脚本入口即失败（zod strict，拼错键名不会被静默忽略）；
 * - 本模块不内置任何默认数字；级别（P2/P3）是策略常量，不是阈值。
 */

import { z } from 'zod';

const nonNegativeInt = z.number().int().min(0);

export const ALERT_THRESHOLD_SCHEMA = z
  .object({
    drift_total: nonNegativeInt.optional(),
    drift_by_kind: z.record(z.string(), nonNegativeInt).optional(),
    approvals_pending: nonNegativeInt.optional(),
    rejected_listings: nonNegativeInt.optional(),
    messages: nonNegativeInt.optional(),
    media_cost_cents: nonNegativeInt.optional(),
  })
  .strict();

export type AlertThresholds = z.infer<typeof ALERT_THRESHOLD_SCHEMA>;

export const THRESHOLD_KEYS = [
  'drift_total',
  'drift_by_kind',
  'approvals_pending',
  'rejected_listings',
  'messages',
  'media_cost_cents',
] as const;

export interface ParsedThresholds {
  thresholds: AlertThresholds | null;
  issues: string[];
}

/** 解析环境变量；空值 = 未配置（返回 null，不告警）。 */
export function parseAlertThresholds(raw: string | null | undefined): ParsedThresholds {
  if (raw === undefined || raw === null || raw.trim() === '') return { thresholds: null, issues: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { thresholds: null, issues: [`DAILY_ALERT_THRESHOLDS 不是合法 JSON：${(error as Error).message}`] };
  }
  const parsed = ALERT_THRESHOLD_SCHEMA.safeParse(json);
  if (!parsed.success) {
    return {
      thresholds: null,
      issues: parsed.error.issues.map((issue) => `DAILY_ALERT_THRESHOLDS.${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  return { thresholds: parsed.data, issues: [] };
}

export interface DailyMetrics {
  date: string;
  platform: 'pdd' | '1688' | null;
  listed: number;
  rejected: number;
  approvals_pending: number;
  approvals_oldest_minutes: number | null;
  messages: number;
  media_cost_cents: number;
  /** 媒体成本无平台维度（cost_ledger 无 platform 列），平台筛选时为 global。 */
  media_cost_scope: 'global';
  drift_total: number;
  drift_by_kind: Record<string, number>;
}

export interface DailyAlert {
  /** 触发指标（与阈值键一致；drift_by_kind 用 `drift_by_kind.<kind>`）。 */
  metric: string;
  level: 'P2' | 'P3';
  value: number;
  threshold: number;
  message: string;
}

const LEVEL_BY_METRIC: Record<string, 'P2' | 'P3'> = {
  drift_total: 'P2',
  approvals_pending: 'P2',
  rejected_listings: 'P2',
  messages: 'P3',
  media_cost_cents: 'P3',
};

function levelOf(metric: string): 'P2' | 'P3' {
  return LEVEL_BY_METRIC[metric] ?? 'P2';
}

/**
 * 评估告警：`value > threshold` 触发（严格大于；等于阈值不告警，避免边界噪声）。
 * 无阈值配置 → 空数组（只报事实）。
 */
export function evaluateAlerts(metrics: DailyMetrics, thresholds: AlertThresholds | null): DailyAlert[] {
  if (!thresholds) return [];
  const alerts: DailyAlert[] = [];
  const check = (metric: string, value: number, threshold: number | undefined, message: string): void => {
    if (threshold === undefined) return;
    if (value <= threshold) return;
    alerts.push({ metric, level: levelOf(metric), value, threshold, message });
  };

  check('drift_total', metrics.drift_total, thresholds.drift_total, `对账差异 ${metrics.drift_total} 条，超过阈值 ${thresholds.drift_total}`);
  for (const [kind, threshold] of Object.entries(thresholds.drift_by_kind ?? {})) {
    const value = metrics.drift_by_kind[kind] ?? 0;
    check(`drift_by_kind.${kind}`, value, threshold, `对账差异类型 ${kind} 有 ${value} 条，超过阈值 ${threshold}`);
  }
  check('approvals_pending', metrics.approvals_pending, thresholds.approvals_pending, `待审批积压 ${metrics.approvals_pending} 条，超过阈值 ${thresholds.approvals_pending}`);
  check('rejected_listings', metrics.rejected, thresholds.rejected_listings, `当日驳回 ${metrics.rejected} 条，超过阈值 ${thresholds.rejected_listings}`);
  check('messages', metrics.messages, thresholds.messages, `当日消息 ${metrics.messages} 条，超过阈值 ${thresholds.messages}`);
  check('media_cost_cents', metrics.media_cost_cents, thresholds.media_cost_cents, `当日媒体成本 ${metrics.media_cost_cents} 分，超过阈值 ${thresholds.media_cost_cents}`);

  return alerts.sort((a, b) => a.metric.localeCompare(b.metric));
}
