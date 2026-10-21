/**
 * t54 平台账号 API 验收 —— 增改查 / 测试连通（诚实失败）/ 归档 / 脱敏 / 审计。
 *
 * 核心断言不是"接口能用"，而是三条安全边界：
 * 1. 响应里**永不出现密钥实值**（连引用名的解析值也没有）；
 * 2. 误传明文 → 400 + 可读提示（不是 DB 23514 冒成 500）；
 * 3. 测试连通**必须**返回 ok:false + interfaces_unverified（平台 method 未核验，不许伪造成功）。
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
} from './helpers.js';

const PASSWORD = 'PlatformAccount!2026';
const SUFFIX = randomUUID().slice(0, 8).toUpperCase();

let app: FastifyInstance;
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;
let adminId: string;

/**
 * 一个"看起来像密钥"的长串：用于证明服务层会拒绝明文引用。
 *
 * 刻意**不**使用 `sk_live_` / `AKIA` / `ghp_` 这类真实密钥前缀，也不使用
 * 32 位十六进制——否则 GitHub secret scanning 会把测试夹具误判为泄露密钥并
 * 拒绝推送（GH013）。这里用 32 个重复字符，同样满足「≥24 位连续长串」这条
 * 服务层与 DB 层共用的判定，但不会被扫描器命中。
 */
const FAKE_SECRET = 'FAKESECRETFORTESTONLYDONOTUSE0123456789';

function idem(): Record<string, string> {
  return { 'idempotency-key': `t54-${randomUUID()}` };
}

async function post(path: string, payload: unknown, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, ...idem(), 'content-type': 'application/json' },
    payload: payload as Record<string, unknown>,
  });
}

before(async () => {
  app = await buildTestApp({ LOG_LEVEL: 'silent' });
  const admin = await createUser({ email: `t54-admin-${SUFFIX}@test.local`, password: PASSWORD, role: 'admin' });
  const operator = await createUser({ email: `t54-operator-${SUFFIX}@test.local`, password: PASSWORD, role: 'operator' });
  const viewer = await createUser({ email: `t54-viewer-${SUFFIX}@test.local`, password: PASSWORD, role: 'viewer' });
  adminId = admin.id;

  const adminLogin = await login(app, admin.email, PASSWORD);
  const operatorLogin = await login(app, operator.email, PASSWORD);
  const viewerLogin = await login(app, viewer.email, PASSWORD);
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(operatorLogin.statusCode, 200);
  assert.equal(viewerLogin.statusCode, 200);

  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
  viewerHeaders = sessionHeaders(cookiesFrom(viewerLogin), csrfFrom(viewerLogin));
});

after(async () => {
  if (app) await app.close();
});

test('权限：viewer 可 GET；viewer 写 → 403；operator 写 → 403（仅 admin）', async () => {
  const viewerRead = await app.inject({ method: 'GET', url: '/api/platform-accounts', headers: viewerHeaders });
  assert.equal(viewerRead.statusCode, 200, viewerRead.body);

  const viewerWrite = await post(
    '/api/platform-accounts',
    { platform: 'pdd', app_key: 'k', app_secret_ref: 'PDD_APP_SECRET' },
    viewerHeaders,
  );
  assert.equal(viewerWrite.statusCode, 403, viewerWrite.body);

  const operatorWrite = await post(
    '/api/platform-accounts',
    { platform: 'pdd', app_key: 'k', app_secret_ref: 'PDD_APP_SECRET' },
    operatorHeaders,
  );
  assert.equal(operatorWrite.statusCode, 403, '平台凭据配置只允许 admin');
});

test('新建 pdd 账号 → 201；响应与列表只给脱敏 app_key，绝无 secret 实值', async () => {
  const shopId = `SHOP-${SUFFIX}-A`;
  const created = await post(
    '/api/platform-accounts',
    {
      platform: 'pdd',
      shop_id: shopId,
      shop_name: '拼多多旗舰店',
      app_key: `pdd_app_key_${SUFFIX}`,
      app_secret_ref: 'PDD_APP_SECRET',
      access_token_ref: 'PDD_ACCESS_TOKEN',
      contract_version: 2,
      extra: { region: 'cn-east' },
    },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const createdBody = JSON.parse(created.body).data as { id: string; version: number; status: string; connectivity: string };
  assert.equal(createdBody.status, 'active');
  assert.equal(createdBody.connectivity, 'unknown', '新建即 unknown，未测试不能是 ok');

  // 列表里必须能看到，且 app_key 是脱敏形态
  const list = await app.inject({ method: 'GET', url: '/api/platform-accounts?platform=pdd', headers: viewerHeaders });
  assert.equal(list.statusCode, 200, list.body);
  const items = (JSON.parse(list.body).data as {
    items: Array<{
      id: string;
      platform: string;
      shop_id: string | null;
      app_key_masked: string;
      app_secret_ref: string;
      access_token_ref: string | null;
      connectivity: string;
      last_tested_at: string | null;
      contract_version: number;
      extra: unknown;
      version: number;
    }>;
  }).items;
  const mine = items.find((item) => item.id === createdBody.id);
  assert.ok(mine, '新建的账号必须出现在列表');
  assert.equal(mine!.shop_id, shopId);
  assert.equal(mine!.platform, 'pdd');
  assert.match(mine!.app_key_masked, /^\w{3}\*{4}\w{2}$/, 'app_key 必须脱敏');
  assert.ok(!mine!.app_key_masked.includes(SUFFIX), '脱敏后不得泄漏完整 key');
  // 引用名可以返回（它只是变量名）
  assert.equal(mine!.app_secret_ref, 'PDD_APP_SECRET');
  assert.equal(mine!.access_token_ref, 'PDD_ACCESS_TOKEN');
  assert.equal(mine!.connectivity, 'unknown');
  assert.equal(mine!.last_tested_at, null);
  assert.equal(mine!.contract_version, 2);
  assert.deepEqual(mine!.extra, { region: 'cn-east' });

  // 整个响应体不得出现任何"实值"字段
  const rawBody = list.body + created.body;
  for (const forbidden of ['app_secret:', 'access_token:', 'refresh_token:', FAKE_SECRET]) {
    assert.ok(!rawBody.includes(forbidden), `响应不得包含 ${forbidden}`);
  }
});

test('传明文 secret → 400，且提示"请传引用名"（不是 DB 500）', async () => {
  const plaintext = await post(
    '/api/platform-accounts',
    {
      platform: '1688',
      shop_id: `SHOP-${SUFFIX}-PLAIN`,
      app_key: `ali_key_${SUFFIX}`,
      // 把密钥明文直接粘进 ref 字段 —— 这是最容易发生的误操作
      app_secret_ref: FAKE_SECRET,
    },
    adminHeaders,
  );
  assert.equal(plaintext.statusCode, 400, plaintext.body);
  const body = JSON.parse(plaintext.body).error as { code: string; message: string; detail?: { field?: string; hint?: string } };
  assert.equal(body.code, 'validation_failed');
  assert.match(body.message, /引用名/);
  assert.match(body.message, /环境变量|Vault/);
  assert.equal(body.detail?.field, 'app_secret_ref');

  // 非法形状（含空格/中文等）同样 400
  const badShape = await post(
    '/api/platform-accounts',
    {
      platform: '1688',
      shop_id: `SHOP-${SUFFIX}-BAD`,
      app_key: 'k',
      app_secret_ref: '这是中文密钥 带空格',
    },
    adminHeaders,
  );
  assert.equal(badShape.statusCode, 400, badShape.body);

  // 库里不该留下这两条
  const leaked = await prisma.platformAccount.findMany({
    where: { shopId: { in: [`SHOP-${SUFFIX}-PLAIN`, `SHOP-${SUFFIX}-BAD`] } },
  });
  assert.equal(leaked.length, 0, '校验失败不得落库');
});

test('PATCH：正确 If-Match → 200；旧 version → 409；缺 If-Match → 422', async () => {
  const shopId = `SHOP-${SUFFIX}-PATCH`;
  const created = await post(
    '/api/platform-accounts',
    { platform: '1688', shop_id: shopId, app_key: `ali_${SUFFIX}`, app_secret_ref: 'ALI_APP_SECRET' },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const { id, version } = JSON.parse(created.body).data as { id: string; version: number };

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/platform-accounts/${id}`,
    headers: { ...adminHeaders, ...idem(), 'content-type': 'application/json', 'if-match': String(version) },
    payload: { shop_name: '1688 批发店（改名）', status: 'disabled', extra: { note: 't54' } },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  const patchedBody = JSON.parse(patched.body).data as { version: number; status: string };
  assert.equal(patchedBody.version, version + 1, 'version 必须 +1');
  assert.equal(patchedBody.status, 'disabled');

  // 旧 version → 409
  const stale = await app.inject({
    method: 'PATCH',
    url: `/api/platform-accounts/${id}`,
    headers: { ...adminHeaders, ...idem(), 'content-type': 'application/json', 'if-match': String(version) },
    payload: { shop_name: '再次改名' },
  });
  assert.equal(stale.statusCode, 409, stale.body);

  // 缺 If-Match → 422
  const missing = await app.inject({
    method: 'PATCH',
    url: `/api/platform-accounts/${id}`,
    headers: { ...adminHeaders, ...idem(), 'content-type': 'application/json' },
    payload: { shop_name: 'x' },
  });
  assert.equal(missing.statusCode, 422, missing.body);

  // PATCH 传明文同样被拦
  const plaintextPatch = await app.inject({
    method: 'PATCH',
    url: `/api/platform-accounts/${id}`,
    headers: {
      ...adminHeaders,
      ...idem(),
      'content-type': 'application/json',
      'if-match': String(patchedBody.version),
    },
    payload: { app_secret_ref: FAKE_SECRET },
  });
  assert.equal(plaintextPatch.statusCode, 400, plaintextPatch.body);
});

test('测试连通：必须诚实返回 ok:false + interfaces_unverified，绝不伪造成功', async () => {
  const shopId = `SHOP-${SUFFIX}-TEST`;
  const created = await post(
    '/api/platform-accounts',
    { platform: 'pdd', shop_id: shopId, app_key: `k_${SUFFIX}`, app_secret_ref: 'PDD_APP_SECRET' },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const { id } = JSON.parse(created.body).data as { id: string };

  const tested = await post(`/api/platform-accounts/${id}/test`, {}, adminHeaders);
  assert.equal(tested.statusCode, 200, tested.body);
  const body = JSON.parse(tested.body).data as {
    ok: boolean;
    connectivity: string;
    reason: string;
    message: string;
    tested_at: string;
  };
  // 核心断言：不许 ok:true
  assert.equal(body.ok, false, '接口未核验时不得返回 ok:true');
  assert.equal(body.connectivity, 'unknown', '没测出结论就必须是 unknown');
  assert.equal(body.reason, 'interfaces_unverified');
  assert.match(body.message, /尚未核验/);
  assert.ok(body.tested_at);

  // 结果写回库：last_tested_at 有值、connectivity 仍是 unknown、error 可读
  const row = await prisma.platformAccount.findUniqueOrThrow({ where: { id } });
  assert.ok(row.lastTestedAt, 'last_tested_at 必须写回');
  assert.equal(row.connectivity, 'unknown', 'connectivity 不得被写成 ok');
  assert.match(row.lastTestError ?? '', /interfaces_unverified/);

  // 列表里能看到"试过了但还是 unknown"
  const list = await app.inject({ method: 'GET', url: `/api/platform-accounts?platform=pdd`, headers: viewerHeaders });
  const item = (JSON.parse(list.body).data as {
    items: Array<{ id: string; connectivity: string; last_tested_at: string | null; last_test_error: string | null }>;
  }).items.find((entry) => entry.id === id);
  assert.ok(item);
  assert.equal(item!.connectivity, 'unknown');
  assert.ok(item!.last_tested_at);
  assert.match(item!.last_test_error ?? '', /interfaces_unverified/);
});

test('归档：归档后不出现在列表，且可重新接入同一店铺', async () => {
  const shopId = `SHOP-${SUFFIX}-ARCH`;
  const created = await post(
    '/api/platform-accounts',
    { platform: 'pdd', shop_id: shopId, app_key: `k_${SUFFIX}`, app_secret_ref: 'PDD_APP_SECRET' },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const { id } = JSON.parse(created.body).data as { id: string };

  const archived = await post(`/api/platform-accounts/${id}/archive`, {}, adminHeaders);
  assert.equal(archived.statusCode, 200, archived.body);

  const list = await app.inject({ method: 'GET', url: '/api/platform-accounts?platform=pdd', headers: viewerHeaders });
  const items = (JSON.parse(list.body).data as { items: Array<{ id: string }> }).items;
  assert.ok(!items.some((item) => item.id === id), '归档后不得出现在列表');

  // 详情也查不到（archived_at IS NULL 过滤）
  const detail = await app.inject({ method: 'GET', url: `/api/platform-accounts/${id}`, headers: viewerHeaders });
  assert.equal(detail.statusCode, 404, detail.body);

  // 部分唯一索引允许重新接入同一店铺
  const recreated = await post(
    '/api/platform-accounts',
    { platform: 'pdd', shop_id: shopId, app_key: `k2_${SUFFIX}`, app_secret_ref: 'PDD_APP_SECRET_2' },
    adminHeaders,
  );
  assert.equal(recreated.statusCode, 201, '归档后可重新接入同一店铺（uq 是 archived_at IS NULL 部分索引）');

  // 未归档的重复接入 → 409
  const duplicate = await post(
    '/api/platform-accounts',
    { platform: 'pdd', shop_id: shopId, app_key: `k3_${SUFFIX}`, app_secret_ref: 'PDD_APP_SECRET_3' },
    adminHeaders,
  );
  assert.equal(duplicate.statusCode, 409, duplicate.body);
});

test('审计：写操作有记录，且记录里无密钥明文', async () => {
  const shopId = `SHOP-${SUFFIX}-AUDIT`;
  const created = await post(
    '/api/platform-accounts',
    {
      platform: '1688',
      shop_id: shopId,
      shop_name: '审计测试店',
      app_key: `ali_audit_${SUFFIX}`,
      app_secret_ref: 'ALI_APP_SECRET_AUDIT',
    },
    adminHeaders,
  );
  assert.equal(created.statusCode, 201, created.body);
  const { id, version } = JSON.parse(created.body).data as { id: string; version: number };

  await app.inject({
    method: 'PATCH',
    url: `/api/platform-accounts/${id}`,
    headers: { ...adminHeaders, ...idem(), 'content-type': 'application/json', 'if-match': String(version) },
    payload: { shop_name: '审计测试店（改）' },
  });
  await post(`/api/platform-accounts/${id}/test`, {}, adminHeaders);
  await post(`/api/platform-accounts/${id}/archive`, {}, adminHeaders);

  const rows = await prisma.auditLog.findMany({
    where: { resourceType: 'platform_account', resourceId: id },
    orderBy: { occurredAt: 'asc' },
    select: { action: true, actorId: true, before: true, after: true },
  });
  const actions = rows.map((row) => row.action);
  for (const expected of [
    'platform_account.create',
    'platform_account.update',
    'platform_account.test',
    'platform_account.archive',
  ]) {
    assert.ok(actions.includes(expected), `审计缺少 ${expected}（实际：${actions.join(',')}）`);
  }
  assert.ok(rows.every((row) => row.actorId === adminId), '审计必须记录操作人');

  // 审计里不得出现明文密钥；引用名也应脱敏
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(FAKE_SECRET), '审计不得含明文密钥');
  assert.ok(!serialized.includes('ALI_APP_SECRET_AUDIT'), '审计里的引用名也应脱敏');
  assert.match(serialized, /\*{4}/, '审计应记录脱敏形态（含 ****）');
});
