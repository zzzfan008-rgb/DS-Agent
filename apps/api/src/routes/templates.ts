/** 话术模板库（docs/12 §3.8）：GET 所有登录角色，POST/PATCH 仅 admin。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getM5Services } from '../services/m5.js';
import { createTemplate, listTemplates, patchTemplate } from '../services/templates.js';

const ListQuery = z.object({
  platform: z.enum(['pdd', '1688']).optional(),
  intent: z.string().min(1).max(32).optional(),
  q: z.string().min(1).max(100).optional(),
  limit: z.string().optional(),
});

const CreateBody = z.object({
  name: z.string().min(1).max(60).optional(),
  category: z.string().min(1).max(32).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  intent: z.string().min(2).max(32),
  text: z.string().min(1).max(2000),
  platform: z.enum(['pdd', '1688']).optional(),
  weight: z.number().int().min(0).max(1000).optional(),
});

const PatchBody = z.object({
  name: z.string().min(1).max(60).optional(),
  category: z.string().min(1).max(32).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  text: z.string().min(1).max(2000).optional(),
  intent: z.string().min(2).max(32).optional(),
  status: z.enum(['draft', 'approved', 'retired']).optional(),
  weight: z.number().int().min(0).max(1000).optional(),
});

export function registerTemplateRoutes(app: FastifyInstance): void {
  const { conversations } = getM5Services(app);
  const deps = { prisma: conversations.prisma, audit: conversations.audit };

  app.get('/api/reply-templates', { config: { minRole: 'viewer' } }, async (request) => {
    const query = ListQuery.parse(request.query ?? {});
    const result = await listTemplates(deps.prisma, {
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.intent === undefined ? {} : { intent: query.intent }),
      ...(query.q === undefined ? {} : { q: query.q }),
      limit: parseLimit(query.limit, 50, 200),
    });
    return ok(request, result);
  });

  app.post('/api/reply-templates', { config: { minRole: 'admin' } }, async (request, reply) => {
    const body = CreateBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const template = await createTemplate(deps, body, context);
    request.auditLogged = true;
    reply.code(201);
    return ok(request, template);
  });

  app.patch('/api/reply-templates/:id', { config: { minRole: 'admin' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = PatchBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const template = await patchTemplate(deps, params.id, body, context);
    request.auditLogged = true;
    return ok(request, template);
  });
}
