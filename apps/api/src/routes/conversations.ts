/** 会话/消息路由（docs/12 §3.8）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import {
  getConversation,
  getM5Services,
  listConversations,
  markConversationRead,
  simulateInbound,
  unreadSnapshot,
} from '../services/m5.js';

const ListQuery = z.object({
  platform: z.enum(['pdd', '1688']).optional(),
  status: z.enum(['open', 'pending', 'closed', 'archived']).optional(),
  unread: z.enum(['0', '1']).optional(),
  assignee: z.enum(['me']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
});

const DetailQuery = z.object({
  messages_after: z.string().uuid().optional(),
  limit: z.string().optional(),
});

const SimulateInbound = z.object({
  platform: z.enum(['pdd', '1688']),
  platform_conversation_id: z.string().min(1).max(128),
  buyer_ref: z.string().min(1).max(64).optional(),
  buyer_nick: z.string().min(1).max(60).optional(),
  kind: z.enum(['pre_sale', 'after_sale', 'logistics', 'inquiry', 'quote', 'complaint']).optional(),
  related_product_id: z.string().uuid().optional(),
  content: z.string().min(1).max(5000),
  platform_message_id: z.string().min(1).max(128).optional(),
  sent_at: z.string().optional(),
});

export function registerConversationRoutes(app: FastifyInstance): void {
  const { conversations, hub } = getM5Services(app);

  app.get('/api/conversations', { config: { minRole: 'viewer' } }, async (request) => {
    const query = ListQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const context = serviceContext(request);
    const result = await listConversations(conversations, {
      ...(query.platform === undefined ? {} : { platform: query.platform }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.unread === '1' ? { unread: true } : {}),
      ...(query.assignee === 'me' ? { assignee: 'me' as const, userId: context.userId } : {}),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    return ok(request, { items: result.items }, { next_cursor: result.nextCursor });
  });

  app.get('/api/conversations/unread-snapshot', { config: { minRole: 'viewer' } }, async (request) => {
    const context = serviceContext(request);
    return ok(request, await unreadSnapshot(conversations, context.userId, hub.currentSeq));
  });

  app.get('/api/conversations/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = DetailQuery.parse(request.query ?? {});
    return ok(
      request,
      await getConversation(conversations, params.id, {
        ...(query.messages_after === undefined ? {} : { messages_after: query.messages_after }),
        limit: parseLimit(query.limit, 100, 200),
      }),
    );
  });

  app.post('/api/conversations/:id/read', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = serviceContext(request);
    const result = await markConversationRead(conversations, params.id, context);
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post(
    '/api/internal/conversations/simulate-inbound',
    { config: { minRole: 'admin' } },
    async (request, reply) => {
      if (!app.config.enableInternalSimulation || app.config.nodeEnv === 'production') {
        throw new ApiError('not_found', 'not found');
      }
      const body = SimulateInbound.parse(request.body ?? {});
      const context = serviceContext(request);
      const result = await simulateInbound(conversations, body, context);
      if (!result.deduped && result.event_seq !== null) {
        hub.publishWithSeq(result.event_seq, 'message.created', result.event);
      }
      request.auditLogged = true;
      reply.code(result.deduped ? 200 : 201);
      return ok(request, result);
    },
  );
}
