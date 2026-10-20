/** 内容草稿路由（docs/12 §3.4）。生成只改措辞，事实来自主数据 facts 信封。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { throwGatewayError } from '../lib/gateway-errors.js';
import {
  createContentDraft,
  getContentDraft,
  listContentDrafts,
  updateContentDraft,
  type ContentDeps,
} from '../services/content.js';

const DraftCreate = z.object({
  content_type: z.enum(['title', 'selling_points', 'detail', 'faq', 'reply', 'quote']),
  product_id: z.string().uuid(),
  platform: z.enum(['pdd', '1688']),
  tone: z.enum(['专业', '亲和', '简洁', '促销', '批发']).optional(),
  constraints: z
    .object({
      length: z.number().int().min(1).max(20000).optional(),
      keywords: z.array(z.string().min(1).max(30)).max(20).optional(),
      forbidden: z.array(z.string().min(1).max(30)).max(20).optional(),
    })
    .optional(),
  fact_refs: z.array(z.string().min(1)).max(40).optional(),
  model_id: z.string().uuid().optional(),
});

const ListQuery = z.object({
  product_id: z.string().uuid().optional(),
  platform: z.enum(['pdd', '1688']).optional(),
  status: z.string().min(1).max(32).optional(),
  created_by: z.string().uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
});

export function registerContentRoutes(app: FastifyInstance): void {
  const deps: ContentDeps = {
    prisma: app.prisma,
    audit: app.audit,
    gateway: app.registry.gateway,
  };

  app.post('/api/content/drafts', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    const body = DraftCreate.parse(request.body ?? {});
    let result;
    try {
      result = await createContentDraft(deps, body, context);
    } catch (error) {
      throwGatewayError(error);
    }
    request.auditLogged = true;
    reply.code(201);
    return ok(request, result);
  });

  app.get('/api/content/drafts', { config: { minRole: 'viewer' } }, async (request) => {
    const query = ListQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const result = await listContentDrafts(deps, {
      ...(query.product_id === undefined ? {} : { product_id: query.product_id }),
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.created_by === undefined ? {} : { created_by: query.created_by }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    return ok(request, { items: result.items }, { next_cursor: result.nextCursor });
  });

  app.put('/api/content/drafts/:id', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        content: z.string().min(1).max(20000).optional(),
        title: z.string().max(200).nullable().optional(),
      })
      .parse(request.body ?? {});
    const context = serviceContext(request);
    const result = await updateContentDraft(deps, params.id, body, context);
    request.auditLogged = true;
    return ok(request, result);
  });

  app.get('/api/content/drafts/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return ok(request, await getContentDraft(deps, params.id));
  });
}
