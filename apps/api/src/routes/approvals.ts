/** 审批路由（docs/12 §3.5）：创建（扩展）/列表/详情/决策。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getWriteGateServices } from '../write-gate/services.js';

const ApprovalCreate = z.object({
  subject_type: z.enum([
    'content_draft',
    'listing',
    'message',
    'quote',
    'media_asset',
    'price_change',
    'batch_action',
  ]),
  subject_id: z.string().uuid(),
  action: z.enum([
    'publish',
    'update_price',
    'update_stock',
    'replace_main_image',
    'change_category',
    'send_reply',
    'send_quote',
    'upload_video',
    'batch_offline',
  ]),
  platform: z.enum(['pdd', '1688']),
  target_payload: z.record(z.string(), z.unknown()),
  fact_snapshot: z.record(z.string(), z.unknown()).optional(),
  risk_meta: z.record(z.string(), z.unknown()).optional(),
  diff: z.record(z.string(), z.unknown()).optional(),
  context: z
    .object({
      listingStatus: z.string().nullable().optional(),
      activityHit: z.boolean().optional(),
      touchesMainImage: z.boolean().optional(),
      touchesCategoryOrKeyAttr: z.boolean().optional(),
      priceDeltaRatio: z.number().min(0).max(100).optional(),
      affectedSkus: z.number().int().min(0).max(100000).optional(),
      irreversibleFields: z.array(z.string()).optional(),
      firstPublish: z.boolean().optional(),
      notOnline: z.boolean().optional(),
    })
    .optional(),
  scheduled_at: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
});

const ApprovalListQuery = z.object({
  status: z.string().min(1).optional(),
  level: z.enum(['A', 'B', 'C']).optional(),
  platform: z.enum(['pdd', '1688']).optional(),
  action: z.string().min(1).optional(),
  overdue: z.enum(['0', '1']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
});

const Decide = z.object({
  decision: z.enum(['approve', 'approve_with_edit', 'reject', 'schedule']),
  comment: z.string().max(2000).optional(),
  scheduled_at: z.string().nullable().optional(),
  confirm_token: z.string().optional(),
});

export function registerApprovalRoutes(app: FastifyInstance): void {
  const { approvals } = getWriteGateServices(app);

  app.post('/api/approvals', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    const body = ApprovalCreate.parse(request.body ?? {});
    const row = await approvals.create(body, context);
    request.auditLogged = true;
    reply.code(201);
    return ok(request, {
      id: row.id,
      status: row.status,
      level: row.operationLevel,
      target_hash: row.targetHash,
      sla_due_at: row.slaDueAt?.toISOString() ?? null,
      expires_at: row.expiresAt.toISOString(),
      level_reasons: row.levelReasons,
    });
  });

  app.get('/api/approvals', { config: { minRole: 'viewer' } }, async (request) => {
    const query = ApprovalListQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const result = await approvals.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.level === undefined ? {} : { level: query.level }),
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.overdue === '1' ? { overdue: true } : {}),
      limit,
    });
    return ok(request, { items: result.items }, { next_cursor: result.nextCursor });
  });

  app.get('/api/approvals/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return ok(request, await approvals.get(params.id));
  });

  app.post('/api/approvals/:id/decide', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = Decide.parse(request.body ?? {});
    const context = serviceContext(request);
    const row = await approvals.decide(params.id, body, context);
    request.auditLogged = true;
    return ok(request, {
      id: row.id,
      status: row.status,
      decision: row.decision,
      decided_at: row.decidedAt?.toISOString() ?? null,
    });
  });
}
