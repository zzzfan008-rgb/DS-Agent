/** Idempotency-Key 中间件行为（独立最小 app，不依赖数据库/CSRF）。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryIdempotencyStore, registerIdempotency } from '../src/plugins/idempotency.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { sha256Json } from '../src/lib/ids.js';

let app: FastifyInstance;
let store: MemoryIdempotencyStore;
let counter = 0;

before(async () => {
  app = Fastify({ logger: false });
  store = new MemoryIdempotencyStore(60_000);
  app.addHook('onRequest', async (request) => {
    request.requestId = 'req_test';
    request.startedAt = Date.now();
    request.auth = null;
    request.session = null;
    request.auditLogged = false;
  });
  registerErrorHandler(app);
  registerIdempotency(app, store);
  app.post('/api/echo', { config: { public: true } }, async (request) => ({
    request_id: request.requestId,
    data: { seq: (counter += 1), echo: request.body },
  }));
  await app.ready();
});

after(async () => {
  await app.close();
});

test('缺少 Idempotency-Key → 422 validation_failed', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/echo',
    payload: { hello: 1 },
  });
  assert.equal(response.statusCode, 422);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'validation_failed');
});

test('同键同 payload 回放缓存响应，不重复执行 handler', async () => {
  const key = 'test-key-0000000001';
  const first = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'idempotency-key': key },
    payload: { hello: 'world' },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.body;

  const replay = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'idempotency-key': key },
    payload: { hello: 'world' },
  });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.headers['idempotent-replayed'], 'true');
  assert.equal(replay.body, firstBody);
});

test('同键不同 payload → 409 idempotency_conflict', async () => {
  const key = 'test-key-0000000002';
  const first = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'idempotency-key': key },
    payload: { hello: 'one' },
  });
  assert.equal(first.statusCode, 200);

  const conflict = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'idempotency-key': key },
    payload: { hello: 'two' },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.json() as { error: { code: string } }).error.code, 'idempotency_conflict');
});

test('同键 in_flight → 409 conflict + Retry-After', async () => {
  const key = 'test-key-0000000003';
  const payloadHash = sha256Json({
    method: 'POST',
    path: '/api/echo',
    body: { hello: 'pending' },
  });
  store.setInFlight(`org:1:${key}`, payloadHash);

  const pending = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'idempotency-key': key },
    payload: { hello: 'pending' },
  });
  assert.equal(pending.statusCode, 409);
  assert.equal(pending.headers['retry-after'], '2');
  assert.equal((pending.json() as { error: { code: string } }).error.code, 'conflict');
});
