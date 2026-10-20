/**
 * 告警落库 —— 阈值触发时写 `event_log`（topic=`reconcile.alert`）。
 *
 * 为什么不是 `compensating_ticket`：工单是人工处置对象，自动批量开单会污染待办；
 * docs/20 §7 要求"对账漂移开补偿工单"——本轮只做**告警记录**（机制验证），
 * 工单创建留给后续人工/自动化策略（验收文档 §7 列为未做项）。
 *
 * 幂等：同一业务日 + 平台 + 指标只写一条（按 event_log 当日已有 payload 去重）。
 */

import type { PrismaClient } from '@dssaas/db';
import type { Prisma } from '@dssaas/db';
import { dayEndUtc, dayStartUtc } from '../lib/day.js';
import type { Platform } from '../reconcile/types.js';
import type { DailyAlert } from './thresholds.js';

export const ALERT_TOPIC = 'reconcile.alert';

export interface PersistAlertsInput {
  prisma: PrismaClient;
  day: string;
  platform: Platform | null;
  alerts: readonly DailyAlert[];
  now?: Date;
  orgId?: bigint;
}

export interface PersistAlertsResult {
  inserted: number;
  skipped: number;
}

interface AlertPayload {
  day: string;
  platform: Platform | null;
  metric: string;
  level: string;
  value: number;
  threshold: number;
  message: string;
}

function keyOf(payload: Record<string, unknown>): string {
  return `${String(payload.day)}|${payload.platform === null || payload.platform === undefined ? '*' : String(payload.platform)}|${String(payload.metric)}`;
}

export async function persistAlerts(input: PersistAlertsInput): Promise<PersistAlertsResult> {
  if (input.alerts.length === 0) return { inserted: 0, skipped: 0 };
  const from = dayStartUtc(input.day);
  const to = dayEndUtc(input.day);
  const existing = await input.prisma.eventLog.findMany({
    where: { topic: ALERT_TOPIC, createdAt: { gte: from, lt: to } },
    select: { payload: true },
  });
  const seen = new Set(
    existing
      .map((row) => (typeof row.payload === 'object' && row.payload !== null ? (row.payload as Record<string, unknown>) : null))
      .filter((payload): payload is Record<string, unknown> => payload !== null)
      .map(keyOf),
  );

  let inserted = 0;
  let skipped = 0;
  for (const alert of input.alerts) {
    const payload: AlertPayload = {
      day: input.day,
      platform: input.platform,
      metric: alert.metric,
      level: alert.level,
      value: alert.value,
      threshold: alert.threshold,
      message: alert.message,
    };
    if (seen.has(keyOf(payload as unknown as Record<string, unknown>))) {
      skipped += 1;
      continue;
    }
    await input.prisma.eventLog.create({
      data: {
        topic: ALERT_TOPIC,
        payload: payload as unknown as Prisma.InputJsonValue,
        userId: null,
      },
    });
    seen.add(keyOf(payload as unknown as Record<string, unknown>));
    inserted += 1;
  }
  return { inserted, skipped };
}

/** 读取当日告警（验收脚本/测试断言用）。 */
export async function listAlerts(
  prisma: PrismaClient,
  day: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.eventLog.findMany({
    where: { topic: ALERT_TOPIC, createdAt: { gte: dayStartUtc(day), lt: dayEndUtc(day) } },
    orderBy: { seq: 'asc' },
    select: { payload: true },
  });
  return rows.map((row) => (typeof row.payload === 'object' && row.payload !== null ? (row.payload as Record<string, unknown>) : {}));
}
