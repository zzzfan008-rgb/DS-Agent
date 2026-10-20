/**
 * 客服回复：5 秒硬超时草稿 + B 级发送（docs/18 §3–§4、§6）。
 *
 * - 草稿：模型网关 purpose=copy，Promise.race 硬截止（默认 5000ms）；超时/失败/无证据
 *   返回 degraded + 模板库 Top-N，不抛错。
 * - 发送：必须 B 级 approval；`(conversation_id, outbound_idempotency_key)` 唯一占位防双击；
 *   平台 adapter 未核验时走 dry-run 并明确 contract_unverified。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { canonicalHash } from '@dssaas/core';
import type { ModelGateway } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';
import { buildProductFacts } from './facts.js';
import { selectFallbackTemplates, type TemplateView } from './templates.js';
import type { ConfirmTokenStore } from '../write-gate/confirm.js';
import type { KillSwitchService } from '../write-gate/kill-switch.js';
import type { PlatformWritePort } from '../write-gate/platform-port.js';

export interface ReplyContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export interface ReplyDeps {
  prisma: PrismaClient;
  audit: AuditService;
  gateway: ModelGateway;
  killSwitch: KillSwitchService;
  platform: PlatformWritePort;
  confirmTokens: ConfirmTokenStore;
  /** 测试可注入；返回最终文案。 */
  generate?: (input: { prompt: string; conversationId: string }) => Promise<string>;
  now?: () => Date;
}

export interface EvidenceRef {
  source_table: string;
  source_id: string;
  source_version: number;
  quote: string;
}

export interface DraftInput {
  conversation_id: string;
  intent?: string;
  tone?: string;
  fact_refs?: string[];
  deadline_ms?: number;
}

export interface DraftResult {
  draft_id: string;
  text: string;
  degraded: boolean;
  degraded_reason: 'timeout' | 'model_error' | 'no_evidence' | null;
  latency_ms: number;
  expires_at: string;
  evidence_refs: EvidenceRef[];
  template_id: string | null;
  suggested_templates: TemplateView[];
}

class DraftTimeoutError extends Error {}

function evidenceFromFacts(
  facts: Awaited<ReturnType<typeof buildProductFacts>>,
): EvidenceRef[] {
  return facts.items
    .filter((item) => item.source === 'import' || item.source === 'manual' || item.source === 'kb')
    .slice(0, 8)
    .map((item) => ({
      source_table: item.source_table,
      source_id: item.source_id,
      source_version: item.source_version,
      quote: String(item.value).slice(0, 160),
    }));
}

function buildPrompt(input: DraftInput, conversation: { platform: string; kind: string }, evidence: EvidenceRef[]): string {
  return [
    '你是服装电商客服。只使用证据中的事实，不得编造价格、库存、成分、尺码、物流时效或政策。',
    `平台：${conversation.platform}；会话类型：${conversation.kind}；意图：${input.intent ?? 'general'}；语气：${input.tone ?? '专业简洁'}`,
    `证据：${JSON.stringify(evidence)}`,
    '输出一条可直接发送的中文客服回复，不超过 300 字；不要解释。',
  ].join('\n');
}

async function defaultGenerate(
  deps: ReplyDeps,
  prompt: string,
  context: ReplyContext,
): Promise<string> {
  const role = await deps.prisma.role.findFirst({
    where: { code: context.role, orgId: 1n, archivedAt: null },
    select: { id: true },
  });
  const result = await deps.gateway.invoke({
    principal: {
      orgId: 1,
      userId: context.userId,
      roles: [context.role],
      roleIds: role ? [role.id] : [],
    },
    purpose: 'copy',
    requestId: context.requestId,
    actorType: 'user',
    actorId: context.userId,
    subjectType: 'content_draft',
    params: { prompt, temperature: 0.2 },
    estimate: { tokensIn: 900, tokensOut: 300 },
  });
  return (result.response.text ?? '').trim();
}

export async function createReplyDraft(
  deps: ReplyDeps,
  input: DraftInput,
  context: ReplyContext,
): Promise<DraftResult> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  const deadlineMs = Math.min(Math.max(input.deadline_ms ?? 5000, 50), 5000);
  const conversation = await deps.prisma.conversation.findFirst({
    where: { id: input.conversation_id, orgId: 1n, archivedAt: null },
  });
  if (!conversation) throw new ApiError('not_found', '会话不存在');
  const inbound = await deps.prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: 'inbound', archivedAt: null },
    orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }],
  });
  if (!inbound) {
    throw new ApiError('validation_failed', '会话没有入站消息，无法生成回复草稿', {
      detail: { field: 'conversation_id' },
    });
  }

  let evidence: EvidenceRef[] = [];
  if (input.fact_refs && input.fact_refs.length > 0) {
    evidence = input.fact_refs.slice(0, 8).map((ref, index) => ({
      source_table: 'fact_ref',
      source_id: ref.slice(0, 200),
      source_version: 1,
      quote: input.fact_refs![index]!.slice(0, 160),
    }));
  } else if (conversation.relatedProductId) {
    try {
      evidence = evidenceFromFacts(await buildProductFacts(deps.prisma, conversation.relatedProductId));
    } catch {
      evidence = [];
    }
  }

  const suggestions = await selectFallbackTemplates(deps.prisma, {
    platform: conversation.platform,
    intent: input.intent ?? 'general',
    limit: 3,
  });

  // 无证据不允许模型自由发挥：直接降级模板 + 人工提示。
  if (evidence.length === 0) {
    const template = suggestions[0];
    const draft = await persistDraft(deps, {
      conversationId: conversation.id,
      inboundMessageId: inbound.id,
      text: template?.text ?? '您好，这个信息需要人工确认，我稍后回复您。',
      degraded: true,
      templateId: template && !template.builtin ? template.id : null,
      fallbackReason: 'no_evidence',
      latencyMs: Date.now() - started,
      context,
      evidence,
    });
    return {
      draft_id: draft.id,
      text: draft.draftText,
      degraded: true,
      degraded_reason: 'no_evidence',
      latency_ms: Date.now() - started,
      expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      evidence_refs: evidence,
      template_id: draft.templateId,
      suggested_templates: suggestions,
    };
  }

  const prompt = buildPrompt(input, conversation, evidence);
  const generate =
    deps.generate ?? ((args: { prompt: string; conversationId: string }) => defaultGenerate(deps, args.prompt, context));
  let text = '';
  let degraded = false;
  let degradedReason: DraftResult['degraded_reason'] = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new DraftTimeoutError('draft deadline exceeded')), deadlineMs);
      timer.unref?.();
    });
    text = await Promise.race([generate({ prompt, conversationId: conversation.id }), timeout]);
    if (!text || text.trim().length === 0) {
      degraded = true;
      degradedReason = 'model_error';
    }
  } catch (error) {
    degraded = true;
    degradedReason = error instanceof DraftTimeoutError ? 'timeout' : 'model_error';
  }

  let templateId: string | null = null;
  if (degraded) {
    const template = suggestions[0];
    text = template?.text ?? '您好，正在为您核实，请稍等。';
    templateId = template && !template.builtin ? template.id : null;
  }
  const trimmed = text.trim().slice(0, 5000);
  const draft = await persistDraft(deps, {
    conversationId: conversation.id,
    inboundMessageId: inbound.id,
    text: trimmed.length > 0 ? trimmed : '您好，正在为您核实，请稍等。',
    degraded,
    templateId,
    fallbackReason: degradedReason,
    latencyMs: Date.now() - started,
    context,
    evidence,
  });

  return {
    draft_id: draft.id,
    text: draft.draftText,
    degraded,
    degraded_reason: degradedReason,
    latency_ms: Date.now() - started,
    expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    evidence_refs: evidence,
    template_id: templateId,
    suggested_templates: suggestions,
  };
}

async function persistDraft(
  deps: ReplyDeps,
  input: {
    conversationId: string;
    inboundMessageId: string;
    text: string;
    degraded: boolean;
    templateId: string | null;
    fallbackReason: string | null;
    latencyMs: number;
    context: ReplyContext;
    evidence: EvidenceRef[];
  },
) {
  const draft = await deps.prisma.replyDraft.create({
    data: {
      orgId: 1n,
      messageId: input.inboundMessageId,
      conversationId: input.conversationId,
      draftText: input.text.slice(0, 5000),
      degraded: input.degraded,
      evidenceRefs: input.evidence as never,
      fallbackReason: input.fallbackReason,
      latencyMs: input.latencyMs,
      templateId: input.templateId,
      status: 'draft',
      createdBy: input.context.userId,
    },
  });
  await deps.audit.record({
    action: 'reply.draft',
    actorType: 'user',
    actorId: input.context.userId,
    requestId: input.context.requestId,
    resourceType: 'reply_draft',
    resourceId: draft.id,
    after: {
      degraded: input.degraded,
      template_id: input.templateId,
      fallback_reason: input.fallbackReason,
      evidence_refs: input.evidence,
      text_len: input.text.length,
    },
    ip: input.context.ip,
    userAgent: input.context.userAgent,
    meta: { actor_role: input.context.role },
  });
  return draft;
}

// ------------------------------------------------------------
// 发送（B 级）
// ------------------------------------------------------------

export interface SendInput {
  conversation_id: string;
  platform: 'pdd' | '1688';
  text: string;
  draft_id?: string;
  approval_id?: string;
  outbound_idempotency_key: string;
}

export interface SendResult {
  message_id: string;
  status: 'sent' | 'sending' | 'failed';
  platform_msg_id: string | null;
  deduped: boolean;
  contract_unverified: boolean;
  event: Record<string, unknown>;
  event_seq: number | null;
}

function assertApproval(input: {
  approval: {
    id: string;
    action: string;
    platform: string;
    operationLevel: string;
    status: string;
    targetHash: string;
    expiresAt: Date;
    createdBy: string | null;
    decidedBy: string | null;
  } | null;
  expectedAction: string;
  platform: string;
  targetHash: string;
  level: string;
  userId: string;
  now: Date;
}) {
  const approval = input.approval;
  if (!approval) throw new ApiError('approval_required', '发送必须携带 approval_id');
  if (approval.action !== input.expectedAction || approval.platform !== input.platform) {
    throw new ApiError('approval_stale', '审批动作/平台与发送不一致');
  }
  if (!['approved', 'approved_with_edit'].includes(approval.status)) {
    throw new ApiError('approval_required', '审批尚未通过', { detail: { status: approval.status } });
  }
  if (approval.expiresAt.getTime() <= input.now.getTime()) {
    throw new ApiError('approval_stale', '审批已过期');
  }
  if (approval.operationLevel !== input.level) {
    throw new ApiError('approval_stale', '审批级别与发送级别不一致', {
      detail: { expected: approval.operationLevel, actual: input.level },
    });
  }
  if (approval.targetHash !== input.targetHash) {
    throw new ApiError('approval_stale', '审批 target_hash 与消息内容不一致');
  }
  if (!approval.decidedBy) throw new ApiError('approval_required', '审批尚未决策');
  if (approval.decidedBy === approval.createdBy || approval.decidedBy === input.userId) {
    throw new ApiError('forbidden', '四眼原则：执行人不能是审批人');
  }
}

function mapExistingMessage(message: {
  id: string;
  status: string;
  platformMessageId: string | null;
}): SendResult {
  return {
    message_id: message.id,
    status: message.status === 'sent' ? 'sent' : 'sending',
    platform_msg_id: message.platformMessageId,
    deduped: true,
    contract_unverified: true,
    event: {},
    event_seq: null,
  };
}

export async function sendReply(deps: ReplyDeps, input: SendInput, context: ReplyContext): Promise<SendResult> {
  const now = deps.now?.() ?? new Date();
  if (input.platform !== 'pdd' && input.platform !== '1688') {
    throw new ApiError('validation_failed', 'platform 必须是 pdd/1688');
  }
  if (input.text.trim().length === 0 || input.text.length > 5000) {
    throw new ApiError('validation_failed', 'text 长度必须 1–5000', { detail: { field: 'text' } });
  }
  if (!/^[A-Za-z0-9:_-]{8,128}$/.test(input.outbound_idempotency_key)) {
    throw new ApiError('validation_failed', 'outbound_idempotency_key 格式非法', {
      detail: { field: 'outbound_idempotency_key' },
    });
  }
  const conversation = await deps.prisma.conversation.findFirst({
    where: { id: input.conversation_id, orgId: 1n, archivedAt: null },
  });
  if (!conversation) throw new ApiError('not_found', '会话不存在');
  if (conversation.platform !== input.platform) {
    throw new ApiError('validation_failed', 'platform 与会话不一致');
  }

  const existing = await deps.prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      outboundIdempotencyKey: input.outbound_idempotency_key,
      archivedAt: null,
    },
  });
  if (existing) return mapExistingMessage(existing);

  // 草稿门禁：降级草稿不得进入发送链；非降级草稿必须有可追溯 evidence_refs（audit after）。
  if (input.draft_id) {
    const draft = await deps.prisma.replyDraft.findFirst({
      where: { id: input.draft_id, archivedAt: null },
    });
    if (!draft) throw new ApiError('not_found', '草稿不存在');
    if (draft.conversationId && draft.conversationId !== conversation.id) {
      throw new ApiError('validation_failed', '草稿不属于当前会话');
    }
    const draftMessage = await deps.prisma.message.findFirst({
      where: { id: draft.messageId, conversationId: conversation.id },
      select: { id: true },
    });
    if (!draftMessage) throw new ApiError('validation_failed', '草稿不属于当前会话');
    const evidenceRefs = Array.isArray(draft.evidenceRefs) ? draft.evidenceRefs : [];
    if (draft.degraded) {
      throw new ApiError('conflict', '降级草稿不能直接发送，请人工核对/改写后再发', {
        detail: {
          draft_id: draft.id,
          next_action: 'manual_edit',
          fallback_reason: draft.fallbackReason ?? 'degraded',
        },
      });
    }
    if (evidenceRefs.length === 0) {
      throw new ApiError('conflict', '草稿缺少可引用证据，不能进入发送链', {
        detail: { draft_id: draft.id, next_action: 'manual_edit' },
      });
    }
  }

  const targetHash = canonicalHash({ conversation_id: conversation.id, text: input.text.trim() });
  const approval = input.approval_id
    ? await deps.prisma.approval.findFirst({ where: { id: input.approval_id, archivedAt: null } })
    : null;
  assertApproval({
    approval,
    expectedAction: 'send_reply',
    platform: input.platform,
    targetHash,
    level: 'B',
    userId: context.userId,
    now,
  });
  await deps.killSwitch.assertNotBlocked({ platform: input.platform, taskType: 'message' });

  let message;
  try {
    message = await deps.prisma.message.create({
      data: {
        orgId: 1n,
        conversationId: conversation.id,
        direction: 'outbound',
        platform: input.platform,
        senderRole: 'agent',
        contentType: 'text',
        content: input.text.trim(),
        status: 'sending',
        outboundIdempotencyKey: input.outbound_idempotency_key,
        approvalId: approval!.id,
        aiGenerated: Boolean(input.draft_id),
        createdBy: context.userId,
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      const raced = await deps.prisma.message.findFirst({
        where: {
          conversationId: conversation.id,
          outboundIdempotencyKey: input.outbound_idempotency_key,
          archivedAt: null,
        },
      });
      if (raced) return mapExistingMessage(raced);
    }
    throw error;
  }

  try {
    const preview = await deps.platform.preview({
      platform: input.platform,
      action: 'message.send',
      payload: {
        conversation_id: conversation.id,
        platform_conversation_id: conversation.platformConversationId,
        text: input.text.trim(),
        approval_id: approval!.id,
        outbound_idempotency_key: input.outbound_idempotency_key,
      },
      requestId: context.requestId,
      idempotencyKey: input.outbound_idempotency_key,
    });
    const sentAt = deps.now?.() ?? new Date();
    const updated = await deps.prisma.$transaction(async (tx) => {
      const msg = await tx.message.update({
        where: { id: message!.id },
        data: { status: 'sent', sentAt, platformSentAt: sentAt },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: sentAt },
      });
      await tx.approval.update({
        where: { id: approval!.id },
        data: { status: 'executed', executedAt: sentAt },
      });
      const eventPayload = {
        conversation_id: conversation.id,
        message_id: msg.id,
        direction: 'outbound',
        status: 'sent',
        platform: input.platform,
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
      action: 'message.send',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'message',
      resourceId: updated.msg.id,
      after: {
        conversation_id: conversation.id,
        status: 'sent',
        operation_level: 'B',
        approval_id: approval!.id,
        contract_unverified: true,
        adapter: preview.adapter,
      },
      irreversible: true,
      ip: context.ip,
      userAgent: context.userAgent,
      meta: {
        actor_role: context.role,
        approval_id: approval!.id,
        target_hash: targetHash,
        outbound_idempotency_key: input.outbound_idempotency_key,
      },
    });
    return {
      message_id: updated.msg.id,
      status: 'sent',
      platform_msg_id: null,
      deduped: false,
      contract_unverified: true,
      event: updated.eventPayload,
      event_seq: updated.eventSeq,
    };
  } catch (error) {
    await deps.prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'failed',
        errorCode: (error as { code?: string }).code ?? 'adapter_error',
      },
    });
    throw error;
  }
}
