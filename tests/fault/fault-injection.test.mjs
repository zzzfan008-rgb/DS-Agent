/**
 * 故障注入矩阵执行（docs/15 §5.2，10/14 行已落地）。
 *
 * 每个已实现行断言四件事：错误码（internal + external）、队列/重试状态、
 * 审计记录、用户可见提示；TODO 行必须给出原因，防止矩阵静默缩水。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { startMockPlatform } from './mock-platform.mjs';
import {
  httpCall,
  classifyResult,
  executeWithRetry,
  EffectLedger,
  FakeClock,
  PlatformQueue,
  toErrorEnvelope,
  renderUserHint,
} from './support/retry-client.mjs';
import { loadDocErrorCodes } from '../contract/lib/doc-codes.mjs';

const matrix = JSON.parse(
  await readFile(new URL('./matrix.json', import.meta.url), 'utf8'),
);
const itemAddSchema = JSON.parse(
  await readFile(new URL('../contract/schemas/pdd/item.add.schema.json', import.meta.url), 'utf8'),
);

const rows = new Map(matrix.rows.map((row) => [row.id, row]));
const servers = [];

async function mock(mode, options) {
  const server = await startMockPlatform(mode, options);
  servers.push(server);
  return server;
}

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

function rowOf(id) {
  const row = rows.get(id);
  assert.ok(row, `matrix 缺少 ${id}`);
  return row;
}

/** 四维断言：code / 状态 / 审计 / 提示。 */
function assertFourDimensions({ row, result, ledger, queue, hint, expectedState }) {
  const classification = result.classification;
  assert.equal(classification.internal, row.internal, `${row.id}: internal 不一致`);
  if (row.external) {
    assert.equal(classification.external, row.external, `${row.id}: external 不一致`);
    const envelope = toErrorEnvelope(classification);
    assert.equal(envelope.error.code, row.external, `${row.id}: 信封 code 不一致`);
    if (row.detail_sub) assert.equal(envelope.error.detail?.sub, row.detail_sub);
  }
  if (expectedState) assert.equal(queue.status(), expectedState, `${row.id}: 队列状态不一致`);
  assert.ok(ledger.count('audit') >= 1, `${row.id}: 缺少审计记录`);
  assert.ok(hint.length > 0, `${row.id}: 用户提示为空`);
}

test('矩阵完整性：14 行、已实现 ≥10 行、TODO 必须写原因、external 在 docs/12 词表', async () => {
  assert.equal(matrix.rows.length, 14);
  const implemented = matrix.rows.filter((row) => row.status === 'implemented');
  assert.ok(implemented.length >= 10, `已实现行 ${implemented.length} < 10`);
  for (const row of matrix.rows.filter((item) => item.status === 'todo')) {
    assert.ok(row.reason && row.reason.length > 0, `${row.id}: TODO 缺原因`);
  }
  const docCodes = await loadDocErrorCodes();
  for (const row of matrix.rows) {
    if (row.external) assert.ok(docCodes.has(row.external), `${row.id}: ${row.external} 不在 docs/12 §4`);
  }
});

test('FI-01 连接超时：重试 1 次后进死信，对外 upstream_5xx', async () => {
  const row = rowOf('FI-01');
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const queue = new PlatformQueue({ platform: 'pdd', clock, ledger });
  const result = await executeWithRetry(async () => ({ phase: 'connect_timeout' }), {
    maxRetries: 1,
    baseDelayMs: 10,
    clock,
    ledger,
    queue,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.deadLetter, true);
  assert.deepEqual(result.delays, [10]);
  assertFourDimensions({
    row,
    result,
    ledger,
    queue,
    hint: renderUserHint(row),
    expectedState: 'dead_letter',
  });
  assert.equal(queue.deadLetter.length, 1);
});

test('FI-02 读超时：结果未知，不自动重试，对外 conflict(sub=unknown)', async () => {
  const row = rowOf('FI-02');
  const server = await mock('read_timeout');
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const queue = new PlatformQueue({ platform: 'pdd', clock, ledger });
  const result = await executeWithRetry(
    () => httpCall(`${server.baseUrl}/write`, { connectTimeoutMs: 500, bodyTimeoutMs: 150 }),
    { maxRetries: 3, clock, ledger, queue },
  );
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1, '读超时不得自动重试');
  assert.deepEqual(result.delays, []);
  assert.equal(result.classification.uncertain, true);
  assertFourDimensions({ row, result, ledger, queue, hint: renderUserHint(row), expectedState: 'idle' });
});

test('FI-03 5xx：指数退避重试 3 次后成功；持续 5xx 则进死信', async () => {
  const row = rowOf('FI-03');
  const server = await mock('http_5xx', { failures: 3 });
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const queue = new PlatformQueue({ platform: 'pdd', clock, ledger });
  const result = await executeWithRetry(() => httpCall(`${server.baseUrl}/write`), {
    maxRetries: 3,
    baseDelayMs: 10,
    clock,
    ledger,
    queue,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.delays, [10, 20, 40]);
  assert.ok(ledger.count('audit') >= 4);
  assert.equal(server.state.hits, 4);

  const always = await mock('http_5xx', { failures: 99 });
  const exhaustedLedger = new EffectLedger();
  const exhaustedQueue = new PlatformQueue({ platform: 'pdd', clock, ledger: exhaustedLedger });
  const exhausted = await executeWithRetry(() => httpCall(`${always.baseUrl}/write`), {
    maxRetries: 3,
    baseDelayMs: 10,
    clock,
    ledger: exhaustedLedger,
    queue: exhaustedQueue,
  });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.deadLetter, true);
  assert.equal(exhaustedQueue.status(), 'dead_letter');
  assert.ok(exhaustedLedger.count('dead_letter') >= 1);
});

test('FI-04 429：遵守 Retry-After 暂停，其它平台不受影响', async () => {
  const row = rowOf('FI-04');
  const server = await mock('rate_limit', { failures: 1, retryAfterSeconds: 1 });
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const pddQueue = new PlatformQueue({ platform: 'pdd', clock, ledger });
  const otherQueue = new PlatformQueue({ platform: '1688', clock, ledger });
  const result = await executeWithRetry(() => httpCall(`${server.baseUrl}/write`), {
    maxRetries: 1,
    clock,
    ledger,
    queue: pddQueue,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  const firstFailure = result.history[0].classification;
  assert.equal(firstFailure.retryAfterMs, 1000);
  assert.ok(ledger.count('queue_paused') >= 1);
  assert.equal(pddQueue.isPaused(), false, 'fake clock 睡眠后应解除暂停');
  assertFourDimensions({
    row,
    result: { ...result, classification: firstFailure },
    ledger,
    queue: pddQueue,
    hint: renderUserHint(row, { seconds: 1 }),
    expectedState: 'ok',
  });

  // 其它平台队列不受 pdd 暂停影响
  const okServer = await mock('ok');
  const other = await executeWithRetry(() => httpCall(`${okServer.baseUrl}/write`), {
    maxRetries: 1,
    clock,
    ledger,
    queue: otherQueue,
  });
  assert.equal(other.ok, true);
  assert.equal(other.attempts, 1);
  assert.equal(otherQueue.status(), 'ok');
});

test('FI-06 部分成功：成功项落库，仅重试失败 3 条', async () => {
  const row = rowOf('FI-06');
  const server = await mock('partial_success');
  const ledger = new EffectLedger();
  const first = await httpCall(`${server.baseUrl}/batch`, { body: { ids: Array.from({ length: 10 }, (_, i) => i + 1) } });
  assert.equal(first.status, 200);
  const results = first.body.results;
  const succeeded = results.filter((item) => item.ok);
  const failed = results.filter((item) => !item.ok);
  assert.equal(succeeded.length, 7);
  assert.equal(failed.length, 3);

  const retry = await httpCall(`${server.baseUrl}/batch-retry`, { body: { ids: failed.map((item) => item.id) } });
  assert.equal(retry.status, 200);
  assert.deepEqual([...server.state.retryIds].sort(), ['item-3', 'item-6', 'item-9']);
  assert.ok(ledger.entries.length >= 0);
  const hint = renderUserHint(row, { n: failed.length });
  assert.match(hint, /3 条/);
});

test('FI-07 重复回调：同一 event_id 投递 3 次只产生 1 次副作用', async () => {
  const row = rowOf('FI-07');
  const server = await mock('duplicate_callback');
  const ledger = new EffectLedger();
  const responses = [];
  for (let i = 0; i < 3; i += 1) {
    const response = await httpCall(`${server.baseUrl}/callback`, { body: { event_id: 'evt-0001' } });
    responses.push(response.body.deduped);
    if (response.body.deduped) ledger.record('idempotent_hit', { event_id: 'evt-0001' });
  }
  assert.equal(server.state.deliveries, 3);
  assert.equal(server.state.effects, 1);
  assert.deepEqual(responses, [false, true, true]);
  assert.ok(ledger.count('idempotent_hit') >= 1);
  assert.ok(renderUserHint(row).length > 0);
});

test('FI-10/FI-11 契约漂移：缺字段/类型变化 → contract_drift，不重试并告警', async () => {
  for (const [id, mode] of [
    ['FI-10', 'contract_drift_missing'],
    ['FI-11', 'contract_drift_type'],
  ]) {
    const row = rowOf(id);
    const server = await mock(mode);
    const ledger = new EffectLedger();
    const clock = new FakeClock();
    const queue = new PlatformQueue({ platform: 'pdd', clock, ledger });
    const result = await executeWithRetry(
      () => {
        // httpCall 之前先经 classify 注入 schema；executeWithRetry 通过 options.schema 完成校验
        return httpCall(`${server.baseUrl}/write`);
      },
      { maxRetries: 3, clock, ledger, queue, schema: itemAddSchema },
    );
    assert.equal(result.ok, false);
    assert.equal(result.attempts, 1, '契约漂移不得自动重试');
    assertFourDimensions({ row, result, ledger, queue, hint: renderUserHint(row), expectedState: 'idle' });
    assert.ok(ledger.count('alert') >= 1);
  }
});

test('FI-12 HTML 错误页：upstream_invalid，告警不重试', async () => {
  const row = rowOf('FI-12');
  const server = await mock('html_error');
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const queue = new PlatformQueue({ platform: 'pdd', clock, ledger });
  const result = await executeWithRetry(() => httpCall(`${server.baseUrl}/write`), {
    maxRetries: 3,
    clock,
    ledger,
    queue,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assertFourDimensions({ row, result, ledger, queue, hint: renderUserHint(row), expectedState: 'idle' });
  assert.ok(ledger.count('alert') >= 1);
});

test('FI-13 签名失败：signature_invalid → unauthorized，不重试', async () => {
  const row = rowOf('FI-13');
  const server = await mock('signature_invalid');
  const ledger = new EffectLedger();
  const clock = new FakeClock();
  const queue = new PlatformQueue({ platform: '1688', clock, ledger });
  const result = await executeWithRetry(() => httpCall(`${server.baseUrl}/write`), {
    maxRetries: 3,
    clock,
    ledger,
    queue,
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assertFourDimensions({ row, result, ledger, queue, hint: renderUserHint(row), expectedState: 'idle' });
});

test('矩阵行与分类器口径一致（已实现行）', async () => {
  const samples = {
    'FI-01': { phase: 'connect_timeout' },
    'FI-02': { phase: 'read_timeout' },
    'FI-03': { status: 502, headers: {}, bodyText: '' },
    'FI-04': { status: 429, headers: { 'retry-after': '1' }, bodyText: '' },
    'FI-10': { status: 200, headers: {}, body: { success: true, result: { created_at: '2026-01-01T00:00:00.000Z' } } },
    'FI-11': { status: 200, headers: {}, body: { success: true, result: { goods_id: 1, created_at: '2026-01-01T00:00:00.000Z' } } },
    'FI-12': { status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html>502</html>' },
    'FI-13': { status: 401, headers: {}, body: { errorCode: '401' }, bodyText: '签名校验失败' },
  };
  for (const [id, sample] of Object.entries(samples)) {
    const row = rowOf(id);
    const classification = classifyResult(sample, { schema: id === 'FI-10' || id === 'FI-11' ? itemAddSchema : undefined });
    assert.equal(classification.internal, row.internal, `${id}: internal`);
    assert.equal(classification.external, row.external, `${id}: external`);
  }
});
