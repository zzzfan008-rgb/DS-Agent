/** 判断层路由（docs/12 §3.4、docs/08）：POST /judgments、GET /judgments/:id、申诉。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import type { FactEnvelope } from '@dssaas/core';
import {
  appealJudgment,
  createJudgment,
  getJudgment,
  reviewAppeal,
  type JudgmentDeps,
} from '../services/judgments.js';

const PLATFORMS = ['pdd', '1688'] as const;
const CONTENT_TYPES = ['title', 'selling_points', 'detail', 'faq', 'reply', 'quote'] as const;

const JudgmentCreate = z.object({
  subject_type: z.enum(['content_draft', 'message', 'media_asset', 'listing', 'quote', 'kb_answer']),
  subject_id: z.string().uuid(),
  platform: z.enum(PLATFORMS),
  content_type: z.enum(CONTENT_TYPES),
  text: z.string().min(1).max(20000).optional(),
  facts: z.record(z.string(), z.unknown()).optional(),
  run: z.enum(['L1', 'L2', 'L1+L2']).optional(),
});

const AppealBody = z.object({ reason: z.string().min(10).max(2000) });
const ReviewBody = z.object({
  decision: z.enum(['upheld', 'overridden']),
  final_verdict: z.enum(['pass', 'needs_revision', 'reject', 'escalate']).optional(),
  note: z.string().min(1).max(2000),
});

export function registerJudgmentRoutes(app: FastifyInstance): void {
  const deps: JudgmentDeps = {
    prisma: app.prisma,
    audit: app.audit,
    gateway: app.registry.gateway,
  };

  app.post('/api/judgments', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    const body = JudgmentCreate.parse(request.body ?? {});
    const result = await createJudgment(
      deps,
      {
        subject_type: body.subject_type,
        subject_id: body.subject_id,
        platform: body.platform,
        content_type: body.content_type,
        ...(body.text === undefined ? {} : { text: body.text }),
        ...(body.facts === undefined
          ? {}
          : { facts: body.facts as unknown as FactEnvelope }),
        ...(body.run === undefined ? {} : { run: body.run }),
      },
      context,
    );
    request.auditLogged = true;
    reply.code(201);
    return ok(request, result);
  });

  app.get('/api/judgments/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return ok(request, await getJudgment(deps, params.id));
  });

  app.post('/api/judgments/:id/appeal', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = AppealBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const result = await appealJudgment(deps, params.id, body.reason, context);
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post(
    '/api/judgments/:id/appeal-review',
    { config: { minRole: 'admin' } },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ReviewBody.parse(request.body ?? {});
      const context = serviceContext(request);
      const result = await reviewAppeal(deps, params.id, body, context);
      request.auditLogged = true;
      return ok(request, result);
    },
  );
}
