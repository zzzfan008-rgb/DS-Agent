/** 健康检查与 Prometheus 指标（公开/admin 边界）。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const VIEWER_PASSWORD = 'TestViewerPassword!2026';

let app: FastifyInstance;
let admin: { id: string; email: string };
let viewer: { id: string; email: string };

before(async () => {
  app = await buildTestApp({ METRICS_TOKEN: 'metrics-token-1234567890' });
  admin = await createUser({
    email: 'admin.health@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  viewer = await createUser({
    email: 'viewer.health@test.local',
    password: VIEWER_PASSWORD,
    role: 'viewer',
  });
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('GET /health 公开且返回 db=ok', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    data: { status: string; checks: { db: string }; version: string; uptime_s: number };
  };
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.checks.db, 'ok');
  assert.equal(typeof body.data.uptime_s, 'number');
});

test('GET /metrics：未登录 401、viewer 403、admin 200、bearer token 200', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/metrics' });
  assert.equal(anonymous.statusCode, 401);

  const viewerLogin = await login(app, viewer.email, VIEWER_PASSWORD);
  const viewerMetrics = await app.inject({
    method: 'GET',
    url: '/api/metrics',
    headers: sessionHeaders(cookiesFrom(viewerLogin)),
  });
  assert.equal(viewerMetrics.statusCode, 403);

  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  const adminMetrics = await app.inject({
    method: 'GET',
    url: '/api/metrics',
    headers: sessionHeaders(cookiesFrom(adminLogin)),
  });
  assert.equal(adminMetrics.statusCode, 200);
  assert.match(String(adminMetrics.headers['content-type']), /text\/plain/);
  assert.match(adminMetrics.body, /dssaas_up 1/);
  assert.match(adminMetrics.body, /dssaas_http_requests_total\{/);
  assert.match(adminMetrics.body, /dssaas_auth_login_total\{/);

  const tokenMetrics = await app.inject({
    method: 'GET',
    url: '/api/metrics',
    headers: { authorization: 'Bearer metrics-token-1234567890' },
  });
  assert.equal(tokenMetrics.statusCode, 200);
  assert.match(tokenMetrics.body, /dssaas_build_info\{/);
});
