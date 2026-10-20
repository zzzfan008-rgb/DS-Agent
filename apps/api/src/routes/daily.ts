/**
 * 日报端点 —— 任务要求 `GET /dashboard/daily?date=`（docs/12 §3.11 治理域）。
 *
 * 只读：上架数、驳回数、待审批积压、消息量、媒体成本、对账差异数；
 * 告警只按配置阈值计算并随响应返回，不在此处落库（落库由每日脚本负责，便于 cron 单点）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { isDayString, todayBusinessDay } from '../lib/day.js';
import { ok } from '../lib/response.js';
import { getReconcileContext } from '../reconcile/context.js';
import { buildDailyReport } from '../daily/report.js';

const DailyQuery = z.object({
  date: z.string().optional(),
  platform: z.enum(['pdd', '1688']).optional(),
});

export function registerDailyRoutes(app: FastifyInstance): void {
  app.get('/api/dashboard/daily', { config: { minRole: 'viewer' } }, async (request) => {
    const query = DailyQuery.parse(request.query ?? {});
    const day = query.date ?? todayBusinessDay(new Date());
    if (!isDayString(day)) {
      throw new ApiError('validation_failed', `date 必须是 YYYY-MM-DD，收到 ${day}`, {
        detail: { field: 'date', expected: 'YYYY-MM-DD', actual: day },
      });
    }
    const reconcile = await getReconcileContext(app);
    const report = await buildDailyReport({
      prisma: app.prisma,
      driftStore: reconcile.store,
      driftStoreNote: reconcile.note,
      day,
      platform: query.platform ?? null,
      thresholds: app.config.dailyAlertThresholds,
    });
    return ok(request, report);
  });
}
