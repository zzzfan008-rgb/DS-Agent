/** t2 验收：登录/登出/越权拒绝/审计落库 + TOTP + 账号锁定。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { AuditService } from '../src/services/audit.js';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  csrfFrom,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';
const VIEWER_PASSWORD = 'TestViewerPassword!2026';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

let app: FastifyInstance;
let admin: { id: string; email: string };
let operator: { id: string; email: string };
let viewer: { id: string; email: string };
let totpUser: { id: string; email: string };
let lockUser: { id: string; email: string };

before(async () => {
  app = await buildTestApp({
    DSSAAS_TOTP_SECRETS: JSON.stringify({ user_totp: TOTP_SECRET }),
  });
  admin = await createUser({
    email: 'admin.auth@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
    displayName: '测试管理员',
  });
  operator = await createUser({
    email: 'operator.auth@test.local',
    password: OPERATOR_PASSWORD,
    role: 'operator',
  });
  viewer = await createUser({
    email: 'viewer.auth@test.local',
    password: VIEWER_PASSWORD,
    role: 'viewer',
  });
  totpUser = await createUser({
    email: 'totp.auth@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
    totpEnabled: true,
    totpSecretRef: 'user_totp',
  });
  lockUser = await createUser({
    email: 'lock.auth@test.local',
    password: VIEWER_PASSWORD,
    role: 'viewer',
  });
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('登录成功：返回 user/csrf/expires_at，Set-Cookie 可访问 /me', async () => {
  const response = await login(app, admin.email, ADMIN_PASSWORD);
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    request_id: string;
    data: {
      user: { id: string; name: string; role: string };
      csrf_token: string;
      expires_at: string;
      must_change_password: boolean;
    };
  };
  assert.equal(body.data.user.role, 'admin');
  assert.equal(body.data.user.id, admin.id);
  assert.equal(body.data.must_change_password, false);
  assert.ok(body.data.csrf_token.length >= 32);
  assert.ok(!Number.isNaN(Date.parse(body.data.expires_at)));
  assert.equal(response.headers['x-request-id'], body.request_id);

  const cookies = cookiesFrom(response);
  assert.ok(cookies.dssaas_sid, '缺少会话 cookie');
  assert.ok(cookies.dssaas_csrf, '缺少 csrf cookie');

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: sessionHeaders(cookies),
  });
  assert.equal(me.statusCode, 200);
  const meBody = me.json() as {
    data: { role: string; permissions: string[]; org_id: number; name: string };
  };
  assert.equal(meBody.data.role, 'admin');
  assert.equal(meBody.data.name, '测试管理员');
  assert.ok(meBody.data.permissions.includes('audit.read'));
  assert.equal(meBody.data.org_id, 1);
});

test('登出后旧会话立即失效', async () => {
  const response = await login(app, operator.email, OPERATOR_PASSWORD);
  assert.equal(response.statusCode, 200);
  const cookies = cookiesFrom(response);
  const csrf = csrfFrom(response);

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: sessionHeaders(cookies, csrf),
  });
  assert.equal(logout.statusCode, 200);
  assert.deepEqual((logout.json() as { data: { ok: boolean } }).data, { ok: true });

  const me = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: sessionHeaders(cookies),
  });
  assert.equal(me.statusCode, 401);
  assert.equal((me.json() as { error: { code: string } }).error.code, 'unauthorized');
});

test('越权拒绝：未登录 401、角色不足 403、CSRF 缺失/错误 403', async () => {
  const anonymous = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anonymous.statusCode, 401);

  const viewerLogin = await login(app, viewer.email, VIEWER_PASSWORD);
  assert.equal(viewerLogin.statusCode, 200);
  const viewerCookies = cookiesFrom(viewerLogin);
  const viewerCsrf = csrfFrom(viewerLogin);

  const viewerAudit = await app.inject({
    method: 'GET',
    url: '/api/audit',
    headers: sessionHeaders(viewerCookies),
  });
  assert.equal(viewerAudit.statusCode, 403);
  assert.equal((viewerAudit.json() as { error: { code: string } }).error.code, 'forbidden');

  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  const adminCookies = cookiesFrom(adminLogin);
  const adminCsrf = csrfFrom(adminLogin);

  const noCsrf = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: sessionHeaders(adminCookies),
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal((noCsrf.json() as { error: { detail: { reason: string } } }).error.detail.reason, 'csrf');

  const wrongCsrf = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: sessionHeaders(adminCookies, `${adminCsrf}-wrong`),
  });
  assert.equal(wrongCsrf.statusCode, 403);

  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  const operatorCookies = cookiesFrom(operatorLogin);
  const operatorAudit = await app.inject({
    method: 'GET',
    url: '/api/audit',
    headers: sessionHeaders(operatorCookies),
  });
  assert.equal(operatorAudit.statusCode, 403);
});

test('错误口令 5 次锁定，第 6 次返回 423 locked', async () => {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await login(app, lockUser.email, 'WrongPassword!2026');
    assert.equal(response.statusCode, 401, `第 ${attempt} 次应为 401`);
  }
  const locked = await login(app, lockUser.email, VIEWER_PASSWORD);
  assert.equal(locked.statusCode, 423);
  assert.equal((locked.json() as { error: { code: string } }).error.code, 'locked');

  const row = await prisma.user.findUniqueOrThrow({ where: { id: lockUser.id } });
  assert.equal(row.failedAttempts, 5);
  assert.ok(row.lockedUntil instanceof Date);
});

test('TOTP：缺 code 401、错误 code 401、正确 code 通过、重放被拒', async () => {
  const missing = await login(app, totpUser.email, ADMIN_PASSWORD);
  assert.equal(missing.statusCode, 401);
  assert.equal(
    (missing.json() as { error: { detail: { totp_required: boolean } } }).error.detail.totp_required,
    true,
  );

  const totp = new OTPAuth.TOTP({
    issuer: 'DSSAAS',
    label: `user:${totpUser.id}`,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(TOTP_SECRET),
  });
  const code = totp.generate();
  const wrong = code === '000000' ? '000001' : '000000';

  const wrongResponse = await login(app, totpUser.email, ADMIN_PASSWORD, wrong);
  assert.equal(wrongResponse.statusCode, 401);

  const okResponse = await login(app, totpUser.email, ADMIN_PASSWORD, code);
  assert.equal(okResponse.statusCode, 200, okResponse.body);

  const replay = await login(app, totpUser.email, ADMIN_PASSWORD, code);
  assert.equal(replay.statusCode, 401);
  assert.equal(
    (replay.json() as { error: { detail: { reason: string } } }).error.detail.reason,
    'replay',
  );
});

test('审计落库：登录/登出事件存在、哈希链完整、UPDATE 被拒', async () => {
  const rows = await prisma.auditLog.findMany({
    where: { action: { in: ['auth.login', 'auth.logout', 'auth.login_failed', 'auth.account_locked'] } },
    orderBy: { seq: 'asc' },
  });
  assert.ok(rows.some((row) => row.action === 'auth.login'));
  assert.ok(rows.some((row) => row.action === 'auth.logout'));
  assert.ok(rows.some((row) => row.action === 'auth.login_failed'));
  assert.ok(rows.some((row) => row.action === 'auth.account_locked'));
  assert.ok(rows.every((row) => row.requestId.startsWith('req_') || row.requestId.length > 0));
  assert.ok(rows.every((row) => row.chainHash.length === 64));
  assert.ok(rows.every((row) => row.actorType === 'user' || row.actorType === 'system'));

  const verification = await new AuditService(prisma).verifyChain();
  assert.equal(verification.ok, true, JSON.stringify(verification));

  await assert.rejects(
    () => prisma.$executeRawUnsafe(`UPDATE audit_log SET action = action`),
    (error: unknown) => /append-only|42501/i.test(String(error)),
  );
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`DELETE FROM audit_log`),
    (error: unknown) => /append-only|42501/i.test(String(error)),
  );
});

test('GET /audit：admin 可按 action 过滤并游标翻页，viewer 不可见', async () => {
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  assert.equal(adminLogin.statusCode, 200);
  const cookies = cookiesFrom(adminLogin);

  const first = await app.inject({
    method: 'GET',
    url: '/api/audit?action=auth.login&limit=2',
    headers: sessionHeaders(cookies),
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json() as {
    data: { items: Array<{ id: string; action: string; at: string; request_id: string; after_hash: string }> };
    meta: { next_cursor: string | null };
  };
  assert.equal(firstBody.data.items.length, 2);
  assert.ok(firstBody.data.items.every((item) => item.action === 'auth.login'));
  assert.ok(firstBody.data.items.every((item) => item.after_hash.length === 64));
  assert.ok(firstBody.meta.next_cursor);

  const second = await app.inject({
    method: 'GET',
    url: `/api/audit?action=auth.login&limit=2&cursor=${encodeURIComponent(firstBody.meta.next_cursor!)}`,
    headers: sessionHeaders(cookies),
  });
  assert.equal(second.statusCode, 200, second.body);
  const secondBody = second.json() as { data: { items: Array<{ id: string }> } };
  assert.ok(secondBody.data.items.length >= 1);
  assert.notEqual(secondBody.data.items[0]!.id, firstBody.data.items[0]!.id);

  const viewerLogin = await login(app, viewer.email, VIEWER_PASSWORD);
  const forbidden = await app.inject({
    method: 'GET',
    url: '/api/audit',
    headers: sessionHeaders(cookiesFrom(viewerLogin)),
  });
  assert.equal(forbidden.statusCode, 403);
});

test('错误响应使用统一信封并回显 request_id', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-request-id': 'client-req-123' },
    payload: { email: 'nobody@test.local', password: 'whatever' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.headers['x-request-id'], 'client-req-123');
  const body = response.json() as {
    request_id: string;
    error: { code: string; retryable: boolean; next_action: string };
  };
  assert.equal(body.request_id, 'client-req-123');
  assert.equal(body.error.code, 'unauthorized');
  assert.equal(body.error.retryable, false);
  assert.equal(body.error.next_action, 'login');
});
