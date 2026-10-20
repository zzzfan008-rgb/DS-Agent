/** t31：M5 残余收口（dry-run 不记 sent、model_call_id、模板 usage、event_log 清理）。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
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
import { purgeEventLog } from '../src/realtime/retention.js';

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
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t31-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function simulate(content = '请问什么时候发货？') {
  const response = await post(
    '/api/internal/conversations/simulate-inbound',
    {
      platform: 'pdd',
      platform_conversation_id: `t31-${randomUUID()}`,
      buyer_nick: 't31 买家',
      content,
    },
    adminHeaders,
  );
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: { conversation_id: string; message_id: string } }).data;
}

async function approveSend(conversationId: string, text: string) {
  const created = await post('/api/approvals', {
    subject_type: 'message',
    subject_id: conversationId,
    action: 'send_reply',
    platform: 'pdd',
    target_payload: { conversation_id: conversationId, text },
  });
  assert.equal(created.statusCode, 201, created.body);
  const approval = (created.json() as { data: { id: string } }).data;
  const decided = await post(`/api/approvals/${approval.id}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(decided.statusCode, 200, decided.body);
  return approval.id;
}

before(async () => {
  app = await buildTestApp({
    LOG_LEVEL: 'error',
    DSSAAS_ENABLE_INTERNAL_SIMULATION: '1',
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
  });
  admin = await createUser({ email: 'admin.t31@test.local', password: ADMIN_PASSWORD, role: 'admin' });
  operator = await createUser({ email: 'operator.t31@test.local', password: OPERATOR_PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('演练不记已发送：dry_run=queued，live=sent；报表默认过滤 live', async () => {
  const conv = await simulate('发货时间？');
  const text = '您好，48 小时内发货。';
  const approvalId = await approveSend(conv.conversation_id, text);
  const services = getM5Services(app);
  const originalPort = services.replies.platform;
  services.replies.platform = {
    preview: async () => ({
      platform: 'pdd',
      adapter: 'fake-live',
      status: 'dry_run',
      interfaceKey: 'message.send',
      payloadHash: 'a'.repeat(64),
      blocked: false,
      requestPreview: {},
      warnings: [],
      todoIds: [],
      raw_object_key: 'minio://raw/pdd/message/abc.json.gz',
    }),
  };

  const dry = await post('/api/replies/send', {
    conversation_id: conv.conversation_id,
    platform: 'pdd',
    text,
    approval_id: approvalId,
    outbound_idempotency_key: `dry-${randomUUID()}`,
    delivery_mode: 'dry_run',
  });
  assert.equal(dry.statusCode, 200, dry.body);
  const dryBody = dry.json() as { data: { message_id: string; status: string; delivery_mode: string } };
  assert.equal(dryBody.data.status, 'queued');
  assert.equal(dryBody.data.delivery_mode, 'dry_run');
  const dryRow = await prisma.message.findUniqueOrThrow({ where: { id: dryBody.data.message_id } });
  assert.equal(dryRow.status, 'queued');
  assert.equal(dryRow.deliveryMode, 'dry_run');
  assert.equal(dryRow.sentAt, null);
  assert.equal((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status, 'approved');

  // 报表/会话详情默认只返回 live；演练需显式 include_dry_run=1
  const hidden = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conv.conversation_id}`,
    headers: operatorHeaders,
  });
  const hiddenMessages = (hidden.json() as { data: { messages: Array<{ id: string }> } }).data.messages;
  assert.ok(!hiddenMessages.some((message) => message.id === dryBody.data.message_id));
  const included = await app.inject({
    method: 'GET',
    url: `/api/conversations/${conv.conversation_id}?include_dry_run=1`,
    headers: operatorHeaders,
  });
  const includedMessages = (included.json() as { data: { messages: Array<{ id: string }> } }).data.messages;
  assert.ok(includedMessages.some((message) => message.id === dryBody.data.message_id));

  const live = await post('/api/replies/send', {
    conversation_id: conv.conversation_id,
    platform: 'pdd',
    text,
    approval_id: approvalId,
    outbound_idempotency_key: `live-${randomUUID()}`,
    delivery_mode: 'live',
  });
  assert.equal(live.statusCode, 200, live.body);
  const liveBody = live.json() as { data: { message_id: string; status: string; delivery_mode: string } };
  assert.equal(liveBody.data.status, 'sent');
  assert.equal(liveBody.data.delivery_mode, 'live');
  const liveRow = await prisma.message.findUniqueOrThrow({ where: { id: liveBody.data.message_id } });
  assert.equal(liveRow.status, 'sent');
  assert.equal(liveRow.deliveryMode, 'live');
  assert.ok(liveRow.platformSentAt);
  assert.equal(liveRow.rawObjectKey, 'minio://raw/pdd/message/abc.json.gz');
  assert.equal((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status, 'executed');

  services.replies.platform = originalPort;
});

test('草稿成本可追溯：正常生成写 model_call_id，降级为 null 且有 fallback_reason', async () => {
  const conv = await simulate('推荐尺码');
  const deps = getM5Services(app).replies;
  const ctx = {
    requestId: `req-${randomUUID()}`,
    userId: operator.id,
    role: 'operator' as const,
    ip: null,
    userAgent: 't31-test',
  };
  const normal = await createReplyDraft(
    { ...deps, generate: async () => ({ text: '建议 M 码', modelCallId: randomUUID() }) },
    {
      conversation_id: conv.conversation_id,
      fact_refs: ['master:size_chart:M'],
      deadline_ms: 1000,
    },
    ctx,
  );
  const normalRow = await prisma.replyDraft.findUniqueOrThrow({ where: { id: normal.draft_id } });
  assert.ok(normalRow.modelCallId);
  assert.ok((normalRow.latencyMs ?? -1) >= 0);

  const degradedConv = await simulate('这件有颜色吗');
  const degraded = await createReplyDraft(
    { ...deps, generate: async () => { throw new Error('mock model down'); } },
    { conversation_id: degradedConv.conversation_id, deadline_ms: 1000 },
    ctx,
  );
  assert.equal(degraded.degraded, true);
  const degradedRow = await prisma.replyDraft.findUniqueOrThrow({ where: { id: degraded.draft_id } });
  assert.equal(degradedRow.modelCallId, null);
  assert.ok(degradedRow.fallbackReason);
  assert.equal(degradedRow.degraded, true);
});

test('模板使用回写：选中后 usage_count+1、last_used_at 非空', async () => {
  const template = await post(
    '/api/reply-templates',
    { intent: 'general', text: '您好，我在的。', platform: 'pdd', weight: 10 },
    adminHeaders,
  );
  assert.equal(template.statusCode, 201, template.body);
  const templateId = (template.json() as { data: { id: string } }).data.id;
  const approved = await app.inject({
    method: 'PATCH',
    url: `/api/reply-templates/${templateId}`,
    headers: { ...adminHeaders, 'content-type': 'application/json', 'idempotency-key': `t31-${randomUUID()}` },
    payload: { status: 'approved' },
  });
  assert.equal(approved.statusCode, 200, approved.body);

  const conv = await simulate('在吗');
  const draft = await post('/api/replies/draft', {
    conversation_id: conv.conversation_id,
    intent: 'general',
  });
  assert.equal(draft.statusCode, 201, draft.body);
  const row = await prisma.replyTemplate.findUniqueOrThrow({ where: { id: templateId } });
  assert.equal(row.usageCount, 1);
  assert.ok(row.lastUsedAt);
});

test('event_log 清理：只删 7 天前，分批执行，过期行不影响新行', async () => {
  const old = new Date(Date.now() - 8 * 86400 * 1000);
  const created: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const row = await prisma.eventLog.create({
      data: { topic: 'message.created', payload: { marker: `old-${index}` }, createdAt: old },
      select: { seq: true },
    });
    created.push(String(row.seq));
  }
  const fresh = await prisma.eventLog.create({
    data: { topic: 'message.created', payload: { marker: 'fresh' } },
    select: { seq: true },
  });
  const result = await purgeEventLog(prisma, { retentionDays: 7, batchSize: 2, maxBatches: 10 });
  assert.equal(result.truncated, false);
  assert.ok(result.deleted >= 3);
  assert.ok(result.batches >= 2);
  assert.equal(await prisma.eventLog.count({ where: { seq: { in: created.map((seq) => BigInt(seq)) } } }), 0);
  assert.ok(await prisma.eventLog.findUnique({ where: { seq: fresh.seq } }));
  assert.ok(result.durationMs >= 0);
});
