/**
 * 会话与入站消息（docs/18 §1）。
 *
 * 落库事务：message 插入 + conversation.unread_count 原子 +1 + events_outbox 同事务；
 * 提交后由路由推 SSE。唯一键使用 DB 的 `(conversation_id, platform_message_id)`（t19 迁移），
 * 因此跨会话同 platform_message_id 不冲突。
 *
 * schema 缺口：message 无 platform/sender_role/read_at/event_seq/platform_sent_at；
 * 平台取 conversation.platform，已读只维护 conversation.unread_count；SSE id 用进程内 seq。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';
import { selectFallbackTemplates } from './templates.js';

export interface ConversationDeps {
  prisma: PrismaClient;
  audit: AuditService;
}

export interface ServiceContext {
  requestId: string;
  userId: string;
  role: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SimulateInboundInput {
  platform: 'pdd' | '1688';
  platform_conversation_id: string;
  buyer_ref?: string;
  buyer_nick?: string;
  kind?: 'pre_sale' | 'after_sale' | 'logistics' | 'inquiry' | 'quote' | 'complaint';
  related_product_id?: string;
  content: string;
  platform_message_id?: string;
  sent_at?: string;
}

function hashRef(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inferIntent(text: string): string {
  if (/尺码|身高|体重|码数|size/i.test(text)) return 'size';
  if (/物流|快递|发货|到货/.test(text)) return 'logistics';
  if (/退|换货|退款|售后/.test(text)) return 'returns';
  if (/报价|价格|多少钱|优惠/.test(text)) return 'quote';
  if (/起批|混批|批发|拿货/.test(text)) return 'moq';
  if (/面料|成分|材质|棉|涤纶/.test(text)) return 'material';
  return 'general';
}

export async function simulateInbound(
  deps: ConversationDeps,
  input: SimulateInboundInput,
  context: ServiceContext,
): Promise<{
  conversation_id: string;
  message_id: string;
  unread_count: number;
  deduped: boolean;
  event: Record<string, unknown>;
  event_seq: number | null;
}> {
  const now = new Date();
  const sentAt = input.sent_at ? new Date(input.sent_at) : now;
  if (Number.isNaN(sentAt.getTime())) {
    throw new ApiError('validation_failed', 'sent_at 不是合法时间', { detail: { field: 'sent_at' } });
  }
  if (input.content.trim().length === 0 || input.content.length > 5000) {
    throw new ApiError('validation_failed', 'content 长度必须 1–5000', { detail: { field: 'content' } });
  }
  const platformMessageId = input.platform_message_id ?? `sim-${randomUUID()}`;

  let conversation = await deps.prisma.conversation.findFirst({
    where: {
      orgId: 1n,
      platform: input.platform,
      platformConversationId: input.platform_conversation_id,
      archivedAt: null,
    },
  });
  if (!conversation) {
    conversation = await deps.prisma.conversation.create({
      data: {
        orgId: 1n,
        platform: input.platform,
        platformConversationId: input.platform_conversation_id,
        buyerRef: input.buyer_ref ?? hashRef(`${input.platform}:${input.platform_conversation_id}`),
        ...(input.buyer_nick ? { buyerNick: input.buyer_nick } : {}),
        kind: input.kind ?? 'pre_sale',
        status: 'open',
        bizLine: input.platform === 'pdd' ? 'pdd_retail' : '1688_wholesale',
        relatedProductId: input.related_product_id ?? null,
        firstResponseDueAt: new Date(now.getTime() + 3 * 60 * 1000),
        createdBy: context.userId,
      },
    });
  }

  try {
    const result = await deps.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          orgId: 1n,
          conversationId: conversation!.id,
          direction: 'inbound',
          platform: input.platform,
          senderRole: 'buyer',
          platformMessageId,
          contentType: 'text',
          content: input.content,
          sentAt,
          platformSentAt: sentAt,
          status: 'received',
          createdBy: context.userId,
        },
      });
      const updated = await tx.conversation.update({
        where: { id: conversation!.id },
        data: {
          unreadCount: { increment: 1 },
          lastMessageAt: sentAt,
          lastInboundAt: now,
          status: conversation!.status === 'closed' ? 'open' : conversation!.status,
        },
      });
      const eventPayload = {
        conversation_id: conversation!.id,
        message_id: message.id,
        platform: input.platform,
        buyer_nick: updated.buyerNick,
        unread_count: updated.unreadCount,
        preview: input.content.slice(0, 120),
        t0: now.toISOString(),
        platform_sent_at: sentAt.toISOString(),
      };
      await tx.eventsOutbox.create({
        data: {
          orgId: 1n,
          topic: 'message.created',
          aggregateId: conversation!.id,
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
      return { message, updated, eventPayload, eventSeq: Number(eventLog.seq) };
    });

    await deps.audit.record({
      action: 'conversation.inbound',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'conversation',
      resourceId: conversation.id,
      after: {
        message_id: result.message.id,
        platform_message_id: platformMessageId,
        unread_count: result.updated.unreadCount,
        source: 'internal_simulate',
      },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, platform: input.platform },
    });

    return {
      conversation_id: conversation.id,
      message_id: result.message.id,
      unread_count: result.updated.unreadCount,
      deduped: false,
      event: result.eventPayload,
      event_seq: result.eventSeq,
    };
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      const existing = await deps.prisma.message.findFirst({
        where: { conversationId: conversation.id, platformMessageId },
      });
      if (existing) {
        return {
          conversation_id: conversation.id,
          message_id: existing.id,
          unread_count: conversation.unreadCount,
          deduped: true,
          event: {
            conversation_id: conversation.id,
            message_id: existing.id,
            deduped: true,
          },
          event_seq: null,
        };
      }
    }
    throw error;
  }
}

export async function listConversations(
  deps: ConversationDeps,
  query: {
    platform?: string;
    status?: string;
    unread?: boolean;
    assignee?: 'me' | undefined;
    userId?: string;
    cursor?: string;
    limit: number;
  },
) {
  const where: Prisma.ConversationWhereInput = { orgId: 1n, archivedAt: null };
  if (query.platform) where.platform = query.platform;
  if (query.status) where.status = query.status;
  if (query.unread) where.unreadCount = { gt: 0 };
  if (query.assignee === 'me' && query.userId) where.assignedUserId = query.userId;
  if (query.cursor) where.id = { lt: query.cursor };
  const rows = await deps.prisma.conversation.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      platform: row.platform,
      buyer_nick: row.buyerNick,
      last_message_at: row.lastMessageAt.toISOString(),
      unread_count: row.unreadCount,
      first_response_due_at: row.firstResponseDueAt?.toISOString() ?? null,
      status: row.status,
      kind: row.kind,
      draft_state: row.unreadCount > 0 ? 'pending' : 'idle',
      assignee: row.assignedUserId,
    })),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  };
}

export async function getConversation(
  deps: ConversationDeps,
  id: string,
  query: { messages_after?: string; limit: number; include_dry_run?: boolean },
) {
  const conversation = await deps.prisma.conversation.findFirst({
    where: { id, orgId: 1n, archivedAt: null },
  });
  if (!conversation) throw new ApiError('not_found', '会话不存在');

  let afterSeq: bigint | null = null;
  if (query.messages_after) {
    const after = await deps.prisma.message.findFirst({
      where: { id: query.messages_after, conversationId: id },
      select: { eventSeq: true },
    });
    afterSeq = after?.eventSeq ?? null;
  }
  const messages = await deps.prisma.message.findMany({
    where: {
      conversationId: id,
      archivedAt: null,
      ...(query.include_dry_run ? {} : { deliveryMode: 'live' }),
      ...(afterSeq ? { eventSeq: { gt: afterSeq } } : {}),
    },
    orderBy: [{ eventSeq: 'asc' }],
    take: query.limit,
  });
  const messageIds = messages.map((message) => message.id);
  const drafts = messageIds.length
    ? await deps.prisma.replyDraft.findMany({
        where: { messageId: { in: messageIds }, archivedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    : [];
  const lastInbound = [...messages].reverse().find((message) => message.direction === 'inbound');
  const intent = inferIntent(lastInbound?.content ?? '');
  const suggested = await selectFallbackTemplates(deps.prisma, {
    platform: conversation.platform,
    intent,
    limit: 3,
  });

  return {
    conversation: {
      id: conversation.id,
      platform: conversation.platform,
      platform_conversation_id: conversation.platformConversationId,
      buyer_nick: conversation.buyerNick,
      kind: conversation.kind,
      status: conversation.status,
      unread_count: conversation.unreadCount,
      last_message_at: conversation.lastMessageAt.toISOString(),
      last_inbound_at: conversation.lastInboundAt?.toISOString() ?? null,
      first_response_due_at: conversation.firstResponseDueAt?.toISOString() ?? null,
      related_product_id: conversation.relatedProductId,
      related_order_ref: conversation.relatedOrderRef,
      assignee: conversation.assignedUserId,
    },
    buyer: {
      tags: conversation.tags,
      order_refs: conversation.relatedOrderRef ? [conversation.relatedOrderRef] : [],
    },
    messages: messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      platform: message.platform,
      text: message.content,
      content_type: message.contentType,
      status: message.status,
      delivery_mode: message.deliveryMode,
      created_at: message.createdAt.toISOString(),
      platform_msg_id: message.platformMessageId,
      platform_sent_at: message.platformSentAt?.toISOString() ?? null,
      event_seq: message.eventSeq.toString(),
      read_at: message.readAt?.toISOString() ?? null,
      attachments: message.attachments,
    })),
    drafts: drafts.map((draft) => ({
      id: draft.id,
      message_id: draft.messageId,
      text: draft.draftText,
      degraded: draft.degraded,
      fallback_reason: draft.fallbackReason,
      template_id: draft.templateId,
      status: draft.status,
      created_at: draft.createdAt.toISOString(),
      evidence_refs: Array.isArray(draft.evidenceRefs) ? draft.evidenceRefs : [],
    })),
    suggested_templates: suggested,
  };
}

export async function markConversationRead(
  deps: ConversationDeps,
  id: string,
  context: ServiceContext,
) {
  const conversation = await deps.prisma.conversation.findFirst({ where: { id, archivedAt: null } });
  if (!conversation) throw new ApiError('not_found', '会话不存在');
  const now = new Date();
  const updated = await deps.prisma.$transaction(async (tx) => {
    await tx.message.updateMany({
      where: { conversationId: id, direction: 'inbound', readAt: null, archivedAt: null },
      data: { readAt: now },
    });
    return tx.conversation.update({
      where: { id },
      data: {
        unreadCount: 0,
        ...(conversation.firstResponseAt === null ? { firstResponseAt: now } : {}),
      },
    });
  });
  await deps.audit.record({
    action: 'conversation.read',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'conversation',
    resourceId: id,
    before: { unread_count: conversation.unreadCount },
    after: { unread_count: 0 },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return { id: updated.id, unread_count: updated.unreadCount };
}

export async function unreadSnapshot(deps: ConversationDeps, userId: string, snapshotSeq: number) {
  const [rows, total] = await Promise.all([
    deps.prisma.conversation.findMany({
      where: { orgId: 1n, archivedAt: null, unreadCount: { gt: 0 } },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      select: { id: true, unreadCount: true, lastMessageAt: true },
    }),
    deps.prisma.conversation.aggregate({
      where: { orgId: 1n, archivedAt: null, unreadCount: { gt: 0 } },
      _sum: { unreadCount: true },
    }),
  ]);
  return {
    snapshot_event_seq: snapshotSeq,
    server_ts: new Date().toISOString(),
    user_id: userId,
    total_unread: total._sum.unreadCount ?? 0,
    partial: rows.length >= 200,
    conversations: rows.map((row) => ({
      id: row.id,
      unread_count: row.unreadCount,
      last_message_at: row.lastMessageAt.toISOString(),
    })),
  };
}
