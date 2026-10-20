/** M6 媒体任务取消（docs/12 §3.7）：非终态 → cancelled；终态重复取消返回 200。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({ reason: z.string().min(1).max(200).optional() }).optional();

const TERMINAL = new Set(['cancelled', 'failed', 'expired']);

export function registerMediaRoutes(app: FastifyInstance): void {
  app.post(
    '/api/media/jobs/:id/cancel',
    { config: { minRole: 'operator' } },
    async (request) => {
      serviceContext(request);
      const { id } = Params.parse(request.params);
      const body = Body.parse(request.body ?? {});
      const prisma = getPrisma();

      const job = await prisma.mediaJob.findUnique({ where: { id } });
      if (!job) throw new ApiError('not_found', '媒体任务不存在');

      // 已成功：文档要求 409（不能用取消回滚已产出资产）
      if (job.status === 'succeeded') {
        throw new ApiError('conflict', '任务已完成，不能取消；如不再使用请归档资产');
      }
      // 终态重复取消：幂等 200
      if (TERMINAL.has(job.status)) {
        return ok(request, {
          id,
          status: job.status,
          cancel_noop: true,
          cost_actual_cents: job.costCents,
        });
      }

      const updated = await prisma.mediaJob.update({
        where: { id },
        data: {
          status: 'cancelled',
          errorCode: body?.reason ? `cancelled:${body.reason}` : 'cancelled_by_user',
          finishedAt: new Date(),
        },
      });

      // 临时对象由 worker 的 media poller 在下一 tick 按 `_tmp/<jobId>/` 前缀清理（幂等）。
      return ok(request, {
        id,
        status: updated.status,
        cancel_noop: false,
        cost_actual_cents: updated.costCents,
      });
    },
  );
}
