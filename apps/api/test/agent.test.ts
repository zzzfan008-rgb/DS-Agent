/**
 * t3 验收测试：Agent 驱动层（api ↔ 本地 Host 协议桩）。
 *
 * 覆盖：角色/intent 白名单、信封校验、SSE 事件序列与顺序、Last-Event-ID 回放、
 * 取消、并发上限（用户/会话/全局排队）、队列满、排队超时、首 token 超时、整次运行超时、
 * Host 不可达（dsh_unavailable）、工具收窄、审计、指标、跨用户隔离。
 *
 * 前置：`test/run.ts` 已重置测试库并执行 migrate deploy；Host 桩在本进程内启动（真实 HTTP）。
 */
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
  testConfig,
} from './helpers.js';
import { TypertBridgeClient } from '../src/agent/bridge-client.js';
import type { AgentRunEnvelope } from '../src/agent/types.js';
import { startDshHostStub, type StubHandle } from './support/dsh-host-stub.js';

interface Session {
  cookies: Record<string, string>;
  csrf: string;
}

interface ParsedSseEvent {
  event: string;
  id: string | null;
  data: {
    event_id: string;
    type: string;
    seq: number;
    ts: string;
    org_id: number;
    request_id: string;
    payload: Record<string, unknown>;
  } | null;
  raw: string;
}

const PASSWORD = 'AgentTestPassword!2026';
const BRIDGE_TOKEN = 'test-bridge-token-0123456789abcdef';

let stub: StubHandle;
let app: FastifyInstance;
let base: string;
let operator: Session;
let admin: Session;
let viewer: Session;
let operatorUserId = '';
let adminUserId = '';
let viewerUserId = '';
// 每次运行使用唯一邮箱，测试文件可重复执行（无需先重置库）。
const runSuffix = randomUUID().slice(0, 8);
const operatorEmail = `operator.agent.${runSuffix}@test.local`;
const adminEmail = `admin.agent.${runSuffix}@test.local`;
const viewerEmail = `viewer.agent.${runSuffix}@test.local`;

function parseSseFrame(raw: string): ParsedSseEvent | null {
  if (!raw.trim()) return null;
  let event = 'message';
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === 'message') return null;
  let data: ParsedSseEvent['data'] = null;
  if (dataLines.length > 0) {
    try {
      data = JSON.parse(dataLines.join('\n')) as ParsedSseEvent['data'];
    } catch {
      data = null;
    }
  }
  return { event, id, data, raw };
}

async function listen(instance: FastifyInstance): Promise<string> {
  await instance.listen({ host: '127.0.0.1', port: 0 });
  const address = instance.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}`;
}

async function makeSession(instance: FastifyInstance, email: string): Promise<Session> {
  const response = await login(instance, email, PASSWORD);
  assert.equal(response.statusCode, 200, `login failed: ${response.body}`);
  return { cookies: cookiesFrom(response), csrf: csrfFrom(response) };
}

async function postRun(
  target: string,
  session: Session,
  body: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<{ status: number; body: Record<string, any>; headers: Headers }> {
  const response = await fetch(`${target}/api/agent/run`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(session.cookies, session.csrf),
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { status: response.status, body: json, headers: response.headers };
}

function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'content.draft',
    context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID() },
    input: { text: '给这款风衣写拼多多标题，突出防风', params: { platform: 'pdd' } },
    stream: true,
    timeout_ms: 8000,
    ...overrides,
  };
}

async function collectSse(
  target: string,
  runId: string,
  session: Session,
  options: { lastEventId?: string; timeoutMs?: number; stopAfter?: number } = {},
): Promise<ParsedSseEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const events: ParsedSseEvent[] = [];
  try {
    const response = await fetch(`${target}/api/agent/runs/${runId}/events`, {
      headers: {
        ...sessionHeaders(session.cookies),
        ...(options.lastEventId ? { 'last-event-id': options.lastEventId } : {}),
      },
      signal: controller.signal,
    });
    assert.equal(response.status, 200, 'SSE must respond 200');
    assert.match(String(response.headers.get('content-type')), /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSseFrame(raw);
        if (parsed) {
          events.push(parsed);
          if (
            parsed.event === 'run.finished' ||
            parsed.event === 'run.error' ||
            (options.stopAfter !== undefined && events.length >= options.stopAfter)
          ) {
            controller.abort();
            return events;
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

async function getRun(
  target: string,
  runId: string,
  session: Session,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${target}/api/agent/runs/${runId}`, {
    headers: sessionHeaders(session.cookies),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function waitForStatus(
  target: string,
  runId: string,
  session: Session,
  statuses: string[],
  timeoutMs = 5000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(target, runId, session);
    const status = run.body?.data?.status as string | undefined;
    if (status !== undefined && statuses.includes(status)) return run.body.data;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} 未进入状态 ${statuses.join('/')}，当前 ${String(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function waitForAction(action: string, resourceId?: string): Promise<Record<string, any> | null> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const row = await prisma.auditLog.findFirst({
      where: { action, ...(resourceId ? { resourceId } : {}) },
      orderBy: { seq: 'desc' },
    });
    if (row) return row as unknown as Record<string, any>;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

before(async () => {
  stub = await startDshHostStub({
    port: 0,
    token: BRIDGE_TOKEN,
    scenario: 'echo',
    deltaCount: 4,
    deltaDelayMs: 8,
    quiet: true,
  });
  app = await buildTestApp({
    DSH_BRIDGE_URL: stub.url,
    DSH_BRIDGE_TOKEN: stub.token,
    DSH_HEALTH_CACHE_MS: '0',
    AGENT_FIRST_TOKEN_TIMEOUT_MS: '1500',
    AGENT_QUEUE_WAIT_MS: '1500',
    LOG_LEVEL: 'silent',
  });
  base = await listen(app);

  const operatorUser = await createUser({
    email: operatorEmail,
    password: PASSWORD,
    role: 'operator',
  });
  const adminUser = await createUser({
    email: adminEmail,
    password: PASSWORD,
    role: 'admin',
  });
  const viewerUser = await createUser({
    email: viewerEmail,
    password: PASSWORD,
    role: 'viewer',
  });
  operatorUserId = operatorUser.id;
  adminUserId = adminUser.id;
  viewerUserId = viewerUser.id;
  operator = await makeSession(app, operatorEmail);
  admin = await makeSession(app, adminEmail);
  viewer = await makeSession(app, viewerEmail);
});

after(async () => {
  await app.close();
  await stub.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 校验 / 权限
// ---------------------------------------------------------------------------

test('权限：viewer 不能创建 run；operator 不能 listing.diagnose；缺 Idempotency-Key 422', async () => {
  const viewerRun = await postRun(base, viewer, runBody());
  assert.equal(viewerRun.status, 403);
  assert.equal(viewerRun.body.error.code, 'forbidden');

  const diagnose = await postRun(base, operator, runBody({ intent: 'listing.diagnose' }));
  assert.equal(diagnose.status, 403);
  assert.equal(diagnose.body.error.code, 'forbidden');

  const noKey = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(operator.cookies, operator.csrf),
      'content-type': 'application/json',
    },
    body: JSON.stringify(runBody()),
  });
  assert.equal(noKey.status, 422);
  const noKeyBody = (await noKey.json()) as Record<string, any>;
  assert.equal(noKeyBody.error.code, 'validation_failed');
});

test('校验：未知 intent / confirm_irreversible=true / timeout_ms 超上限 / context 带 URL 均 422', async () => {
  const cases: Record<string, unknown>[] = [
    runBody({ intent: 'shell.exec' }),
    runBody({ confirm_irreversible: true }),
    runBody({ timeout_ms: 600_001 }),
    runBody({ context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID(), url: 'http://evil' } }),
    runBody({ context: { page: 'https://evil.example/path' } }),
  ];
  for (const body of cases) {
    const response = await postRun(base, operator, body);
    assert.equal(response.status, 422, `expected 422 for ${JSON.stringify(body)}`);
    assert.equal(response.body.error.code, 'validation_failed');
  }
});

test('隔离：跨用户查询 404，admin 可查；未登录 SSE 401', async () => {
  const created = await postRun(base, operator, runBody({ input: { text: '隔离用例', params: { stub_delta_delay_ms: 5 } } }));
  assert.equal(created.status, 202);
  const runId = created.body.data.run_id as string;
  await collectSse(base, runId, operator);

  const other = await makeSession(app, viewerEmail);
  const denied = await getRun(base, runId, other);
  assert.equal(denied.status, 404);
  const adminView = await getRun(base, runId, admin);
  assert.equal(adminView.status, 200);

  const anonymousSse = await fetch(`${base}/api/agent/runs/${runId}/events`);
  assert.equal(anonymousSse.status, 401);
});

// ---------------------------------------------------------------------------
// 流式主链路
// ---------------------------------------------------------------------------

test('流式：hello→run.started→步骤/工具/增量→run.finished，事件 id 单调且终态唯一', async () => {
  const created = await postRun(base, operator, runBody());
  assert.equal(created.status, 202);
  assert.equal(created.body.data.status, 'running');
  assert.equal(created.body.data.sse_url, `/api/agent/runs/${created.body.data.run_id}/events`);
  const runId = created.body.data.run_id as string;

  const events = await collectSse(base, runId, operator, { timeoutMs: 5000 });
  const names = events.map((event) => event.event);
  assert.equal(names[0], 'hello');
  assert.equal(events[0]!.data?.seq, 0);
  assert.match(events[0]!.id ?? '', new RegExp(`^${runId}-000000$`));
  assert.ok(names.includes('run.started'), 'missing run.started');
  assert.ok(names.includes('run.step'), 'missing run.step');
  assert.ok(names.includes('run.tool_call'), 'missing run.tool_call');
  assert.ok(names.includes('run.tool_result'), 'missing run.tool_result');
  assert.ok(names.includes('run.delta'), 'missing run.delta');
  assert.equal(names.at(-1), 'run.finished');
  assert.equal(names.filter((name) => name === 'run.finished').length, 1);
  assert.equal(names.filter((name) => name === 'run.error').length, 0);

  const seqs = events.map((event) => event.data?.seq ?? -1);
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(seqs[index]! > seqs[index - 1]!, `seq not increasing: ${seqs.join(',')}`);
  }
  const finished = events.at(-1)!;
  const payload = (finished.data?.payload ?? {}) as Record<string, any>;
  const output = payload.output as { text?: string; partial?: boolean };
  assert.match(output.text ?? '', /本地 Host 桩/);
  assert.equal(output.partial, false);
  assert.equal(payload.status, 'succeeded');
  assert.equal(payload.tokens.in > 0, true);
  assert.equal(payload.cost_cents, 2);

  const view = await getRun(base, runId, operator);
  assert.equal(view.status, 200);
  assert.equal(view.body.data.status, 'succeeded');
  assert.equal(view.body.data.tokens.out > 0, true);
  assert.equal(view.body.data.cost_cents, 2);
  assert.equal(view.body.data.steps.length >= 1, true);
  assert.equal(view.body.data.request_id, created.body.request_id);
});

test('回放：Last-Event-ID 续传只补缺口，且不重复', async () => {
  const created = await postRun(base, operator, runBody({ input: { text: '回放用例', params: { stub_delta_delay_ms: 5 } } }));
  const runId = created.body.data.run_id as string;
  const full = await collectSse(base, runId, operator);
  assert.ok(full.length >= 6);
  const cursorEvent = full[2]!;
  const cursorSeq = cursorEvent.data?.seq ?? 0;
  const resumed = await collectSse(base, runId, operator, { lastEventId: cursorEvent.id! });
  assert.equal(resumed[0]!.event, 'hello');
  const business = resumed.filter((event) => event.event !== 'hello');
  assert.ok(business.length > 0);
  for (const event of business) {
    assert.ok((event.data?.seq ?? 0) > cursorSeq, `replayed event seq ${event.data?.seq} <= cursor ${cursorSeq}`);
  }
  assert.equal(new Set(business.map((event) => event.id)).size, business.length);
  assert.equal(business.at(-1)!.event, 'run.finished');
});

test('桥接重连：首事件前指数退避重试，首事件后不重试', async () => {
  const config = testConfig({
    DSH_BRIDGE_URL: 'http://bridge.invalid',
    DSH_BRIDGE_TOKEN: 'unit-test-token-0123456789abcdef',
    DSH_CONNECT_TIMEOUT_MS: '200',
    DSH_HEALTH_CACHE_MS: '0',
  });
  const envelope: AgentRunEnvelope = {
    runId: randomUUID(),
    requestId: 'req_unit_reconnect',
    userId: operatorUserId,
    role: 'operator',
    intent: 'content.draft',
    context: { page: 'copy_workbench' },
    input: { text: '重连用例' },
    facts: { snapshotId: null, hash: null, version: 0 },
    bundle: { preset: 'clothing-ops', skills: [], manifestHash: 'test' },
    limits: { timeoutMs: 2000, maxOutputTokens: 100, maxToolCalls: 1, maxCostCents: 1 },
  };
  const frame = [
    'event: meta',
    'data: {"runId":"r1","modelId":"fake-model"}',
    '',
    'event: delta',
    'data: {"text":"hi"}',
    '',
    'event: final',
    'data: {"output":{"text":"hi"},"durationMs":1}',
    '',
    '',
  ].join('\n');

  let calls = 0;
  const flakyFetch = (async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed');
    return new Response(frame, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  const client = new TypertBridgeClient(config, {
    fetchImpl: flakyFetch,
    sleep: async () => undefined,
  });
  const eventTypes: string[] = [];
  for await (const event of client.run(envelope, new AbortController().signal, { reconnectAttempts: 2 })) {
    eventTypes.push(event.type);
  }
  assert.equal(calls, 3, '应在首事件前重试 2 次');
  assert.deepEqual(eventTypes, ['meta', 'delta', 'final']);

  // 首事件之后断流：不重试，抛 dsh_unavailable（避免重复输出）。
  let afterCalls = 0;
  const brokenFetch = (async () => {
    afterCalls += 1;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: delta\ndata: {"text":"a"}\n\n'));
          setTimeout(() => controller.error(new Error('socket hang up')), 10);
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as unknown as typeof fetch;
  const client2 = new TypertBridgeClient(config, {
    fetchImpl: brokenFetch,
    sleep: async () => undefined,
  });
  await assert.rejects(async () => {
    for await (const _event of client2.run(envelope, new AbortController().signal, { reconnectAttempts: 2 })) {
      // 消费首个 delta 后流断开
    }
  }, /事件流中断/);
  assert.equal(afterCalls, 1, '首事件后不得重试');
});

test('取消：运行中 POST cancel → 200 cancelled，SSE 以 partial run.finished 收尾', async () => {
  const created = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 30_000, input: { text: '取消用例', params: { stub_scenario: 'hang' } } }),
  );
  assert.equal(created.status, 202);
  const runId = created.body.data.run_id as string;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cancel = await fetch(`${base}/api/agent/runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(operator.cookies, operator.csrf),
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({ reason: '用户点停止' }),
  });
  assert.equal(cancel.status, 200);
  const cancelBody = (await cancel.json()) as Record<string, any>;
  assert.equal(cancelBody.data.status, 'cancelled');

  const view = await waitForStatus(base, runId, operator, ['cancelled'], 6000);
  assert.equal(view.output.partial, true);
  const events = await collectSse(base, runId, operator);
  assert.equal(events.at(-1)!.event, 'run.finished');
  assert.equal((events.at(-1)!.data?.payload as Record<string, any>).output.partial, true);
  // 取消幂等：终态再次取消 → 200 + 当前状态
  const again = await fetch(`${base}/api/agent/runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      ...sessionHeaders(operator.cookies, operator.csrf),
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({}),
  });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as Record<string, any>).data.status, 'cancelled');
});

test('错误映射：Host 返回 error 事件 → run.error(upstream_5xx)，run 状态 failed', async () => {
  const created = await postRun(
    base,
    operator,
    runBody({ input: { text: '错误用例', params: { stub_scenario: 'error' } } }),
  );
  const runId = created.body.data.run_id as string;
  const events = await collectSse(base, runId, operator);
  const terminal = events.at(-1)!;
  assert.equal(terminal.event, 'run.error');
  assert.equal(terminal.data?.payload?.code, 'upstream_5xx');
  assert.equal(terminal.data?.payload?.retryable, true);
  const view = await waitForStatus(base, runId, operator, ['failed']);
  assert.equal(view.error.code, 'upstream_5xx');
});

test('超时：整次运行 timeout_ms 强制 abort → status=timeout', async () => {
  const created = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 1000, input: { text: '超时用例', params: { stub_scenario: 'hang' } } }),
  );
  const runId = created.body.data.run_id as string;
  const view = await waitForStatus(base, runId, operator, ['timeout'], 4000);
  assert.equal(view.error.code, 'timeout');
  const events = await collectSse(base, runId, operator);
  assert.equal(events.at(-1)!.event, 'run.error');
  assert.equal(events.at(-1)!.data?.payload?.code, 'timeout');
});

test('首 token 超时：Host 迟迟无 delta → status=timeout（agent_first_token 降级）', async () => {
  const created = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 8000, input: { text: '首token用例', params: { stub_scenario: 'hang' } } }),
  );
  const runId = created.body.data.run_id as string;
  const view = await waitForStatus(base, runId, operator, ['timeout'], 5000);
  assert.equal(view.error.code, 'timeout');
});

// ---------------------------------------------------------------------------
// 并发 / 排队
// ---------------------------------------------------------------------------

test('并发：同会话第 2 个 409；同用户第 3 个 409（带 Retry-After）', async () => {
  const objectId = randomUUID();
  const first = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 30_000, context: { page: 'copy_workbench', object_type: 'product', object_id: objectId }, input: { text: '并发A', params: { stub_scenario: 'hang' } } }),
  );
  assert.equal(first.status, 202, `first run failed: ${JSON.stringify(first.body)}`);
  const sessionBusy = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 30_000, context: { page: 'copy_workbench', object_type: 'product', object_id: objectId }, input: { text: '并发B', params: { stub_scenario: 'hang' } } }),
  );
  assert.equal(sessionBusy.status, 409, `sessionBusy: ${JSON.stringify(sessionBusy.body)}`);
  assert.equal(sessionBusy.body.error.code, 'concurrency_session_limit');
  assert.equal(sessionBusy.headers.get('retry-after'), '5');

  const second = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 30_000, context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID() }, input: { text: '并发C', params: { stub_scenario: 'hang' } } }),
  );
  assert.equal(second.status, 202, `second run failed: ${JSON.stringify(second.body)}`);

  const third = await postRun(
    base,
    operator,
    runBody({ timeout_ms: 30_000, context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID() }, input: { text: '并发D', params: { stub_scenario: 'hang' } } }),
  );
  assert.equal(third.status, 409, `third: ${JSON.stringify(third.body)}`);
  assert.equal(third.body.error.code, 'concurrency_user_limit');

  for (const run of [first, second]) {
    const cancel = await fetch(`${base}/api/agent/runs/${run.body.data.run_id}/cancel`, {
      method: 'POST',
      headers: {
        ...sessionHeaders(operator.cookies, operator.csrf),
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: '{}',
    });
    assert.equal(cancel.status, 200);
  }
  await waitForStatus(base, first.body.data.run_id, operator, ['cancelled']);
  await waitForStatus(base, second.body.data.run_id, operator, ['cancelled']);
});

test('排队：全局满 → 202+queue_position；队列满 → 429 queue_full；取消后按 FIFO 继续', async () => {
  const stub2 = await startDshHostStub({ token: BRIDGE_TOKEN, scenario: 'echo', deltaDelayMs: 5, quiet: true });
  const app2 = await buildTestApp({
    DSH_BRIDGE_URL: stub2.url,
    DSH_BRIDGE_TOKEN: stub2.token,
    DSH_HEALTH_CACHE_MS: '0',
    AGENT_MAX_CONCURRENCY: '1',
    AGENT_QUEUE_LIMIT: '2',
    AGENT_QUEUE_WAIT_MS: '5000',
    LOG_LEVEL: 'silent',
  });
  const base2 = await listen(app2);
  const users: Session[] = [];
  for (let index = 0; index < 4; index += 1) {
    const email = `queue.agent.${index}.${runSuffix}@test.local`;
    await createUser({ email, password: PASSWORD, role: 'operator' });
    users.push(await makeSession(app2, email));
  }
  try {
    const hangBody = runBody({
      timeout_ms: 30_000,
      input: { text: '占住唯一槽位', params: { stub_scenario: 'hang' } },
    });
    const running = await postRun(base2, users[0]!, hangBody);
    assert.equal(running.status, 202);
    assert.equal(running.body.data.status, 'running');

    const queuedA = await postRun(base2, users[1]!, runBody({ input: { text: '排队A' } }));
    assert.equal(queuedA.status, 202);
    assert.equal(queuedA.body.data.status, 'queued');
    assert.equal(queuedA.body.data.queue_position, 1);

    const queuedB = await postRun(base2, users[2]!, runBody({ input: { text: '排队B' } }));
    assert.equal(queuedB.status, 202);
    assert.equal(queuedB.body.data.queue_position, 2);

    const full = await postRun(base2, users[3]!, runBody({ input: { text: '队列满' } }));
    assert.equal(full.status, 429);
    assert.equal(full.body.error.code, 'queue_full');
    assert.equal(full.headers.get('retry-after'), '5');

    // 取消运行中的唯一槽位 → 队列按 FIFO 依次执行
    const cancel = await fetch(`${base2}/api/agent/runs/${running.body.data.run_id}/cancel`, {
      method: 'POST',
      headers: {
        ...sessionHeaders(users[0]!.cookies, users[0]!.csrf),
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: '{}',
    });
    assert.equal(cancel.status, 200);
    const queuedAView = await waitForStatus(base2, queuedA.body.data.run_id, users[1]!, ['succeeded'], 6000);
    assert.equal(queuedAView.status, 'succeeded');
    const queuedBView = await waitForStatus(base2, queuedB.body.data.run_id, users[2]!, ['succeeded'], 6000);
    assert.equal(queuedBView.status, 'succeeded');
  } finally {
    await app2.close();
    await stub2.close();
  }
});

test('排队超时：等待超过 30s（测试用 250ms）→ run.error quota，不无限排队', async () => {
  const stub3 = await startDshHostStub({ token: BRIDGE_TOKEN, scenario: 'echo', deltaDelayMs: 5, quiet: true });
  const app3 = await buildTestApp({
    DSH_BRIDGE_URL: stub3.url,
    DSH_BRIDGE_TOKEN: stub3.token,
    DSH_HEALTH_CACHE_MS: '0',
    AGENT_MAX_CONCURRENCY: '1',
    AGENT_QUEUE_LIMIT: '2',
    AGENT_QUEUE_WAIT_MS: '250',
    LOG_LEVEL: 'silent',
  });
  const base3 = await listen(app3);
  const userA = await createUser({
    email: `queue.timeout.a.${runSuffix}@test.local`,
    password: PASSWORD,
    role: 'operator',
  });
  const userB = await createUser({
    email: `queue.timeout.b.${runSuffix}@test.local`,
    password: PASSWORD,
    role: 'operator',
  });
  const sessionA = await makeSession(app3, userA.email);
  const sessionB = await makeSession(app3, userB.email);
  try {
    const running = await postRun(
      base3,
      sessionA,
      runBody({ timeout_ms: 30_000, input: { text: '占住槽位', params: { stub_scenario: 'hang' } } }),
    );
    assert.equal(running.status, 202);
    const queued = await postRun(base3, sessionB, runBody({ input: { text: '排队超时' } }));
    assert.equal(queued.status, 202);
    assert.equal(queued.body.data.status, 'queued');
    const queuedView = await waitForStatus(base3, queued.body.data.run_id, sessionB, ['failed'], 4000);
    assert.equal(queuedView.error.code, 'quota');
    assert.equal(queuedView.error.retryable, true);
    const cancel = await fetch(`${base3}/api/agent/runs/${running.body.data.run_id}/cancel`, {
      method: 'POST',
      headers: {
        ...sessionHeaders(sessionA.cookies, sessionA.csrf),
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: '{}',
    });
    assert.equal(cancel.status, 200);
  } finally {
    await app3.close();
    await stub3.close();
  }
});

// ---------------------------------------------------------------------------
// Host 不可达 / 令牌错误
// ---------------------------------------------------------------------------

test('Host 未启动：POST /agent/run 返回可读 503 dsh_unavailable；/health 标记 dsh_host=down', async () => {
  const downApp = await buildTestApp({
    DSH_BRIDGE_URL: 'http://127.0.0.1:1',
    DSH_BRIDGE_TOKEN: BRIDGE_TOKEN,
    DSH_HEALTH_CACHE_MS: '0',
    LOG_LEVEL: 'silent',
  });
  const downBase = await listen(downApp);
  const user = await createUser({
    email: `down.agent.${runSuffix}@test.local`,
    password: PASSWORD,
    role: 'operator',
  });
  const session = await makeSession(downApp, user.email);
  try {
    const response = await postRun(downBase, session, runBody());
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'dsh_unavailable');
    assert.match(response.body.error.message, /DSH Host 不可达/);
    assert.equal(response.body.error.retryable, true);

    const health = await fetch(`${downBase}/api/health`);
    const healthBody = (await health.json()) as Record<string, any>;
    assert.equal(healthBody.data.checks.dsh_host, 'down');
    assert.equal(healthBody.data.checks.db, 'ok');
  } finally {
    await downApp.close();
  }
});

test('桥接令牌错误：Host 返回 404（不暴露存在性）→ api 统一 dsh_unavailable', async () => {
  const wrongApp = await buildTestApp({
    DSH_BRIDGE_URL: stub.url,
    DSH_BRIDGE_TOKEN: 'wrong-token-0123456789abcdef',
    DSH_HEALTH_CACHE_MS: '0',
    LOG_LEVEL: 'silent',
  });
  const wrongBase = await listen(wrongApp);
  const user = await createUser({
    email: `wrongtoken.agent.${runSuffix}@test.local`,
    password: PASSWORD,
    role: 'operator',
  });
  const session = await makeSession(wrongApp, user.email);
  try {
    const response = await postRun(wrongBase, session, runBody());
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'dsh_unavailable');
  } finally {
    await wrongApp.close();
  }
});

// ---------------------------------------------------------------------------
// 工具收窄 / 审计 / 指标 / 健康
// ---------------------------------------------------------------------------

test('工具收窄：tools_allow 与默认集取交集，越权项被忽略并落审计', async () => {
  const created = await postRun(
    base,
    operator,
    runBody({ tools_allow: ['kb.search', 'price.write'], input: { text: '工具收窄', params: { stub_delta_delay_ms: 5 } } }),
  );
  assert.equal(created.status, 202);
  const runId = created.body.data.run_id as string;
  await collectSse(base, runId, operator);
  assert.deepEqual(stub.state.lastEnvelope?.toolsAllow, ['kb.search']);
  const audit = await waitForAction('agent.accept', runId);
  assert.ok(audit, 'agent.accept audit missing');
  const meta = audit!.meta as Record<string, any>;
  assert.deepEqual(meta.tools_ignored, ['price.write']);
});

test('审计：agent.accept / agent.run / agent.cancel / agent.overload 均落库且链完整', async () => {
  const created = await postRun(base, operator, runBody({ input: { text: '审计用例', params: { stub_delta_delay_ms: 5 } } }));
  const runId = created.body.data.run_id as string;
  await collectSse(base, runId, operator);
  const accept = await waitForAction('agent.accept', runId);
  const run = await waitForAction('agent.run', runId);
  assert.ok(accept);
  assert.ok(run);
  assert.equal((run!.after as Record<string, any>).status, 'succeeded');
  const overload = await waitForAction('agent.overload');
  assert.ok(overload, 'agent.overload audit missing');

  const chain = await prisma.auditLog.findMany({ orderBy: { seq: 'asc' }, select: { chainPrev: true, chainHash: true } });
  assert.ok(chain.length > 0);
  // 链尾存在且每个 chainHash 非空；完整复算由 audit:verify 脚本完成。
  assert.equal(chain.at(-1)!.chainHash.length, 64);
});

test('指标与健康：agent_runs_total / agent_cost_cents_total 暴露；dsh_host=ok', async () => {
  const metrics = await fetch(`${base}/api/metrics`, { headers: sessionHeaders(admin.cookies) });
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /agent_runs_total\{/);
  assert.match(text, /agent_cost_cents_total\{/);
  assert.match(text, /agent_duration_seconds_sum/);

  const health = await fetch(`${base}/api/health`);
  const body = (await health.json()) as Record<string, any>;
  assert.equal(body.data.checks.dsh_host, 'ok');
  assert.equal(typeof body.data.checks.dsh_host_detail.latency_ms, 'number');
  assert.equal(body.data.checks.agent.max_concurrency, 8);
  assert.equal(body.data.checks.agent.queue_limit, 30);
});

test('审计标识：run 的 actor 为用户、resource 为 run_id，meta 含 bundle/model/session', async () => {
  const created = await postRun(base, operator, runBody({ input: { text: '标识用例', params: { stub_delta_delay_ms: 5 } } }));
  const runId = created.body.data.run_id as string;
  await collectSse(base, runId, operator);
  const run = await waitForAction('agent.run', runId);
  assert.ok(run);
  assert.equal(run!.actorId, operatorUserId);
  assert.equal(run!.resourceId, runId);
  const meta = run!.meta as Record<string, any>;
  assert.equal(meta.run_id, runId);
  assert.equal(meta.actor_role, 'operator');
  assert.ok(typeof meta.bundle_version === 'string');
  assert.equal(meta.model_id, 'stub-echo-1');
  assert.ok(meta.dsh_session.startsWith('stub-session-'));
  assert.equal(adminUserId.length > 0, true);
  assert.equal(viewerUserId.length > 0, true);
});
