/**
 * 1688 询盘报价（C 级，docs/18 §7）。复用 t9 的 approval 四眼 + confirm_token。
 *
 * schema 缺口：message.content_type CHECK 不含 `quote`；报价结构化载荷放 message.attachments，
 * content_type 用 `product_card`，content 存摘要；quote_id = message.id。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { canonicalHash, validatePriceTiers, type PriceTier } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';
import type { ConfirmTokenStore } from '../write-gate/confirm.js';
import type { KillSwitchService } from '../write-gate/kill-switch.js';
import type { PlatformWritePort } from '../write-gate/platform-port.js';

export interface QuoteContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export interface QuoteDeps {
  prisma: PrismaClient;
  audit: AuditService;
  killSwitch: KillSwitchService;
  platform: PlatformWritePort;
  confirmTokens: ConfirmTokenStore;
  now?: () => Date;
}

export interface QuoteInput {
  conversation_id: string;
  platform: '1688';
  sku_ids: string[];
  price_tiers: PriceTier[];
  min_order_qty: number;
  lead_time_days?: number;
  approval_id?: string;
  outbound_idempotency_key: string;
  confirm_token?: string;
  /** 缺省 dry_run：演练不能记为已发送。 */
  delivery_mode?: 'live' | 'dry_run';
}

export interface QuoteResult {
  quote_id: string;
  status: 'sent' | 'queued' | 'sending';
  delivery_mode: 'live' | 'dry_run';
  platform_quote_id: string | null;
  deduped: boolean;
  contract_unverified: boolean;
  quote: Record<string, unknown>;
  event: Record<string, unknown>;
  event_seq: number | null;
}

function quotePayload(input: QuoteInput, quoteNo: string, validUntil: string) {
  return {
    quote_no: quoteNo,
    valid_until: validUntil,
    items: [
      {
        sku_ids: [...new Set(input.sku_ids)].sort(),
        qty_tier: input.price_tiers.map((tier) => ({
          min_qty: tier.min_qty,
          price_cents: tier.price_cents,
          ...(tier.max_qty === null || tier.max_qty === undefined ? {} : { max_qty: tier.max_qty }),
        })),
      },
    ],
    min_order_qty: input.min_order_qty,
    ...(input.lead_time_days === undefined ? {} : { lead_time_days: input.lead_time_days }),
    tax_included: true,
    shipping_payer: 'buyer',
    drop_ship: false,
    note: '报价有效期以 valid_until 为准，具体以双方确认的订单为准。',
  };
}

/** 报价审批绑定对象；与 sendQuote 内部 targetHash 使用同一 canonical 结构。 */
export function quoteTargetPayload(input: {
  conversation_id: string;
  sku_ids: string[];
  price_tiers: PriceTier[];
  min_order_qty: number;
  lead_time_days?: number;
}): Record<string, unknown> {
  return {
    conversation_id: input.conversation_id,
    sku_ids: [...new Set(input.sku_ids)].sort(),
    price_tiers: input.price_tiers,
    min_order_qty: input.min_order_qty,
    lead_time_days: input.lead_time_days ?? null,
  };
}

export async function sendQuote(deps: QuoteDeps, input: QuoteInput, context: QuoteContext): Promise<QuoteResult> {
  const now = deps.now?.() ?? new Date();
  if (input.platform !== '1688') {
    throw new ApiError('validation_failed', '报价只支持 1688', { detail: { field: 'platform' } });
  }
  if (!Array.isArray(input.sku_ids) || input.sku_ids.length === 0) {
    throw new ApiError('validation_failed', 'sku_ids 不能为空', { detail: { field: 'sku_ids' } });
  }
  if (!Number.isInteger(input.min_order_qty) || input.min_order_qty < 1) {
    throw new ApiError('validation_failed', 'min_order_qty 必须是正整数', {
      detail: { field: 'min_order_qty' },
    });
  }
  const tiers = validatePriceTiers(input.price_tiers, input.min_order_qty);
  if (!tiers.ok) {
    throw new ApiError('validation_failed', 'price_tiers 不合法', {
      detail: { issues: tiers.issues },
    });
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.outbound_idempotency_key)) {
    throw new ApiError('validation_failed', 'outbound_idempotency_key 格式非法', {
      detail: { field: 'outbound_idempotency_key' },
    });
  }
  const deliveryMode = input.delivery_mode ?? 'dry_run';
  const conversation = await deps.prisma.conversation.findFirst({
    where: { id: input.conversation_id, orgId: 1n, archivedAt: null },
  });
  if (!conversation) throw new ApiError('not_found', '询盘会话不存在');
  if (conversation.platform !== '1688') {
    throw new ApiError('validation_failed', '报价只支持 1688 会话');
  }

  const existing = await deps.prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      outboundIdempotencyKey: input.outbound_idempotency_key,
      archivedAt: null,
    },
  });
  if (existing) {
    const quote = (existing.attachments as unknown[])[0] ?? {};
    return {
      quote_id: existing.id,
      status:
        existing.status === 'sent' || existing.status === 'queued' ? existing.status : 'sending',
      delivery_mode: existing.deliveryMode === 'dry_run' ? 'dry_run' : 'live',
      platform_quote_id: null,
      deduped: true,
      contract_unverified: true,
      quote: quote as Record<string, unknown>,
      event: {},
      event_seq: null,
    };
  }

  const quoteNo = `Q-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const validUntil = new Date(now.getTime() + 7 * 86400 * 1000).toISOString().slice(0, 10);
  const quote = quotePayload(input, quoteNo, validUntil);
  const targetHash = canonicalHash(
    quoteTargetPayload({
      conversation_id: conversation.id,
      sku_ids: input.sku_ids,
      price_tiers: input.price_tiers,
      min_order_qty: input.min_order_qty,
      ...(input.lead_time_days === undefined ? {} : { lead_time_days: input.lead_time_days }),
    }),
  );

  const approval = input.approval_id
    ? await deps.prisma.approval.findFirst({ where: { id: input.approval_id, archivedAt: null } })
    : null;
  if (!approval) throw new ApiError('approval_required', '报价必须携带 approval_id');
  if (approval.action !== 'send_quote' || approval.platform !== '1688') {
    throw new ApiError('approval_stale', '审批动作/平台与报价不一致');
  }
  if (!['approved', 'approved_with_edit'].includes(approval.status)) {
    throw new ApiError('approval_required', '报价审批尚未通过');
  }
  if (approval.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError('approval_stale', '报价审批已过期');
  }
  if (approval.operationLevel !== 'C') {
    throw new ApiError('approval_stale', '报价必须是 C 级审批');
  }
  if (approval.targetHash !== targetHash) {
    throw new ApiError('approval_stale', '审批 target_hash 与报价内容不一致');
  }
  if (!approval.decidedBy) throw new ApiError('approval_required', '报价审批尚未决策');
  if (approval.decidedBy === approval.createdBy || approval.decidedBy === context.userId) {
    throw new ApiError('forbidden', '四眼原则：执行人不能是审批人');
  }
  if (!input.confirm_token) {
    throw new ApiError('irreversible', 'C 级报价必须二次确认（缺 confirm_token）');
  }
  deps.confirmTokens.consume({
    token: input.confirm_token,
    approvalId: approval.id,
    userId: context.userId,
    action: 'inquiry.quote',
    targetHash,
  });
  await deps.killSwitch.assertNotBlocked({ platform: '1688', taskType: 'message' });

  let message;
  try {
    message = await deps.prisma.message.create({
      data: {
        orgId: 1n,
        conversationId: conversation.id,
        direction: 'outbound',
        platform: '1688',
        senderRole: 'agent',
        contentType: 'quote',
        content: `报价单 ${quoteNo}：${input.sku_ids.length} 个 SKU，起批 ${input.min_order_qty}，有效期至 ${validUntil}`,
        attachments: [quote] as never,
        status: 'sending',
        deliveryMode,
        outboundIdempotencyKey: input.outbound_idempotency_key,
        approvalId: approval.id,
        aiGenerated: false,
        createdBy: context.userId,
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      const raced = await deps.prisma.message.findFirst({
        where: {
          conversationId: conversation.id,
          outboundIdempotencyKey: input.outbound_idempotency_key,
        },
      });
      if (raced) {
        return {
          quote_id: raced.id,
          status: 'sending',
          delivery_mode: raced.deliveryMode === 'dry_run' ? 'dry_run' : 'live',
          platform_quote_id: null,
          deduped: true,
          contract_unverified: true,
          quote,
          event: {},
          event_seq: null,
        };
      }
    }
    throw error;
  }

  try {
    const preview = await deps.platform.preview({
      platform: '1688',
      action: 'inquiry.quote',
      payload: {
        conversation_id: conversation.id,
        quote_no: quoteNo,
        min_order_qty: input.min_order_qty,
        price_tiers: input.price_tiers as unknown as Record<string, unknown>[],
        sku_ids: input.sku_ids,
        approval_id: approval.id,
      } as unknown as Record<string, unknown>,
      requestId: context.requestId,
      idempotencyKey: input.outbound_idempotency_key,
    });
    const live = deliveryMode === 'live';
    const finalStatus = live ? 'sent' : 'queued';
    const rawObjectKey = live ? (preview.raw_object_key ?? null) : null;
    const sentAt = deps.now?.() ?? new Date();
    const updated = await deps.prisma.$transaction(async (tx) => {
      const msg = await tx.message.update({
        where: { id: message!.id },
        data: {
          status: finalStatus,
          deliveryMode,
          ...(live ? { sentAt, platformSentAt: sentAt, rawObjectKey } : {}),
          ...(live && rawObjectKey === null ? { errorCode: 'raw_object_missing' } : {}),
        },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: sentAt } });
      if (live) {
        await tx.approval.update({
          where: { id: approval.id },
          data: { status: 'executed', executedAt: sentAt },
        });
      }
      const eventPayload = {
        conversation_id: conversation.id,
        message_id: msg.id,
        direction: 'outbound',
        status: finalStatus,
        delivery_mode: deliveryMode,
        kind: 'quote',
        platform: '1688',
        contract_unverified: true,
        adapter: preview.adapter,
        t0: sentAt.toISOString(),
      };
      await tx.eventsOutbox.create({
        data: {
          orgId: 1n,
          topic: 'message.created',
          aggregateId: conversation.id,
          payload: eventPayload as Prisma.InputJsonValue,
          createdBy: context.userId,
        },
      });
      const eventLog = await tx.eventLog.create({
        data: {
          topic: 'message.created',
          payload: eventPayload as Prisma.InputJsonValue,
          userId: context.userId,
        },
        select: { seq: true },
      });
      return { msg, eventPayload, eventSeq: Number(eventLog.seq) };
    });
    await deps.audit.record({
      action: 'inquiry.quote',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'message',
      resourceId: updated.msg.id,
      after: {
        conversation_id: conversation.id,
        quote_no: quoteNo,
        status: finalStatus,
        delivery_mode: deliveryMode,
        raw_object_key: rawObjectKey,
        operation_level: 'C',
        approval_id: approval.id,
        contract_unverified: true,
        adapter: preview.adapter,
      },
      irreversible: live,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, approval_id: approval.id, target_hash: targetHash, delivery_mode: deliveryMode },
    });
    return {
      quote_id: updated.msg.id,
      status: finalStatus,
      delivery_mode: deliveryMode,
      platform_quote_id: null,
      deduped: false,
      contract_unverified: true,
      quote,
      event: updated.eventPayload,
      event_seq: updated.eventSeq,
    };
  } catch (error) {
    await deps.prisma.message.update({
      where: { id: message.id },
      data: { status: 'failed', errorCode: (error as { code?: string }).code ?? 'adapter_error' },
    });
    throw error;
  }
}
