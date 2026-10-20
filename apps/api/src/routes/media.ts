/** t39（F-E2E-03）：媒体主链路 HTTP 端点（docs/12 §3.7）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import {
  MEDIA_KINDS,
  MEDIA_PURPOSES,
  generateMediaJob,
  getMediaAsset,
  getMediaJob,
  listMediaAssets,
  listMediaJobs,
  resolveAssetDownload,
  reviewMediaAsset,
} from '../services/media.js';
import { readMediaObject } from '../services/media-storage.js';

const Params = z.object({ id: z.string().uuid() });

const GenerateBody = z.object({
  kind: z.enum(MEDIA_KINDS),
  purpose: z.enum(MEDIA_PURPOSES),
  sku_id: z.string().uuid().optional(),
  reference_asset_id: z.string().uuid().optional(),
  provider_id: z.string().uuid().optional(),
  model_id: z.string().uuid().optional(),
  params: z
    .object({
      prompt: z.string().max(4000).optional(),
      negative_prompt: z.string().max(2000).optional(),
      size: z.string().max(32).optional(),
      seed: z.number().int().optional(),
      count: z.number().int().min(1).max(8).optional(),
      size_chart: z.record(z.string(), z.unknown()).optional(),
      pending_polls: z.number().int().min(0).max(10).optional(),
      duration_seconds: z.number().min(0).max(600).optional(),
    })
    .default({}),
  variant_policy: z.object({ keys: z.array(z.string().min(1).max(64)).max(20) }).optional(),
});

const JobsQuery = z.object({
  status: z.string().max(32).optional(),
  kind: z.string().max(32).optional(),
  sku_id: z.string().uuid().optional(),
  created_by: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const AssetsQuery = z.object({
  kind: z.string().max(32).optional(),
  sku_id: z.string().uuid().optional(),
  status: z.string().max(32).optional(),
  aigc: z.enum(['true', 'false']).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ReviewBody = z.object({
  result: z.enum(['approved', 'rejected']),
  reason_code: z.string().max(64).optional(),
  note: z.string().max(500).optional(),
});

const CancelBody = z.object({ reason: z.string().min(1).max(200).optional() }).optional();
const TERMINAL = new Set(['cancelled', 'failed', 'expired']);

function parseAigc(value: 'true' | 'false' | undefined): boolean | undefined {
  return value === undefined ? undefined : value === 'true';
}

export function registerMediaRoutes(app: FastifyInstance): void {
  // ---- generate：operator；请求内容 sha256 去重（重复提交返回 deduped=true） ----
  app.post('/api/media/generate', { config: { minRole: 'operator' } }, async (request, reply) => {
    const ctx = serviceContext(request);
    const body = GenerateBody.parse(request.body ?? {});
    const result = await generateMediaJob(body, ctx);
    reply.code(result.deduped ? 200 : 201);
    return ok(request, result);
  });

  app.get('/api/media/jobs', { config: { minRole: 'viewer' } }, async (request) => {
    serviceContext(request);
    const query = JobsQuery.parse(request.query ?? {});
    return ok(request, await listMediaJobs(query));
  });

  app.get('/api/media/jobs/:id', { config: { minRole: 'viewer' } }, async (request) => {
    serviceContext(request);
    const { id } = Params.parse(request.params);
    return ok(request, await getMediaJob(id));
  });

  // 取消：非终态 → cancelled；已成功 409；终态重复 200（docs/12 §3.7）
  app.post('/api/media/jobs/:id/cancel', { config: { minRole: 'operator' } }, async (request) => {
    serviceContext(request);
    const { id } = Params.parse(request.params);
    const body = CancelBody.parse(request.body ?? {});
    const prisma = getPrisma();

    const job = await prisma.mediaJob.findUnique({ where: { id } });
    if (!job) throw new ApiError('not_found', '媒体任务不存在');
    if (job.status === 'succeeded') {
      throw new ApiError('conflict', '任务已完成，不能取消；如不再使用请归档资产');
    }
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
    return ok(request, {
      id,
      status: updated.status,
      cancel_noop: false,
      cost_actual_cents: updated.costCents,
    });
  });

  app.get('/api/media/assets', { config: { minRole: 'viewer' } }, async (request) => {
    serviceContext(request);
    const query = AssetsQuery.parse(request.query ?? {});
    return ok(
      request,
      await listMediaAssets({ ...query, aigc: parseAigc(query.aigc) }),
    );
  });

  app.get('/api/media/assets/:id', { config: { minRole: 'viewer' } }, async (request) => {
    serviceContext(request);
    const { id } = Params.parse(request.params);
    return ok(request, await getMediaAsset(id));
  });

  app.get('/api/media/assets/:id/download', { config: { minRole: 'viewer' } }, async (request, reply) => {
    serviceContext(request);
    const { id } = Params.parse(request.params);
    const { variant } = z
      .object({ variant: z.string().min(1).max(64).optional() })
      .parse(request.query ?? {});
    const target = await resolveAssetDownload(id, variant);
    const bytes = await readMediaObject(target.bucket, target.key);
    reply.header('content-type', target.mime);
    reply.header('content-disposition', `attachment; filename="${target.filename}"`);
    reply.header('cache-control', 'private, max-age=60');
    return reply.send(bytes);
  });

  app.post('/api/media/assets/:id/review', { config: { minRole: 'admin' } }, async (request) => {
    const ctx = serviceContext(request);
    const { id } = Params.parse(request.params);
    const body = ReviewBody.parse(request.body ?? {});
    return ok(request, await reviewMediaAsset(id, body, ctx));
  });
}
