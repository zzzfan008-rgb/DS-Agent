/** t9 验收：写入门时序、A/B/C、幂等、审批、C 二次确认、伪回滚、kill switch、工单。 */
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
import { publishTargetPayload } from '../src/write-gate/gate.js';
import { validateReplayPreconditions, canTransition, classifyFailure } from '../src/write-gate/workflow.js';
import { computeLevel } from '../src/write-gate/actions.js';

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
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t9-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function makeListing(platform: 'pdd' | '1688' = 'pdd') {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const product = await prisma.product.create({
    data: {
      orgId: 1n,
      spuCode: `T9-${suffix}`,
      name: `t9 测试商品 ${suffix}`,
      categoryCode: 'A0101',
      createdBy: operator.id,
    },
  });
  const listing = await prisma.listing.create({
    data: {
      orgId: 1n,
      platform,
      productId: product.id,
      status: 'draft',
      createdBy: operator.id,
    },
  });
  return { product, listing };
}

async function createApproval(input: {
  listingId: string;
  action: 'publish' | 'update_price';
  target: Record<string, unknown>;
  context: Record<string, unknown>;
  platform?: 'pdd' | '1688';
}) {
  const response = await post('/api/approvals', {
    subject_type: 'listing',
    subject_id: input.listingId,
    action: input.action,
    platform: input.platform ?? 'pdd',
    target_payload: input.target,
    risk_meta: { impact_scope: { sku_ids: [] }, risk_notes: ['t9 test'] },
    context: input.context,
  });
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json() as { data: { id: string; level: string; target_hash: string } };
  const decided = await post(`/api/approvals/${data.data.id}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(decided.statusCode, 200, decided.body);
  return data.data;
}

function publishBody(productId: string, approvalId?: string, platform: 'pdd' | '1688' = 'pdd') {
  return {
    product_id: productId,
    platform,
    sku_ids: [] as string[],
    ...(approvalId ? { approval_id: approvalId } : {}),
    mode: 'dry_run' as const,
  };
}

before(async () => {
  app = await buildTestApp({
    LOG_LEVEL: 'error',
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
  });
  admin = await createUser({ email: 'admin.t9@test.local', password: ADMIN_PASSWORD, role: 'admin' });
  operator = await createUser({ email: 'operator.t9@test.local', password: OPERATOR_PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('B 级上架 dry-run 全链路：快照→幂等→adapter→写留痕→工单；重复提交回放', async () => {
  const { product, listing } = await makeListing();
  const target = publishTargetPayload({
    product_id: product.id,
    platform: 'pdd',
    sku_ids: [],
    media_plan: {},
  });
  const approval = await createApproval({
    listingId: listing.id,
    action: 'publish',
    target,
    context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
  });
  assert.equal(approval.level, 'B');

  const first = await post('/api/listings/publish', publishBody(product.id, approval.id));
  assert.equal(first.statusCode, 200, first.body);
  const body = first.json() as {
    data: {
      write_id: string;
      level: string;
      result: string;
      idempotent_replayed: boolean;
      platform_response: { status: string; adapter: string; contract_unverified: boolean };
      compensating_ticket_id: string;
      workflow_run_id: string;
      snapshot_ref: string;
    };
  };
  assert.equal(body.data.result, 'success');
  assert.equal(body.data.level, 'B');
  assert.equal(body.data.idempotent_replayed, false);
  assert.equal(body.data.platform_response.status, 'dry_run');
  assert.equal(body.data.platform_response.contract_unverified, true);
  assert.ok(body.data.compensating_ticket_id);
  assert.ok(body.data.snapshot_ref);
  assert.ok(body.data.workflow_run_id);

  const writeLogs = await prisma.listingWriteLog.findMany({ where: { listingId: listing.id } });
  assert.equal(writeLogs.length, 1);
  assert.equal(writeLogs[0]!.level, 'B');
  assert.equal(writeLogs[0]!.restoredFromSnapshot, false);
  const tickets = await prisma.compensatingTicket.findMany({ where: { relatedListingId: listing.id } });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0]!.status, 'open');
  const snapshots = await prisma.listingSnapshot.findMany({ where: { listingId: listing.id } });
  assert.ok(snapshots.length >= 1);
  const run = await prisma.workflowRun.findFirst({ where: { id: body.data.workflow_run_id } });
  assert.equal(run?.state, 'succeeded');
  assert.ok(run?.finishedAt);

  // 同 payload 新 HTTP Idempotency-Key 再次提交：写入门 L3 键回放，不产生第二次写
  const replay = await post('/api/listings/publish', publishBody(product.id, approval.id));
  assert.equal(replay.statusCode, 200, replay.body);
  const replayBody = replay.json() as {
    data: { idempotent_replayed: boolean; write_id: string; compensating_ticket_id: string };
  };
  assert.equal(replayBody.data.idempotent_replayed, true);
  assert.equal(replayBody.data.write_id, body.data.write_id);
  assert.equal(await prisma.listingWriteLog.count({ where: { listingId: listing.id } }), 1);
  assert.equal(await prisma.compensatingTicket.count({ where: { relatedListingId: listing.id } }), 1);

  // 工单生命周期：认领 → admin 复核关闭（dry-run 工单要求 admin）
  const claim = await post(`/api/compensating-tickets/${body.data.compensating_ticket_id}/claim`, {});
  assert.equal(claim.statusCode, 200, claim.body);
  const resolved = await post(
    `/api/compensating-tickets/${body.data.compensating_ticket_id}/resolve`,
    { resolution: 'dry-run 无平台副作用，人工核对后关闭', verified_by: admin.id },
    adminHeaders,
  );
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.equal((resolved.json() as { data: { status: string } }).data.status, 'resolved');
});

test('未带 approval_id 被拒：approval_required，且无写留痕', async () => {
  const { product, listing } = await makeListing();
  const before = await prisma.listingWriteLog.count({ where: { listingId: listing.id } });
  const response = await post('/api/listings/publish', publishBody(product.id));
  assert.equal(response.statusCode, 428);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'approval_required');
  assert.equal(await prisma.listingWriteLog.count({ where: { listingId: listing.id } }), before);
});

test('C 级缺二次确认被拒；签发一次性 token 后成功，token 不可复用', async () => {
  const { product, listing } = await makeListing();
  const category = await prisma.platformCategory.create({
    data: {
      orgId: 1n,
      platform: 'pdd',
      externalCategoryId: `T9CAT-${randomUUID().slice(0, 8)}`,
      name: 't9 测试类目',
    },
  });
  await prisma.listing.update({
    where: { id: listing.id },
    data: {
      status: 'publishing',
      platformItemId: 'PDD-T9-TEST-1',
      platformCategoryId: category.id,
    },
  });
  const payload = { price_cents: 12900 };
  const target = {
    action: 'listing.update_price',
    platform: 'pdd',
    listing_id: listing.id,
    payload,
  };
  const approval = await createApproval({
    listingId: listing.id,
    action: 'update_price',
    target,
    context: { listingStatus: 'published', priceDeltaRatio: 0.05 },
  });
  assert.equal(approval.level, 'C');
  const targetHash = canonicalHash(target);
  const writeBody = {
    action: 'listing.update_price',
    platform: 'pdd',
    listing_id: listing.id,
    payload,
    approval_id: approval.id,
    mode: 'dry_run' as const,
  };

  const noConfirm = await post('/api/listings/write', writeBody);
  assert.equal(noConfirm.statusCode, 409);
  assert.equal((noConfirm.json() as { error: { code: string } }).error.code, 'irreversible');
  assert.equal(await prisma.listingWriteLog.count({ where: { listingId: listing.id } }), 0);

  const tokenResponse = await post(`/api/listings/${listing.id}/confirm-token`, {
    action: 'listing.update_price',
    target_hash: targetHash,
  });
  assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
  const token = (tokenResponse.json() as {
    data: { confirm_token: string; level: string; timing_advice: { suggested_window: { start: string; end: string } } };
  }).data;
  assert.equal(token.level, 'C');
  assert.ok(token.timing_advice.suggested_window.start);
  assert.ok(token.timing_advice.suggested_window.end);

  const ok = await post('/api/listings/write', { ...writeBody, confirm_token: token.confirm_token });
  assert.equal(ok.statusCode, 200, ok.body);
  const okBody = ok.json() as { data: { level: string; compensating_ticket_id: string; write_id: string } };
  assert.equal(okBody.data.level, 'C');
  assert.ok(okBody.data.compensating_ticket_id);
  const ticket = await prisma.compensatingTicket.findUnique({
    where: { id: okBody.data.compensating_ticket_id },
  });
  assert.equal(ticket?.severity, 'high');

  // token 一次性：同 token 再次执行（即使内容相同）必须失败
  const reuse = await post('/api/listings/write', { ...writeBody, confirm_token: token.confirm_token });
  assert.equal(reuse.statusCode, 409);
  assert.equal((reuse.json() as { error: { code: string } }).error.code, 'irreversible');
});

test('伪回滚被代码拒绝：B/C 级写记录无 rollback 路径，且不接受 force', async () => {
  const { product, listing } = await makeListing();
  const target = publishTargetPayload({ product_id: product.id, platform: 'pdd', sku_ids: [], media_plan: {} });
  const approval = await createApproval({
    listingId: listing.id,
    action: 'publish',
    target,
    context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
  });
  const published = await post('/api/listings/publish', publishBody(product.id, approval.id));
  assert.equal(published.statusCode, 200, published.body);
  const writeId = (published.json() as { data: { write_id: string } }).data.write_id;

  const rollback = await post('/api/listings/rollback', {
    platform: 'pdd',
    listing_id: listing.id,
    write_id: writeId,
    expected_current_hash: 'a'.repeat(64),
    reason: '尝试用旧快照覆盖并声称已恢复原状',
  });
  assert.equal(rollback.statusCode, 409);
  assert.equal((rollback.json() as { error: { code: string } }).error.code, 'irreversible');

  const withForce = await post('/api/listings/rollback', {
    platform: 'pdd',
    listing_id: listing.id,
    write_id: writeId,
    expected_current_hash: 'a'.repeat(64),
    reason: '尝试强制覆盖写回旧值以绕过不可逆约束',
    force: true,
  });
  assert.equal(withForce.statusCode, 422);
  const log = await prisma.listingWriteLog.findUnique({ where: { id: writeId } });
  assert.equal(log?.restoredFromSnapshot, false);
  const rejectedAudit = await prisma.auditLog.findFirst({
    where: { action: 'listing.rollback_rejected', resourceId: listing.id },
    orderBy: { seq: 'desc' },
  });
  assert.ok(rejectedAudit);
});

test('kill switch 阻断写，关闭后恢复', async () => {
  const { product, listing } = await makeListing();
  const target = publishTargetPayload({ product_id: product.id, platform: 'pdd', sku_ids: [], media_plan: {} });
  const approval = await createApproval({
    listingId: listing.id,
    action: 'publish',
    target,
    context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
  });

  const created = await post(
    '/api/kill-switch',
    {
      scope_type: 'global',
      scope_key: '*',
      action: 'block_writes',
      mode: 'block',
      reason: 't9 验收：全局停写演练',
    },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const switchId = (created.json() as { data: { id: string } }).data.id;

  const blocked = await post('/api/listings/publish', publishBody(product.id, approval.id));
  assert.equal(blocked.statusCode, 503);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'kill_switch_on');
  assert.equal(await prisma.listingWriteLog.count({ where: { listingId: listing.id } }), 0);

  const disabled = await post(
    `/api/kill-switch/${switchId}/disable`,
    { reason: '演练结束，恢复写', confirm: true },
    adminHeaders,
  );
  assert.equal(disabled.statusCode, 200, disabled.body);
  const resumed = await post('/api/listings/publish', publishBody(product.id, approval.id));
  assert.equal(resumed.statusCode, 200, resumed.body);
});

test('1688 上架 dry-run 走 t5 adapter plan（blocked=true，不发网络）', async () => {
  const { product, listing } = await makeListing('1688');
  const target = publishTargetPayload({ product_id: product.id, platform: '1688', sku_ids: [], media_plan: {} });
  const approval = await createApproval({
    listingId: listing.id,
    action: 'publish',
    target,
    context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
    platform: '1688',
  });
  const response = await post('/api/listings/publish', publishBody(product.id, approval.id, '1688'));
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    data: { platform_response: { status: string; adapter: string; blocked: boolean } };
  };
  assert.equal(body.data.platform_response.status, 'dry_run');
  assert.equal(body.data.platform_response.adapter, '@dssaas/adapters-1688');
  assert.equal(body.data.platform_response.blocked, true);
});

test('死信重放：admin + 对账 + 审批有效 → 新建 run，旧 run 保持终态', async () => {
  const { product, listing } = await makeListing();
  const target = {
    action: 'listing.update_stock',
    platform: 'pdd',
    listing_id: listing.id,
    payload: { stock: 50 },
  };
  const targetHash = canonicalHash(target);
  const approval = await prisma.approval.create({
    data: {
      orgId: 1n,
      subjectType: 'listing',
      subjectId: listing.id,
      action: 'update_stock',
      platform: 'pdd',
      operationLevel: 'A',
      status: 'approved',
      decision: 'approve',
      decidedBy: admin.id,
      decidedAt: new Date(),
      targetHash,
      expiresAt: new Date(Date.now() + 3600_000),
      requestId: 'req-t9-replay',
      createdBy: operator.id,
    },
  });
  const writeKey = 'd'.repeat(64);
  const oldRun = await prisma.workflowRun.create({
    data: {
      orgId: 1n,
      type: 'stock_sync',
      state: 'failed_permanent',
      stage: 'stock',
      subjectType: 'listing',
      subjectId: listing.id,
      idempotencyKey: writeKey,
      attempt: 1,
      maxAttempts: 5,
      payload: {
        action: 'listing.update_stock',
        platform: 'pdd',
        approval_id: approval.id,
        target_hash: targetHash,
      },
      result: { failure_class: 'retryable' },
      errorClass: 'retryable',
      errorCode: 'upstream_5xx',
      requestId: 'req-t9-replay',
      createdBy: operator.id,
      finishedAt: new Date(),
    },
  });
  const deadLetter = await prisma.workflowDeadLetter.create({
    data: {
      orgId: 1n,
      workflowRunId: oldRun.id,
      reason: 'retryable:upstream_5xx',
      payload: { write_key: writeKey },
      replayable: true,
      createdBy: operator.id,
    },
  });
  await prisma.idempotencyKey.create({
    data: {
      orgId: 1n,
      scope: 'write',
      key: writeKey,
      requestHash: 'b'.repeat(64),
      status: 'failed',
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: operator.id,
    },
  });

  const replay = await post(
    `/api/workflow/runs/${oldRun.id}/replay`,
    {
      reason: '平台 5xx 后已对账确认未生效，申请重放',
      reconciled: true,
      reconcile_note: '平台查询确认无商品写入',
    },
    adminHeaders,
  );
  assert.equal(replay.statusCode, 200, replay.body);
  const body = replay.json() as { data: { old_run_id: string; new_run_id: string; state: string } };
  assert.equal(body.data.old_run_id, oldRun.id);
  assert.equal(body.data.state, 'pending');
  const newRun = await prisma.workflowRun.findUnique({ where: { id: body.data.new_run_id } });
  assert.equal(newRun?.parentRunId, oldRun.id);
  assert.equal(newRun?.state, 'pending');
  const oldAfter = await prisma.workflowRun.findUnique({ where: { id: oldRun.id } });
  assert.equal(oldAfter?.state, 'failed_permanent');
  const deadAfter = await prisma.workflowDeadLetter.findUnique({ where: { id: deadLetter.id } });
  assert.ok(deadAfter?.replayedAt);
});

test('workflow 七态与失败分类：非法跳转拒绝，429/5xx→retryable，审批/幂等→guard', () => {
  assert.equal(canTransition('pending', 'running'), true);
  assert.equal(canTransition('succeeded', 'running'), false);
  assert.equal(canTransition('failed_permanent', 'running'), false);
  assert.equal(classifyFailure({ code: 'upstream_5xx' }).failureClass, 'retryable');
  assert.equal(classifyFailure({ httpStatus: 429 }).failureClass, 'retryable');
  assert.equal(classifyFailure({ code: 'approval_required' }).failureClass, 'guard');
  assert.equal(classifyFailure({ code: 'idempotency_conflict' }).failureClass, 'guard');
  assert.equal(classifyFailure({ code: 'platform_reject' }).failureClass, 'manual');
  assert.equal(classifyFailure({ code: 'unverified_interface' }).failureClass, 'permanent');
  assert.equal(computeLevel('listing.update_price', { listingStatus: 'published' }).level, 'C');
  assert.equal(
    computeLevel('listing.create', { listingStatus: 'draft', firstPublish: true, notOnline: true }).level,
    'B',
  );
});

test('重放前置条件：C 级/不可逆/未对账/非 admin 均拒绝；合法 retryable 通过', () => {
  const base = {
    runState: 'failed_permanent' as const,
    failureClass: 'retryable' as const,
    repairHintsClosed: true,
    killSwitchBlocked: false,
    approvalStatus: 'approved',
    approvalExpiresAt: new Date(Date.now() + 3600_000),
    approvalTargetHash: 'a'.repeat(64),
    currentTargetHash: 'a'.repeat(64),
    reconciled: true,
    reconcileNote: '平台查询确认未生效',
    idempotencyStatus: 'failed',
    actorRole: 'admin',
    replayReason: '平台 5xx 后已对账确认未生效，申请重放',
    level: 'B',
    irreversibleSideEffect: false,
    alreadyReplayed: false,
  };
  assert.equal(validateReplayPreconditions(base).ok, true);
  assert.equal(validateReplayPreconditions({ ...base, level: 'C' }).ok, false);
  assert.equal(validateReplayPreconditions({ ...base, reconciled: false }).ok, false);
  assert.equal(validateReplayPreconditions({ ...base, actorRole: 'operator' }).ok, false);
  assert.equal(validateReplayPreconditions({ ...base, irreversibleSideEffect: true }).ok, false);
  assert.equal(validateReplayPreconditions({ ...base, killSwitchBlocked: true }).ok, false);
  assert.equal(validateReplayPreconditions({ ...base, idempotencyStatus: 'succeeded' }).ok, false);
});
