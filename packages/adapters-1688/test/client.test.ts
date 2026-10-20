/**
 * 客户端骨架单测 —— 签名端口 / 限流 / 重试 / 留档 / 录制回放。
 *
 * 关键断言：**契约未核验时不允许发出任何真实请求**（docs/02 §0 硬规则）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  Alibaba1688Client,
  createClient,
  type ClientOptions,
} from '../src/client/client.js';
import type { OperationCatalog, OperationDescriptor } from '../src/client/registry.js';
import { getOperation, verificationGaps } from '../src/client/registry.js';
import { ASSUMED_CLIENT_RATE_LIMIT, TokenBucketRateLimiter } from '../src/client/limiter.js';
import { policyForOperation, DEFAULT_RETRY_POLICY, parseRetryAfter } from '../src/client/retry.js';
import {
  MemoryArchiveSink,
  DirectoryArchiveSink,
  archiveRequest,
  redactBody,
  redactUrl,
} from '../src/client/archive.js';
import { UNVERIFIED_SIGNER } from '../src/client/signature.js';
import { AdapterError } from '../src/errors.js';
import {
  FakeTransport,
  FixedClock,
  ForbiddenTransport,
  SeededRandom,
  createTestSigner,
  jsonResponse,
  type TransportHandler,
} from '../src/testing/fakes.js';
import {
  ReplayTransport,
  RecordingTransport,
  assertFixtureHonesty,
  fixturePath,
  loadFixtures,
  saveFixture,
} from '../src/testing/fixtures.js';
import type { HttpRequest } from '../src/client/types.js';

const PROBE: OperationDescriptor = {
  id: 'contract.probe',
  title: '契约探针（仅测试）',
  capability: 'item',
  docRef: 'test-only',
  channel: 'api',
  actionCode: 'listing.update_stock',
  riskLevel: 'A',
  irreversible: false,
  method: 'test.echo',
  httpMethod: 'POST',
  path: '/router/rest',
  paramsIn: 'body',
  bodyFormat: 'json',
  signatureRequired: true,
  todoIds: [],
  notes: '合成的测试探针，不是平台 method；仅用于验证管线',
};

const PROBE_CATALOG: OperationCatalog = { get: (id) => (id === PROBE.id ? PROBE : undefined) };

const FAST_LIMIT = {
  capacity: 100,
  refillPerSecond: 100,
  source: 'verified' as const,
  note: '测试用',
  maxWaitMs: 5_000,
};

interface Harness {
  client: Alibaba1688Client;
  transport: FakeTransport;
  archive: MemoryArchiveSink;
  clock: FixedClock;
}

function harness(handler: TransportHandler, overrides: Partial<ClientOptions> = {}): Harness {
  const clock = new FixedClock();
  const transport = new FakeTransport(handler);
  const archive = new MemoryArchiveSink();
  const client = new Alibaba1688Client({
    transport,
    signer: createTestSigner(),
    archive,
    clock,
    random: new SeededRandom(42),
    catalog: PROBE_CATALOG,
    baseUrl: 'https://example.invalid',
    limiterConfig: FAST_LIMIT,
    ...overrides,
  });
  return { client, transport, archive, clock };
}

const fail = (error: unknown): AdapterError => {
  assert.ok(error instanceof AdapterError, `期望 AdapterError，收到 ${String(error)}`);
  return error;
};

test('真实注册表：所有 API 操作 method 为 null，缺口按 TODO 分类', () => {
  for (const id of ['item.publish', 'order.list', 'message.send']) {
    const descriptor = getOperation(id);
    assert.ok(descriptor, `${id} 应存在`);
    assert.equal(descriptor.method, null);
    assert.equal(descriptor.httpMethod, null);
    assert.equal(descriptor.path, null);
    const gaps = verificationGaps(descriptor);
    assert.ok(gaps.length >= 6);
    assert.ok(gaps.some((gap) => gap.todoId === 'TODO-1688-001'));
    assert.ok(gaps.some((gap) => gap.todoId === 'TODO-1688-003'));
  }
  assert.equal(getOperation('item.import_package')?.channel, 'import');
  assert.equal(getOperation('quote.create')?.channel, 'manual');
  assert.equal(getOperation('item.update_price')?.riskLevel, 'C');
  assert.equal(getOperation('order.list')?.riskLevel, null);
});

test('真实操作 execute：抛 CONTRACT_NOT_VERIFIED，且一个请求都不发', async () => {
  const forbidden = new ForbiddenTransport();
  const client = createClient({ transport: forbidden, archive: new MemoryArchiveSink() });
  const plan = client.plan('item.publish', { params: { title: 'x' } });
  assert.equal(plan.blocked, true);
  assert.equal(plan.method, null);
  assert.ok(plan.todoIds.includes('TODO-1688-001'));

  const error = await client.execute('item.publish', { params: { title: 'x' } }).then(
    () => assert.fail('必须拒绝'),
    (reason) => fail(reason),
  );
  assert.equal(error.code, 'CONTRACT_NOT_VERIFIED');
  assert.ok(error.todoIds.includes('TODO-1688-001'));
  assert.equal(forbidden.calls, 0, '契约未核验时不得触网');

  const unknown = await client.execute('no.such.op').then(
    () => assert.fail('必须拒绝'),
    (reason) => fail(reason),
  );
  assert.equal(unknown.code, 'INVALID_REQUEST');
});

test('导入通道的操作不能走 HTTP 客户端', async () => {
  const client = createClient({ transport: new ForbiddenTransport() });
  const error = await client.execute('item.import_package').then(
    () => assert.fail('必须拒绝'),
    (reason) => fail(reason),
  );
  assert.equal(error.code, 'INVALID_REQUEST');
  assert.match(error.message, /导入包/);
});

test('探针成功链路：签名头进入请求、body 为 JSON、留档 1 条', async () => {
  const h = harness(() => jsonResponse(200, { ok: true }));
  const result = await h.client.execute<{ ok: boolean }>('contract.probe', { params: { page: 1, keyword: 'shirt' } });
  assert.equal(result.data.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.attempts, 1);
  assert.equal(h.transport.requests.length, 1);
  const request = h.transport.requests[0]!;
  assert.equal(request.method, 'POST');
  assert.match(request.headers['x-test-signature'] ?? '', /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(request.body ?? '{}').keyword, 'shirt');
  assert.equal(h.archive.entries.length, 1);
  assert.equal(h.archive.entries[0]?.meta.signerId, 'test-only/hmac-sha256');
  assert.equal(h.archive.entries[0]?.response?.status, 200);
});

test('5xx 可重试：两次尝试、留档两条、记录退避时长', async () => {
  const h = harness((_request, attempt) => (attempt === 1 ? jsonResponse(500, { error: 'boom' }) : jsonResponse(200, { ok: true })));
  const result = await h.client.execute('contract.probe', { params: { a: '1' } });
  assert.equal(result.attempts, 2);
  assert.equal(result.delaysMs.length, 1);
  assert.ok(result.delaysMs[0]! > 0);
  assert.equal(h.transport.requests.length, 2);
  assert.equal(h.archive.entries.length, 2);
  assert.equal(h.archive.entries[0]?.response?.status, 500, '失败响应的原文也要留档');
});

test('429 尊重 Retry-After（秒）', async () => {
  const h = harness((_request, attempt) =>
    attempt === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: '{}' } : jsonResponse(200, { ok: true }),
  );
  const result = await h.client.execute('contract.probe', { params: { a: '1' } });
  assert.equal(result.delaysMs[0], 2000);
  assert.ok(h.clock.sleeps.includes(2000));
});

test('4xx 业务拒绝不重试：一次调用即抛 PLATFORM_REJECT', async () => {
  const h = harness(() => jsonResponse(400, { code: 'isv.invalid-parameter', message: 'bad param' }));
  const error = await h.client.execute('contract.probe', { params: { a: '1' } }).then(
    () => assert.fail('必须失败'),
    (reason) => fail(reason),
  );
  assert.equal(error.code, 'PLATFORM_REJECT');
  assert.equal(error.retryable, false);
  assert.equal(h.transport.requests.length, 1);
});

test('C 级无幂等键：重试被压到 1 次（避免重复写）', async () => {
  const cLevel: OperationDescriptor = { ...PROBE, riskLevel: 'C', irreversible: true };
  const h = harness(() => jsonResponse(500, {}), { catalog: { get: (id) => (id === cLevel.id ? cLevel : undefined) } });
  const error = await h.client.execute('contract.probe', { params: { a: '1' } }).then(
    () => assert.fail('必须失败'),
    (reason) => fail(reason),
  );
  assert.equal(error.code, 'UPSTREAM_5XX');
  assert.equal(h.transport.requests.length, 1);

  const withKey = harness(() => jsonResponse(500, {}), {
    catalog: { get: (id) => (id === cLevel.id ? cLevel : undefined) },
  });
  await withKey.client.execute('contract.probe', { params: { a: '1' }, idempotencyKey: 'k-1' }).catch(() => undefined);
  assert.equal(withKey.transport.requests.length, DEFAULT_RETRY_POLICY.maxAttempts);
});

test('policyForOperation：只读/A 级原样，B/C 无幂等键只发一次', () => {
  assert.equal(policyForOperation(DEFAULT_RETRY_POLICY, { riskLevel: null, irreversible: false, idempotencyKey: null }).maxAttempts, 3);
  assert.equal(policyForOperation(DEFAULT_RETRY_POLICY, { riskLevel: 'A', irreversible: false, idempotencyKey: null }).maxAttempts, 3);
  assert.equal(policyForOperation(DEFAULT_RETRY_POLICY, { riskLevel: 'B', irreversible: true, idempotencyKey: null }).maxAttempts, 1);
  assert.equal(policyForOperation(DEFAULT_RETRY_POLICY, { riskLevel: 'C', irreversible: true, idempotencyKey: 'k' }).maxAttempts, 3);
});

test('本地令牌桶：容量 1 / 每秒补 1 → 第二次调用等待 1000ms', async () => {
  const clock = new FixedClock();
  const limiter = new TokenBucketRateLimiter({ ...ASSUMED_CLIENT_RATE_LIMIT, capacity: 1, refillPerSecond: 1, maxWaitMs: 10_000 }, clock);
  const first = await limiter.acquire('item.publish');
  assert.equal(first.waitedMs, 0);
  const second = await limiter.acquire('item.publish');
  assert.equal(second.waitedMs, 1000);
  const otherScope = await limiter.acquire('order.list');
  assert.equal(otherScope.waitedMs, 0, '不同 scope 桶独立');
});

test('留档脱敏：header / URL query / body 中的凭据与手机号', () => {
  const request: HttpRequest = {
    method: 'POST',
    url: 'https://gw.example/router/rest?app_key=abc123&sign=deadbeef&timestamp=1700000000&page=1',
    headers: {
      authorization: 'Bearer secret-token',
      'x-app-key': 'abc123',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_token: 'tok-1', phone: '13800138000', note: '买家 13800138000' }),
  };
  const archived = archiveRequest(request);
  assert.equal(archived.headers.authorization, '[REDACTED]');
  assert.equal(archived.headers['x-app-key'], '[REDACTED]');
  assert.equal(archived.headers['content-type'], 'application/json');
  assert.ok(!archived.url.includes('abc123'), archived.url);
  assert.ok(archived.url.includes('page=1'));
  assert.ok(!archived.body?.includes('tok-1'));
  assert.ok(!archived.body?.includes('13800138000'));
  assert.ok(archived.body?.includes('[REDACTED]'));

  assert.equal(redactBody('app_secret=xyz&page=2'), 'app_secret=[REDACTED]&page=2');
  const redactedUrl = new URL(redactUrl('https://gw.example/x?nonce=abc&page=2'));
  assert.equal(redactedUrl.searchParams.get('nonce'), '[REDACTED]');
  assert.equal(redactedUrl.searchParams.get('page'), '2');
});

test('目录归档：一次尝试一个 JSON 文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-1688-archive-'));
  try {
    const sink = new DirectoryArchiveSink(dir);
    const h = harness(() => jsonResponse(200, { ok: true }), { archive: sink });
    await h.client.execute('contract.probe', { params: { a: '1' }, requestId: 'req-test-1' });
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /contract\.probe.*req-test-1\.json$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('录制 → 落盘 → 回放：同请求命中，不同请求 NO_FIXTURE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-1688-fixtures-'));
  try {
    const inner = new FakeTransport(() => jsonResponse(200, { ok: true, echo: 'recorded' }));
    const recorder = new RecordingTransport(inner, () => ({
      platform: '1688',
      operation: 'contract.probe',
      recordedAt: '2026-10-20T02:00:00.000Z',
      docVersion: null,
      recorder: 'test',
      verified: false,
      synthetic: true,
      note: '形状样例，非平台真实报文',
    }));
    const recordingHarness = harness(() => jsonResponse(200, {}), { transport: recorder });
    await recordingHarness.client.execute('contract.probe', { params: { page: 1 } });
    assert.equal(recorder.fixtures.length, 1);

    const file = await saveFixture(dir, recorder.fixtures[0]!);
    assert.equal(file, fixturePath(dir, recorder.fixtures[0]!));
    assert.ok(file.includes(path.join('1688', 'contract.probe')));

    const loaded = await loadFixtures(dir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.meta.synthetic, true);
    assert.equal(loaded[0]?.matchKey, recorder.fixtures[0]!.matchKey);

    const replay = new ReplayTransport(loaded);
    const replayHarness = harness(() => jsonResponse(200, {}), { transport: replay });
    const result = await replayHarness.client.execute<{ echo: string }>('contract.probe', { params: { page: 1 } });
    assert.equal(result.data.echo, 'recorded');
    assert.equal(replay.unmatchedCount(), 0);

    const mismatch = await replayHarness.client.execute('contract.probe', { params: { page: 2 } }).then(
      () => assert.fail('必须失败'),
      (reason) => fail(reason),
    );
    assert.equal(mismatch.code, 'NO_FIXTURE');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fixture 诚实性：合成 fixture 不得标 verified；真实 fixture 必须带文档版本', () => {
  const base = {
    meta: {
      platform: '1688' as const,
      operation: 'contract.probe',
      recordedAt: '2026-10-20T02:00:00.000Z',
      docVersion: null,
      recorder: 'test',
      verified: false,
      synthetic: true,
    },
    matchKey: 'k',
    request: { method: 'POST', url: 'https://x/y', headers: {}, body: null, bodyBytes: null },
    response: { status: 200, headers: {}, body: '{}', bodyBytes: 2 },
  };
  assert.deepEqual(assertFixtureHonesty(base), []);
  const lying = structuredClone(base);
  lying.meta.verified = true;
  assert.ok(assertFixtureHonesty(lying).length > 0);

  const unversioned = structuredClone(base);
  unversioned.meta.synthetic = false;
  unversioned.meta.verified = true;
  assert.ok(assertFixtureHonesty(unversioned).some((problem) => problem.includes('文档版本')));
});

test('签名器未核验时客户端拒绝发送（即使 descriptor 齐全）', async () => {
  const h = harness(() => jsonResponse(200, {}), { signer: UNVERIFIED_SIGNER });
  const error = await h.client.execute('contract.probe', { params: { a: '1' } }).then(
    () => assert.fail('必须失败'),
    (reason) => fail(reason),
  );
  assert.equal(error.code, 'CONTRACT_NOT_VERIFIED');
  assert.ok(error.todoIds.includes('TODO-1688-003'));
  assert.equal(h.transport.requests.length, 0);
});

test('Retry-After 解析：秒 / HTTP 日期 / 超上限返回 null', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  assert.equal(parseRetryAfter('3600'), null, '超过 30 分钟不再自动重试');
  const future = new Date(Date.now() + 5000).toUTCString();
  const parsed = parseRetryAfter(future);
  assert.ok(parsed !== null && parsed > 0 && parsed <= 5000, String(parsed));
});
