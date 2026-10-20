import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isPddError } from '../src/errors.js';
import { NullArchiver } from '../src/http/archive.js';
import { PddClient } from '../src/http/client.js';
import {
  RecordingTransport,
  ReplayTransport,
  loadReplayFixtures,
  validateReplayFixture,
} from '../src/http/replay.js';
import { TimestampReplayGuard } from '../src/http/signer.js';
import type { TransportRequest } from '../src/http/transport.js';
import {
  FakeClock,
  FakeTransport,
  REPLAY_FIXTURES_DIR,
  createTestRegistry,
  jsonResponse,
  testConfig,
  withTempDir,
} from './helpers.js';

async function replayClient(maxAttempts = 3): Promise<{ client: PddClient; replay: ReplayTransport; clock: FakeClock }> {
  const fixtures = await loadReplayFixtures(REPLAY_FIXTURES_DIR);
  const clock = new FakeClock();
  const replay = new ReplayTransport({ fixtures, clock: clock.now, sleep: clock.sleep });
  const client = new PddClient({
    config: testConfig({ maxAttempts }),
    registry: createTestRegistry(),
    transport: replay,
    archiver: new NullArchiver(),
    retryPolicy: { maxAttempts, baseDelayMs: 10, maxDelayMs: 10, jitterRatio: 0 },
    clock: clock.now,
    sleep: clock.sleep,
    replayGuard: new TimestampReplayGuard({ windowMs: 5 * 60_000, clock: clock.now }),
  });
  return { client, replay, clock };
}

test('加载包内回放夹具：结构合法、全部 synthetic、覆盖成功/拒绝/限流', async () => {
  const fixtures = await loadReplayFixtures(REPLAY_FIXTURES_DIR);
  assert.equal(fixtures.length >= 3, true);
  for (const { fixture } of fixtures) {
    assert.equal(fixture.meta.platform, 'pdd');
    assert.equal(fixture.meta.synthetic, true);
    assert.match(fixture.meta.doc_version, /synthetic/);
    assert.equal(validateReplayFixture(fixture).length, 0);
  }
  const endpoints = fixtures.map(({ fixture }) => fixture.meta.endpoint).sort();
  assert.deepEqual(endpoints, ['test.echo', 'test.rate_limited', 'test.reject']);
});

test('回放成功：PddClient 走 ReplayTransport 得到 200', async () => {
  const { client, replay } = await replayClient();
  const result = await client.call('test.echo', { message: 'hello-pdd', n: 1 });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.status === 'success' ? result.data : null, { success: true, result: { echo: 'hello-pdd', n: 1 } });
  assert.equal(replay.usedCount, 1);
});

test('回放严格匹配：请求体不同 → replay_mismatch，不静默放行', async () => {
  const { client } = await replayClient(1);
  await assert.rejects(
    () => client.call('test.echo', { message: 'different', n: 1 }),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      const pddError = error as { code: string; detail: Record<string, unknown> };
      assert.equal(pddError.code, 'replay_mismatch');
      assert.deepEqual(pddError.detail.known_routes, ['POST /synthetic/test/echo']);
      return true;
    },
  );
});

test('回放错误映射：200+success=false → platform_reject；429 → rate_limited', async () => {
  const reject = await replayClient(1);
  await assert.rejects(
    () => reject.client.call('test.reject', { reason: 'qualification_missing' }),
    (error: unknown) => isPddError(error) && error.code === 'platform_reject',
  );

  const limited = await replayClient(1);
  await assert.rejects(
    () => limited.client.call('test.rate_limited', { burst: true }),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      const pddError = error as { code: string; errorClass: string; retryAfterMs: number };
      assert.equal(pddError.code, 'rate_limited');
      assert.equal(pddError.errorClass, 'retryable');
      assert.equal(pddError.retryAfterMs, 1_000);
      return true;
    },
  );
});

test('录制 transport：脱敏落盘为 fixture，且能被 ReplayTransport 回放', async () => {
  await withTempDir(async (dir) => {
    const clock = new FakeClock();
    const delegate = new FakeTransport([jsonResponse(200, { success: true, result: { ok: true } }, { 'set-cookie': 'sid=secret' })]);
    const recorder = new RecordingTransport(delegate, { dir, synthetic: true, clock: clock.now });
    const request: TransportRequest = {
      method: 'POST',
      url: 'https://api.example.invalid/synthetic/test/echo',
      headers: {
        authorization: 'Bearer super-secret',
        'x-pdd-access-token': 'token-xyz',
        'content-type': 'application/json; charset=utf-8',
      },
      bodyText: '{"message":"hello-pdd","n":1}',
      timeoutMs: 1000,
      maxResponseBytes: 1024,
      requestId: 'req_test_record',
      interfaceKey: 'test.echo',
    };
    const response = await recorder.request(request);
    assert.equal(response.status, 200);
    assert.equal(recorder.recorded.length, 1);

    const file = recorder.recorded[0]?.file ?? '';
    const text = await readFile(file, 'utf8');
    assert.equal(text.includes('super-secret'), false);
    assert.equal(text.includes('token-xyz'), false);
    const fixture = JSON.parse(text) as {
      meta: { synthetic: boolean; endpoint: string; platform: string };
      request: { headers: Record<string, string>; body: unknown };
    };
    assert.equal(fixture.meta.synthetic, true);
    assert.equal(fixture.meta.endpoint, 'test.echo');
    assert.equal(fixture.meta.platform, 'pdd');
    assert.equal(fixture.request.headers.authorization, '<redacted:authorization>');
    assert.equal(fixture.request.headers['x-pdd-access-token'], '<redacted:x-pdd-access-token>');
    assert.deepEqual(fixture.request.body, { message: 'hello-pdd', n: 1 });

    const loaded = await loadReplayFixtures(dir);
    assert.equal(loaded.length, 1);
    const replay = new ReplayTransport({ fixtures: loaded, clock: clock.now, sleep: clock.sleep });
    const replayed = await replay.request(request);
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.body, { success: true, result: { ok: true } });
  });
});

test('fixture 结构校验会拒绝缺失字段与非法状态码', () => {
  const valid = {
    meta: {
      platform: 'pdd',
      endpoint: 'test.echo',
      recorded_at: '2026-10-20T10:00:00.000Z',
      doc_version: 'synthetic',
      recorder: 'test',
      synthetic: true,
    },
    request: { method: 'POST', path: '/x', body: {} },
    response: { status: 200 },
  };
  assert.deepEqual(validateReplayFixture(valid), []);
  assert.ok(validateReplayFixture({ ...valid, meta: { ...valid.meta, synthetic: 'yes' } }).length > 0);
  assert.ok(validateReplayFixture({ ...valid, request: { ...valid.request, method: 'post' } }).length > 0);
  assert.ok(validateReplayFixture({ ...valid, request: { ...valid.request, path: 'x' } }).length > 0);
  assert.ok(validateReplayFixture({ ...valid, response: { status: 99 } }).length > 0);
});
