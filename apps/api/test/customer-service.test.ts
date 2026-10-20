/** t21 验收：M5 客服会话、SSE、5s 降级、B 发送去重、C 报价、模板库。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canonicalHash } from '@dssaas/core';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  csrfFrom,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';
import { getM5Services } from '../src/services/m5.js';
import { createReplyDraft } from '../src/services/replies.js';
import { quoteTargetPayload } from '../src/services/quotes.js';
import { RealtimeHub } from '../src/realtime/hub.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';

let app: FastifyInstance;
let admin: { id: string; email: string };
let operator: { id: string; email: string };
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;

async function post(path: string, payload: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t21-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function patch(path: string, payload: unknown, headers = adminHeaders) {
  return app.inject({
    method: 'PATCH',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t21-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function simulate(input: {
  platform?: 'pdd' | '1688';
  platformConversationId: string;
  content: string;
  platformMessageId?: string;
  kind?: string;
  relatedProductId?: string;
}) {
  const response = await post(
    '/api/internal/conversations/simulate-inbound',
    {
      platform: input.platform ?? 'pdd',
      platform_conversation_id: input.platformConversationId,
      buyer_nick: '测试买家',
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.relatedProductId ? { related_product_id: input.relatedProductId } : {}),
      content: input.content,
      ...(input.platformMessageId ? { platform_message_id: input.platformMessageId } : {}),
    },
    adminHeaders,
  );
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { conversation_id: string; message_id: string; unread_count: number } }).data;
}

async function approve(input: {
  subjectType: 'message' | 'quote';
  subjectId: string;
  action: 'send_reply' | 'send_quote';
  platform: 'pdd' | '1688';
  target: Record<string, unknown>;
  riskMeta?: Record<string, unknown>;
}) {
  const created = await post('/api/approvals', {
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    action: input.action,
    platform: input.platform,
    target_payload: input.target,
    risk_meta: input.riskMeta ?? { impact_scope: {} },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = (created.json() as { data: { id: string; level: string; target_hash: string } }).data;
  const decided = await post(`/api/approvals/${id.id}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(decided.statusCode, 200, decided.body);
  return id;
}

before(async () => {
  app = await buildTestApp({
    LOG_LEVEL: 'error',
    DSSAAS_ENABLE_INTERNAL_SIMULATION: '1',
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
  });
  admin = await createUser({ email: 'admin.t21@test.local', password: ADMIN_PASSWORD, role: 'admin' });
  operator = await createUser({ email: 'operator.t21@test.local', password: OPERATOR_PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('入站事务：消息落库 + 未读原子 +1 + outbox；同会话重复消息幂等', async () => {
  const conv = await simulate({
    platformConversationId: `conv-${randomUUID()}`,
    content: '请问 M 码有货吗？',
    platformMessageId: `pm-${randomUUID()}`,
  });
  const first = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.conversation_id } });
  assert.equal(first.unreadCount, 1);
  assert.ok(first.lastInboundAt);
  const outbox = await prisma.eventsOutbox.findFirst({
    where: { aggregateId: conv.conversation_id, topic: 'message.created' },
  });
  assert.ok(outbox);

  // 同一平台消息 ID 重复：不新增 message、不重复累加未读
  const duplicate = await post(
    '/api/internal/conversations/simulate-inbound',
    {
      platform: 'pdd',
      platform_conversation_id: first.platformConversationId,
      content: '重复回调',
      platform_message_id: conv.conversation_id ? (await prisma.message.findUniqueOrThrow({ where: { id: conv.message_id } })).platformMessageId : 'x',
    },
    adminHeaders,
  );
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal((duplicate.json() as { data: { deduped: boolean } }).data.deduped, true);
  const afterDup = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.conversation_id } });
  assert.equal(afterDup.unreadCount, 1);

  // 未读原子递增：第二条新消息 → 2
  const another = await simulate({
    platformConversationId: first.platformConversationId,
    content: '那 L 码呢？',
    platformMessageId: `pm-${randomUUID()}`,
  });
  assert.equal(another.unread_count, 2);
  const read = await post(`/api/conversations/${conv.conversation_id}/read`, {});
  assert.equal(read.statusCode, 200, read.body);
  assert.equal((read.json() as { data: { unread_count: number } }).data.unread_count, 0);
});

test('跨会话相同 platform_message_id 不冲突（t19 会话内唯一）', async () => {
  const sharedId = `shared-${randomUUID()}`;
  const a = await simulate({
    platformConversationId: `conv-a-${randomUUID()}`,
    content: 'A 会话消息',
    platformMessageId: sharedId,
  });
  const b = await simulate({
    platformConversationId: `conv-b-${randomUUID()}`,
    content: 'B 会话消息',
    platformMessageId: sharedId,
  });
  assert.notEqual(a.conversation_id, b.conversation_id);
  assert.equal(await prisma.message.count({ where: { platformMessageId: sharedId } }), 2);
});

test('草稿无证据：不调用模型，返回 degraded=no_evidence + 模板建议', async () => {
  const conv = await simulate({
    platformConversationId: `conv-draft-${randomUUID()}`,
    content: '这件衣服有什么颜色？',
  });
  const response = await post('/api/replies/draft', { conversation_id: conv.conversation_id });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as {
    data: {
      draft_id: string;
      degraded: boolean;
      degraded_reason: string;
      text: string;
      evidence_refs: unknown[];
      suggested_templates: Array<{ id: string; text: string }>;
    };
  };
  assert.equal(body.data.degraded, true);
  assert.equal(body.data.degraded_reason, 'no_evidence');
  assert.ok(body.data.text.length > 0);
  assert.equal(body.data.evidence_refs.length, 0);
  assert.ok(body.data.suggested_templates.length > 0);

  // 降级草稿不得进入发送链：即使审批有效也拒绝
  const approval = await approve({
    subjectType: 'message',
    subjectId: conv.conversation_id,
    action: 'send_reply',
    platform: 'pdd',
    target: { conversation_id: conv.conversation_id, text: body.data.text },
  });
  const blocked = await post('/api/replies/send', {
    conversation_id: conv.conversation_id,
    platform: 'pdd',
    text: body.data.text,
    draft_id: body.data.draft_id,
    approval_id: approval.id,
    outbound_idempotency_key: `degraded-${randomUUID()}`,
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'conflict');
  assert.equal(await prisma.message.count({ where: { conversationId: conv.conversation_id, direction: 'outbound' } }), 0);
});

test('草稿证据可追溯：audit.after 保存 evidence_refs，会话详情可回读', async () => {
  const conv = await simulate({
    platformConversationId: `conv-evidence-${randomUUID()}`,
    content: '请按尺码表推荐',
  });
  const deps = getM5Services(app).replies;
  const draft = await createReplyDraft(
    {
      ...deps,
      generate: async () => '根据尺码表，建议您选择 M 码。',
    },
    {
      conversation_id: conv.conversation_id,
      intent: 'size',
      fact_refs: ['master:size_chart:M:胸围104'],
      deadline_ms: 1000,
    },
    {
      requestId: `req-${randomUUID()}`,
      userId: operator.id,
      role: 'operator',
      ip: null,
      userAgent: 't21-test',
    },
  );
  assert.equal(draft.degraded, false);
  assert.ok(draft.evidence_refs.length > 0);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conv.conversation_id}`,
    headers: operatorHeaders,
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const drafts = (detail.json() as {
    data: { drafts: Array<{ id: string; evidence_refs: unknown[]; fallback_reason: string | null }> };
  }).data.drafts;
  const stored = drafts.find((item) => item.id === draft.draft_id);
  assert.ok(stored);
  assert.ok(stored!.evidence_refs.length > 0);
  assert.equal(stored!.fallback_reason, null);
});

test('草稿 5s 硬超时：注入慢模型 → timeout 降级，不抛错', async () => {
  const conv = await simulate({
    platformConversationId: `conv-timeout-${randomUUID()}`,
    content: '帮我推荐尺码',
  });
  const deps = getM5Services(app).replies;
  const slow = {
    ...deps,
    generate: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return '迟到的模型结果';
    },
  };
  const started = Date.now();
  const result = await createReplyDraft(
    slow,
    {
      conversation_id: conv.conversation_id,
      intent: 'size',
      fact_refs: ['master:size_chart:M'],
      deadline_ms: 50,
    },
    {
      requestId: `req-${randomUUID()}`,
      userId: operator.id,
      role: 'operator',
      ip: null,
      userAgent: 't21-test',
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(result.degraded, true);
  assert.equal(result.degraded_reason, 'timeout');
  assert.ok(elapsed < 1000, `降级应在超时后立即返回，实际 ${elapsed}ms`);
  assert.notEqual(result.text, '迟到的模型结果');
});

test('B 级发送：无 approval 428；同 outbound key 只发一次；dry-run contract_unverified', async () => {
  const conv = await simulate({
    platformConversationId: `conv-send-${randomUUID()}`,
    content: '什么时候发货？',
  });
  const text = '您好，今天下单 48 小时内发货，具体以物流更新为准。';
  const key = `out-${randomUUID()}`;
  const missing = await post('/api/replies/send', {
    conversation_id: conv.conversation_id,
    platform: 'pdd',
    text,
    outbound_idempotency_key: key,
  });
  assert.equal(missing.statusCode, 428);
  assert.equal((missing.json() as { error: { code: string } }).error.code, 'approval_required');

  const target = { conversation_id: conv.conversation_id, text };
  const approval = await approve({
    subjectType: 'message',
    subjectId: conv.conversation_id,
    action: 'send_reply',
    platform: 'pdd',
    target,
  });
  const body = {
    conversation_id: conv.conversation_id,
    platform: 'pdd',
    text,
    approval_id: approval.id,
    outbound_idempotency_key: key,
  };
  const sent = await post('/api/replies/send', body);
  assert.equal(sent.statusCode, 200, sent.body);
  const sentBody = sent.json() as {
    data: { message_id: string; status: string; deduped: boolean; contract_unverified: boolean };
  };
  assert.equal(sentBody.data.status, 'sent');
  assert.equal(sentBody.data.deduped, false);
  assert.equal(sentBody.data.contract_unverified, true);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.conversation_id, direction: 'outbound' } }), 1);

  const duplicate = await post('/api/replies/send', body);
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  const dupBody = duplicate.json() as { data: { message_id: string; deduped: boolean } };
  assert.equal(dupBody.data.deduped, true);
  assert.equal(dupBody.data.message_id, sentBody.data.message_id);
  assert.equal(await prisma.message.count({ where: { conversationId: conv.conversation_id, direction: 'outbound' } }), 1);
});

test('C 级报价：无 token 409；签发一次性 token 后成功，content_type=quote+attachments', async () => {
  const conv = await simulate({
    platform: '1688',
    platformConversationId: `conv-quote-${randomUUID()}`,
    content: '这款 50 件什么价？',
    kind: 'inquiry',
  });
  const priceTiers = [
    { min_qty: 2, price_cents: 12900 },
    { min_qty: 50, price_cents: 11900 },
  ];
  const target = quoteTargetPayload({
    conversation_id: conv.conversation_id,
    sku_ids: [randomUUID()],
    price_tiers: priceTiers,
    min_order_qty: 2,
  });
  const approval = await approve({
    subjectType: 'quote',
    subjectId: conv.conversation_id,
    action: 'send_quote',
    platform: '1688',
    target,
    riskMeta: { impact_scope: { sku_count: 1 } },
  });
  assert.equal(approval.level, 'C');
  const targetHash = canonicalHash(target);
  const quoteBody = {
    platform: '1688',
    sku_ids: target.sku_ids,
    price_tiers: priceTiers,
    min_order_qty: 2,
    approval_id: approval.id,
    outbound_idempotency_key: `quote-${randomUUID()}`,
  };
  const noToken = await post(`/api/inquiries/${conv.conversation_id}/quote`, quoteBody);
  assert.equal(noToken.statusCode, 409);
  assert.equal((noToken.json() as { error: { code: string } }).error.code, 'irreversible');

  const tokenResponse = await post(`/api/inquiries/${conv.conversation_id}/confirm-token`, {
    approval_id: approval.id,
    target_hash: targetHash,
  });
  assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
  const token = (tokenResponse.json() as { data: { confirm_token: string } }).data.confirm_token;

  const sent = await post(`/api/inquiries/${conv.conversation_id}/quote`, {
    ...quoteBody,
    confirm_token: token,
  });
  assert.equal(sent.statusCode, 201, sent.body);
  const body = sent.json() as {
    data: { status: string; quote: { quote_no: string; items: unknown[]; min_order_qty: number } };
  };
  assert.equal(body.data.status, 'sent');
  assert.equal(body.data.quote.min_order_qty, 2);
  assert.ok(body.data.quote.quote_no.startsWith('Q-'));
  const message = await prisma.message.findFirst({
    where: { conversationId: conv.conversation_id, direction: 'outbound' },
  });
  assert.equal(message?.contentType, 'quote');
  const attachments = message?.attachments as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(attachments) && attachments.length === 1);
});

test('模板库：admin 创建/审批/列表；GET 对 viewer 可见', async () => {
  const create = await post(
    '/api/reply-templates',
    { intent: 'logistics', text: '发货后 48 小时内有物流更新。', platform: 'pdd', weight: 200 },
    adminHeaders,
  );
  assert.equal(create.statusCode, 201, create.body);
  const id = (create.json() as { data: { id: string } }).data.id;
  const approved = await patch(`/api/reply-templates/${id}`, { status: 'approved' }, adminHeaders);
  assert.equal(approved.statusCode, 200, approved.body);
  const list = await app.inject({
    method: 'GET',
    url: '/api/reply-templates?platform=pdd&intent=logistics',
    headers: operatorHeaders,
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok((list.json() as { data: { items: unknown[] } }).data.items.length >= 1);
});

test('SSE 事件中枢：Last-Event-ID 重放、空洞/超前返回 resync 原因', () => {
  const hub = new RealtimeHub();
  const first = hub.publish('message.created', { n: 1 });
  const second = hub.publish('draft.updated', { n: 2 });
  assert.equal(first.seq, 1);
  const replay = hub.replay(String(first.seq));
  assert.equal(replay.resyncReason, null);
  assert.deepEqual(replay.events.map((event) => event.seq), [second.seq]);
  assert.equal(hub.replay('abc').resyncReason, 'unknown_id');
  assert.equal(hub.replay('999').resyncReason, 'ahead');
  const empty = new RealtimeHub();
  assert.equal(empty.replay('5').resyncReason, 'ahead');
});
