/**
 * 对账端点 —— 任务要求 `POST /reconcile/:platform`（admin）。
 *
 * 只读比对 + 幂等落差异；**不自动修正**。同一天重复调用不会新增差异行
 *（存储层 `(day, platform, drift_key)` 唯一，重复只更新 seen_count / last_detected_at）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { isDayString, todayBusinessDay } from '../lib/day.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getReconcileContext } from '../reconcile/context.js';

const PlatformParams = z.object({ platform: z.enum(['pdd', '1688']) });
const ReconcileBody = z
  .object({
    /** 业务日（默认今天，Asia/Shanghai）。 */
    day: z.string().optional(),
    /** 覆盖本次快照来源；缺省用 `RECONCILE_READER`。adapter 模式在契约未核验时会 409。 */
    mode: z.enum(['recorded', 'adapter']).optional(),
  })
  .strict();

export function registerReconcileRoutes(app: FastifyInstance): void {
  app.post('/api/reconcile/:platform', { config: { minRole: 'admin' } }, async (request) => {
    const { platform } = PlatformParams.parse(request.params);
    const body = ReconcileBody.parse(request.body ?? {});
    const day = body.day ?? todayBusinessDay(new Date());
    if (!isDayString(day)) {
      throw new ApiError('validation_failed', `day 必须是 YYYY-MM-DD，收到 ${day}`, {
        detail: { field: 'day', expected: 'YYYY-MM-DD', actual: day },
      });
    }
    const context = serviceContext(request);
    const reconcile = await getReconcileContext(app);
    const service = reconcile.serviceFor(body.mode ?? app.config.reconcileReader);
    const result = await service.run(platform, {
      day,
      requestId: context.requestId,
      actorId: context.userId,
      mode: body.mode ?? app.config.reconcileReader,
    });
    // 服务内已写 `reconcile.run` 审计；置位避免通用钩子重复记一条 api.post。
    request.auditLogged = true;
    return ok(request, result);
  });
}
