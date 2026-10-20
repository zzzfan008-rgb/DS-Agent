import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadPddConfig } from '../src/config.js';
import { isPddError } from '../src/errors.js';
import { JsonFileArchiver, NullArchiver } from '../src/http/archive.js';
import { PddClient } from '../src/http/client.js';
import { TimestampReplayGuard, computePlaceholderSignature } from '../src/http/signer.js';
import { pddRegistry } from '../src/registry/index.js';
import {
  FakeClock,
  FakeTransport,
  createTestRegistry,
  jsonResponse,
  testConfig,
  withTempDir,
  type FakeResponse,
} from './helpers.js';

function buildClient(
  responses: FakeResponse[],
  options: {
    maxAttempts?: number;
    archiver?: JsonFileArchiver | NullArchiver;
    dryRun?: boolean;
    configOverrides?: Parameters<typeof testConfig>[0];
  } = {},
): { client: PddClient; transport: FakeTransport; clock: FakeClock } {
  const clock = new FakeClock();
  const transport = new FakeTransport(responses);
  const maxAttempts = options.maxAttempts ?? 3;
  const client = new PddClient({
    config: testConfig({ maxAttempts, ...options.configOverrides }),
    registry: createTestRegistry(),
    transport,
    archiver: options.archiver ?? new NullArchiver(),
    retryPolicy: { maxAttempts, baseDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 },
    clock: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    replayGuard: new TimestampReplayGuard({ windowMs: 5 * 60_000, clock: clock.now }),
  });
  return { client, transport, clock };
}

test('缺省配置下调用未核验接口：返回 dry-run 预览，不构造网络请求', async () => {
  const client = new PddClient({
    config: loadPddConfig({ env: {} }),
    registry: pddRegistry,
    archiver: new NullArchiver(),
  });
  const result = await client.call('product.publish', { sku_ids: ['a'] });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.status === 'dry_run' ? result.reason : null, 'unverified_interface');
  assert.equal(result.status === 'dry_run' ? result.request_preview.method : 'x', null);
  assert.equal(result.status === 'dry_run' ? result.request_preview.path : 'x', null);
  assert.ok(result.status === 'dry_run' && result.warnings.some((warning) => warning.includes('docs/01 §2.1 第1行')));
  assert.ok(result.status === 'dry_run' && result.warnings.some((warning) => warning.includes('签名')));
});

test('live 模式调用未核验接口必须失败（不静默 dry-run）', async () => {
  const transport = new FakeTransport([]);
  const client = new PddClient({
    config: testConfig(),
    registry: pddRegistry,
    transport,
    archiver: new NullArchiver(),
  });
  await assert.rejects(
    () => client.call('product.publish', {}),
    (error: unknown) => isPddError(error) && error.code === 'unverified_interface',
  );
  assert.equal(transport.requests.length, 0);
});

test('显式 dry-run + 已核验接口：返回 dry-run 预览，transport 不被调用', async () => {
  const { client, transport } = buildClient([], { dryRun: true, configOverrides: { dryRun: true, mode: 'dry_run', dryRunReason: 'forced_by_env' } });
  const result = await client.call('test.echo', { message: 'hello-pdd', n: 1 });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.status === 'dry_run' ? result.reason : null, 'dry_run');
  assert.equal(result.status === 'dry_run' ? result.request_preview.method : null, 'POST');
  assert.equal(result.status === 'dry_run' ? result.request_preview.path : null, '/synthetic/test/echo');
  assert.deepEqual(result.status === 'dry_run' ? result.request_preview.body : null, { message: 'hello-pdd', n: 1 });
  assert.equal(transport.requests.length, 0);
});

test('dry-run 已核验接口缺 baseUrl 时仍返回预览（url=null，不抛配置错）', async () => {
  const { client, transport } = buildClient([], {
    dryRun: true,
    configOverrides: {
      dryRun: true,
      mode: 'dry_run',
      dryRunReason: 'missing_base_url',
      baseUrl: null,
      accessToken: null,
    },
  });
  const result = await client.call('test.echo', { message: 'hello-pdd', n: 1 });
  assert.equal(result.status, 'dry_run');
  assert.equal(result.status === 'dry_run' ? result.request_preview.url : 'x', null);
  assert.equal(result.status === 'dry_run' ? result.request_preview.path : null, '/synthetic/test/echo');
  assert.equal(transport.requests.length, 0);
});

test('成功路径：URL/签名/request_id/body 规范化全部可核对', async () => {
  const { client, transport } = buildClient([jsonResponse(200, { success: true, result: { echo: 'hello-pdd', n: 1 } })]);
  const result = await client.call('test.echo', { n: 1, message: 'hello-pdd' });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.status === 'success' ? result.data : null, { success: true, result: { echo: 'hello-pdd', n: 1 } });
  assert.equal(result.status === 'success' ? result.attempts : 0, 1);
  assert.equal(transport.requests.length, 1);

  const request = transport.requests[0];
  assert.ok(request);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.example.invalid/synthetic/test/echo');
  assert.equal(request.bodyText, '{"message":"hello-pdd","n":1}');
  assert.equal(request.headers['x-request-id'], result.request_id);
  assert.equal(request.headers['content-type'], 'application/json; charset=utf-8');

  const timestampMs = Number(request.headers['x-pdd-timestamp']);
  const nonce = request.headers['x-pdd-nonce'];
  assert.ok(timestampMs > 0);
  assert.ok(nonce);
  const expected = computePlaceholderSignature({
    method: 'POST',
    path: '/synthetic/test/echo',
    bodyText: request.bodyText,
    timestampMs,
    nonce: String(nonce),
    appKey: 'test-app-key',
    appSecret: 'test-app-secret',
    accessToken: 'test-access-token',
  });
  assert.equal(request.headers['x-pdd-signature'], expected);
  assert.equal(request.headers['x-pdd-signature-scheme'], 'placeholder-hmac-sha256-v0');
});

test('429 带 Retry-After：按平台指示等待后重试，第二次成功', async () => {
  const { client, transport, clock } = buildClient([
    jsonResponse(429, { success: false, error_code: 'RATE_LIMIT', error_msg: '慢点' }, { 'retry-after': '2' }),
    jsonResponse(200, { success: true, result: { ok: true } }),
  ]);
  const result = await client.call('test.retry', { attempt: 1 });
  assert.equal(result.status, 'success');
  assert.equal(result.status === 'success' ? result.attempts : 0, 2);
  assert.equal(transport.requests.length, 2);
  assert.deepEqual(clock.waits, [2_000]);
});

test('5xx 重试到上限后抛出 upstream_5xx（可重试分类）', async () => {
  const { client, transport } = buildClient([
    jsonResponse(503, { error: 'unavailable' }),
    jsonResponse(502, { error: 'bad gateway' }),
    jsonResponse(500, { error: 'internal' }),
  ]);
  await assert.rejects(
    () => client.call('test.retry', {}),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      const pddError = error as { code: string; errorClass: string; attempts: number; detail: Record<string, unknown> };
      assert.equal(pddError.code, 'upstream_5xx');
      assert.equal(pddError.errorClass, 'retryable');
      assert.equal(pddError.attempts, 3);
      assert.equal(pddError.detail.interface_key, 'test.retry');
      return true;
    },
  );
  assert.equal(transport.requests.length, 3);
});

test('422 平台拒绝不重试，分类为 platform_reject', async () => {
  const { client, transport, clock } = buildClient([jsonResponse(422, { success: false, error_code: 'BIZ_REJECT', error_msg: '属性缺失' })]);
  await assert.rejects(
    () => client.call('test.reject', {}),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      assert.equal((error as { code: string }).code, 'platform_reject');
      assert.equal((error as { attempts: number }).attempts, 1);
      return true;
    },
  );
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(clock.waits, []);
});

test('HTTP 200 但包络 success=false 也按平台拒绝处理', async () => {
  const { client } = buildClient([jsonResponse(200, { success: false, error_code: 'BIZ_REJECT', error_msg: '类目属性缺失' })]);
  await assert.rejects(
    () => client.call('test.reject', {}),
    (error: unknown) => isPddError(error) && error.code === 'platform_reject',
  );
});

test('传输超时分类为 timeout 并可重试', async () => {
  const timeoutError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const { client, transport } = buildClient([timeoutError, timeoutError, timeoutError]);
  await assert.rejects(
    () => client.call('test.retry', {}),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      assert.equal((error as { code: string }).code, 'timeout');
      assert.equal((error as { errorClass: string }).errorClass, 'retryable');
      return true;
    },
  );
  assert.equal(transport.requests.length, 3);
});

test('请求/响应留档：JSON 落盘、敏感头与 token 已脱敏、保留 body_sha256', async () => {
  await withTempDir(async (dir) => {
    const archiver = new JsonFileArchiver({ dir });
    const clock = new FakeClock();
    const transport = new FakeTransport([jsonResponse(200, { success: true, result: { ok: true } }, { 'set-cookie': 'sid=secret' })]);
    const client = new PddClient({
      config: testConfig({ archiveDir: dir }),
      registry: createTestRegistry(),
      transport,
      archiver,
      clock: clock.now,
      sleep: clock.sleep,
      replayGuard: new TimestampReplayGuard({ windowMs: 5 * 60_000, clock: clock.now }),
    });
    const result = await client.call('test.echo', { message: 'archive-me' });
    assert.equal(result.status, 'success');
    assert.ok(result.archived_path && result.archived_path.endsWith('-a1.json'));

    const text = await readFile(result.archived_path ?? '', 'utf8');
    assert.equal(text.includes('test-app-secret'), false);
    assert.equal(text.includes('test-access-token'), false);
    assert.equal(text.includes('test-app-key'), false);
    assert.ok(text.includes('[REDACTED]'));
    const record = JSON.parse(text) as {
      schema_version: string;
      outcome: string;
      request: { body_sha256: string; body: unknown };
      response: { status: number; body_sha256: string; body: unknown };
    };
    assert.equal(record.schema_version, 'pdd-call-v1');
    assert.equal(record.outcome, 'success');
    assert.equal(record.request.body_sha256.length, 64);
    assert.equal(record.response.status, 200);
    assert.equal(record.response.body_sha256.length, 64);
    assert.deepEqual(record.request.body, { message: 'archive-me' });

    // 归档目录按 UTC 日期分目录，且一次调用一个 JSON 文件。
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    const files = await readdir(path.join(dir, day));
    assert.equal(files.length, 1);
  });
});
