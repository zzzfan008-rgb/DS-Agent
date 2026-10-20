/** 1688 询盘报价路由（C 级，docs/12 §3.8）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getM5Services } from '../services/m5.js';
import { sendQuote } from '../services/quotes.js';
import { getWriteGateServices } from '../write-gate/services.js';

const PriceTier = z.object({
  min_qty: z.number().int().min(1).max(1_000_000),
  price_cents: z.number().int().min(1).max(2_000_000_000),
  max_qty: z.number().int().min(1).max(1_000_000).nullable().optional(),
});

const QuoteBody = z.object({
  platform: z.literal('1688'),
  sku_ids: z.array(z.string().uuid()).min(1).max(50),
  price_tiers: z.array(PriceTier).min(1).max(5),
  min_order_qty: z.number().int().min(1).max(1_000_000),
  lead_time_days: z.number().int().min(0).max(365).optional(),
  approval_id: z.string().uuid().optional(),
  outbound_idempotency_key: z.string().min(8).max(128),
  confirm_token: z.string().optional(),
});

const ConfirmBody = z.object({
  approval_id: z.string().uuid(),
  target_hash: z.string().length(64),
});

export function registerInquiryRoutes(app: FastifyInstance): void {
  const { quotes, hub } = getM5Services(app);
  const gate = getWriteGateServices(app);

  app.post('/api/inquiries/:id/quote', { config: { minRole: 'operator' } }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = QuoteBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const result = await sendQuote(
      quotes,
      {
        conversation_id: params.id,
        platform: '1688',
        sku_ids: body.sku_ids,
        price_tiers: body.price_tiers,
        min_order_qty: body.min_order_qty,
        ...(body.lead_time_days === undefined ? {} : { lead_time_days: body.lead_time_days }),
        ...(body.approval_id === undefined ? {} : { approval_id: body.approval_id }),
        outbound_idempotency_key: body.outbound_idempotency_key,
        ...(body.confirm_token === undefined ? {} : { confirm_token: body.confirm_token }),
      },
      context,
    );
    request.auditLogged = true;
    if (Object.keys(result.event).length > 0) {
      if (result.event_seq !== null) {
        hub.publishWithSeq(result.event_seq, 'message.created', result.event);
      } else {
        hub.publish('message.created', result.event);
      }
    }
    reply.code(result.deduped ? 200 : 201);
    return ok(request, result);
  });

  app.post('/api/inquiries/:id/confirm-token', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ConfirmBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const approval = await app.prisma.approval.findFirst({
      where: {
        id: body.approval_id,
        orgId: 1n,
        subjectType: 'quote',
        subjectId: params.id,
        action: 'send_quote',
        platform: '1688',
        operationLevel: 'C',
        status: { in: ['approved', 'approved_with_edit'] },
        targetHash: body.target_hash,
        archivedAt: null,
      },
    });
    if (!approval) throw new ApiError('conflict', '没有匹配的已批准 C 级报价审批');
    if (approval.decidedBy === context.userId) {
      throw new ApiError('forbidden', '四眼原则：执行人不能是审批人');
    }
    const token = gate.confirmTokens.issue({
      approvalId: approval.id,
      userId: context.userId,
      action: 'inquiry.quote',
      targetHash: body.target_hash,
    });
    request.auditLogged = true;
    return ok(request, {
      confirm_token: token.token,
      expires_at: token.expiresAt.toISOString(),
      level: 'C',
      approval_id: approval.id,
      timing_advice: {
        level: 'C',
        timezone: 'Asia/Shanghai',
        note: 'C 级报价不可撤回：提交前核对阶梯价、起批量、交期与有效期；建议在客服在线时段执行。',
      },
    });
  });
}
