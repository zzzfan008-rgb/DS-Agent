/** 回复草稿与发送（B 级），docs/12 §3.8。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getM5Services } from '../services/m5.js';
import { emitRealtime } from '../realtime/hub.js';

const DraftBody = z.object({
  conversation_id: z.string().uuid(),
  intent: z.string().min(1).max(32).optional(),
  tone: z.string().min(1).max(32).optional(),
  fact_refs: z.array(z.string().min(1).max(200)).max(40).optional(),
  deadline_ms: z.number().int().min(50).max(5000).optional(),
});

const SendBody = z.object({
  conversation_id: z.string().uuid(),
  platform: z.enum(['pdd', '1688']),
  text: z.string().min(1).max(5000),
  draft_id: z.string().uuid().optional(),
  approval_id: z.string().uuid().optional(),
  outbound_idempotency_key: z.string().min(8).max(128),
});

export function registerReplyRoutes(app: FastifyInstance): void {
  const { replies, hub } = getM5Services(app);

  app.post('/api/replies/draft', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    const body = DraftBody.parse(request.body ?? {});
    const result = await replies.createReplyDraft(replies, body, context);
    request.auditLogged = true;
    await emitRealtime(app, {
      type: 'draft.updated',
      aggregateId: body.conversation_id,
      payload: {
        draft_id: result.draft_id,
        conversation_id: body.conversation_id,
        degraded: result.degraded,
        degraded_reason: result.degraded_reason,
        latency_ms: result.latency_ms,
      },
    });
    reply.code(201);
    return ok(request, result);
  });

  app.post('/api/replies/send', { config: { minRole: 'operator' } }, async (request) => {
    const context = serviceContext(request);
    const body = SendBody.parse(request.body ?? {});
    const result = await replies.sendReply(replies, body, context);
    request.auditLogged = true;
    if (Object.keys(result.event).length > 0) {
      hub.publish('message.created', result.event);
    }
    return ok(request, result);
  });
}
