/**
 * M9 kill switch 演练：验证"出事时能不能止住"。
 *
 * 两条证据链，缺一不可：
 *   A. 服务级 —— KillSwitchService.check() 的作用域匹配与 fail-closed 语义；
 *   B. HTTP 级 —— 真实 Fastify 应用 + 真实写入门（S1.5 预检 / S5 权威检），
 *      证明"开了开关，写请求真的被 503 kill_switch_on 挡住"，而不只是服务对象返回了 hit。
 *
 * 覆盖（对应 docs/M9-上线检查清单 项 20）：
 *   1) global/block_writes 阻断 publish 与 1688/stock
 *   2) task_type=publish 只停 publish，不影响 stock
 *   3) expires_at 已过的开关不生效
 *   4) DB 查询抛错 → fail-closed（必须阻断，不能放行）
 *   5) 停用（enabled=false）后恢复放行
 *   6) readonly 也阻断写
 *   7) kill switch 的 create/disable 留审计
 *
 * 用法（必须用隔离库，库名以 _test 结尾）：
 *   cd apps/api
 *   DATABASE_URL="postgresql://.../dssaas_m9drill_test?schema=public" \
 *     TEST_DATABASE_URL="$DATABASE_URL" LOG_LEVEL=silent \
 *     ./node_modules/.bin/tsx test/killswitch-drill.mts
 *
 * 退出码：0 全通过；1 有失败；2 环境不满足（非隔离库/缺数据）。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { KillSwitchService, type KillSwitchCheckInput } from '../src/write-gate/kill-switch.js';
import { hashPassword } from '../src/lib/password.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
if (!DB_URL) {
  console.error('[drill] 缺少 DATABASE_URL/TEST_DATABASE_URL');
  process.exit(2);
}
const dbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  console.error(`[drill] 拒绝在非隔离库上演练：${dbName}（库名必须以 _test 结尾）`);
  process.exit(2);
}

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const createdSwitchIds: string[] = [];
const createdListingIds: string[] = [];
const createdProductIds: string[] = [];
const SUFFIX = randomUUID().slice(0, 8);
/** spu_code 有 CHECK：^[A-Z0-9][A-Z0-9-]{3,39}$（大写下划线不合法），所以单独准备一个大写后缀。 */
const SPU_SUFFIX = SUFFIX.toUpperCase();

function record(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ------------------------------------------------------------
// 服务级断言
// ------------------------------------------------------------
async function expectBlocked(svc: KillSwitchService, input: KillSwitchCheckInput, label: string) {
  try {
    const hit = await svc.check(input);
    if (!hit) {
      record(label, false, '未阻断（放行了）');
      return;
    }
    record(label, true, `命中 ${hit.scopeType}/${hit.action} mode=${hit.mode}`);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? (error as Error)?.message;
    record(label, code === 'kill_switch_on', `抛出 ${code}`);
  }
}

async function expectAllowed(svc: KillSwitchService, input: KillSwitchCheckInput, label: string) {
  try {
    const hit = await svc.check(input);
    record(label, hit === null, hit ? `误阻断 ${hit.scopeType}/${hit.scopeKey}` : '放行');
  } catch (error) {
    record(label, false, `异常 ${(error as { code?: string })?.code ?? (error as Error)?.message}`);
  }
}

// ------------------------------------------------------------
// 数据准备
// ------------------------------------------------------------
async function ensureUser(email: string, password: string, roleCode: string, displayName: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  if (existing) return existing.id;
  const user = await prisma.user.create({
    data: {
      orgId: 1n,
      email,
      displayName,
      passwordHash: await hashPassword(password),
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
  return user.id;
}

async function addSwitch(data: {
  scopeType: 'global' | 'platform' | 'category' | 'task_type';
  scopeKey: string;
  action: 'block_writes' | 'block_replies' | 'block_media' | 'block_model' | 'readonly';
  mode?: 'block' | 'drain';
  enabledBy: string;
  reason?: string;
  expiresAt?: Date | null;
}) {
  const row = await prisma.killSwitch.create({
    data: {
      orgId: 1n,
      scopeType: data.scopeType,
      scopeKey: data.scopeKey,
      action: data.action,
      mode: data.mode ?? 'block',
      enabled: true,
      reason: data.reason ?? 'M9 drill',
      enabledBy: data.enabledBy,
      expiresAt: data.expiresAt ?? null,
    },
  });
  createdSwitchIds.push(row.id);
  return row;
}

async function disableSwitch(id: string, disabledBy: string) {
  await prisma.killSwitch.update({
    where: { id },
    data: { enabled: false, disabledBy, disabledAt: new Date() },
  });
}

// ------------------------------------------------------------
// HTTP 客户端
// ------------------------------------------------------------
interface Session {
  cookie: string;
  csrf: string;
}

let apiBase = '';

async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await response.json()) as { data?: { csrf_token?: string } };
  if (!response.ok) throw new Error(`登录失败 ${response.status} ${JSON.stringify(json)}`);
  const setCookies =
    response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = (setCookies as Array<string | null | undefined>)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value.startsWith('dssaas_sid=') || value.startsWith('dssaas_csrf='))
    .join('; ');
  return { cookie, csrf: json.data?.csrf_token ?? '' };
}

async function call(
  method: string,
  urlPath: string,
  session: Session,
  body?: unknown,
): Promise<{ status: number; code: string | null; raw: string }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['idempotency-key'] = `drill-${randomUUID()}`;
  }
  const response = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? null;
  } catch {
    code = null;
  }
  return { status: response.status, code, raw };
}

function expectHttp(
  label: string,
  actual: { status: number; code: string | null },
  expected: { status: number; code?: string },
) {
  const pass = actual.status === expected.status && (!expected.code || actual.code === expected.code);
  record(
    label,
    pass,
    `HTTP ${actual.status} ${actual.code ?? ''}${pass ? '' : `（期望 ${expected.status} ${expected.code ?? ''}）`}`,
  );
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main(): Promise<number> {
  const adminId = await ensureUser(
    `drill.admin.${SUFFIX}@test.local`,
    'DrillAdminPassword!2026',
    'admin',
    'M9 演练管理员',
  );
  const operatorId = await ensureUser(
    `drill.operator.${SUFFIX}@test.local`,
    'DrillOperatorPassword!2026',
    'operator',
    'M9 演练运营',
  );

  // 演练用的商品 + listing（stock 写入需要真实 listing 才能走到 kill switch 检查点）
  const product = await prisma.product.create({
    data: {
      orgId: 1n,
      spuCode: `DRILL-KS-${SPU_SUFFIX}`,
      name: 'kill switch 演练商品',
      categoryCode: 'A0101',
      createdBy: operatorId,
    },
  });
  createdProductIds.push(product.id);
  const listing = await prisma.listing.create({
    data: { orgId: 1n, platform: '1688', productId: product.id, status: 'draft', createdBy: operatorId },
  });
  createdListingIds.push(listing.id);

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
  });
  const app: FastifyInstance = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('拿不到监听端口');
  apiBase = `http://127.0.0.1:${address.port}`;

  const admin = await login(`drill.admin.${SUFFIX}@test.local`, 'DrillAdminPassword!2026');
  const operator = await login(`drill.operator.${SUFFIX}@test.local`, 'DrillOperatorPassword!2026');

  const svc = new KillSwitchService(prisma, app.audit);

  const publishBody = { product_id: product.id, platform: '1688', sku_ids: [], mode: 'dry_run' };
  const stockBody = {
    action: 'listing.update_stock',
    platform: '1688',
    listing_id: listing.id,
    payload: { skus: [{ sku_id: 's1', stock_qty: 5 }] },
    mode: 'dry_run',
  };

  // ---------- 基线：无开关时写请求应越过 kill switch，停在 S2 approval ----------
  console.log('\n--- 基线（无开关）---');
  expectHttp('基线：POST /listings/publish 未被 kill switch 拦截（应到 428 approval_required）', 
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 428, code: 'approval_required' });
  expectHttp('基线：POST /listings/write(stock) 未被 kill switch 拦截（应到 428 approval_required）',
    await call('POST', '/api/listings/write', operator, stockBody), { status: 428, code: 'approval_required' });
  await expectAllowed(svc, { platform: 'pdd', taskType: 'publish' }, '基线：服务级 check() 放行');

  // ---------- 1) global/block_writes ----------
  console.log('\n--- 1) global/block_writes ---');
  const globalSwitch = await addSwitch({
    scopeType: 'global',
    scopeKey: '*',
    action: 'block_writes',
    enabledBy: adminId,
  });
  expectHttp('1) HTTP publish 被 503 kill_switch_on 阻断',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 503, code: 'kill_switch_on' });
  expectHttp('1) HTTP 1688/stock 被 503 kill_switch_on 阻断',
    await call('POST', '/api/listings/write', operator, stockBody), { status: 503, code: 'kill_switch_on' });
  await expectBlocked(svc, { platform: 'pdd', taskType: 'publish' }, '1) 服务级 publish 命中');
  await expectBlocked(svc, { platform: '1688', taskType: 'stock' }, '1) 服务级 1688/stock 命中');

  // ---------- 5) 停用后恢复放行 ----------
  console.log('\n--- 5) 停用后恢复 ---');
  await disableSwitch(globalSwitch.id, adminId);
  expectHttp('5) 停用 global 后 publish 恢复（回到 428 approval_required）',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 428, code: 'approval_required' });
  await expectAllowed(svc, { platform: 'pdd', taskType: 'publish' }, '5) 服务级停用后放行');

  // ---------- 2) task_type=publish 精确停 ----------
  console.log('\n--- 2) task_type=publish 精确停 ---');
  const publishSwitch = await addSwitch({
    scopeType: 'task_type',
    scopeKey: 'publish',
    action: 'block_writes',
    enabledBy: adminId,
  });
  expectHttp('2) task_type=publish 阻断 publish',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 503, code: 'kill_switch_on' });
  expectHttp('2) task_type=publish 不影响 stock（仍 428 approval_required）',
    await call('POST', '/api/listings/write', operator, stockBody), { status: 428, code: 'approval_required' });
  await expectBlocked(svc, { platform: 'pdd', taskType: 'publish' }, '2) 服务级 publish 命中');
  await expectAllowed(svc, { platform: 'pdd', taskType: 'stock' }, '2) 服务级 stock 放行');
  await disableSwitch(publishSwitch.id, adminId);

  // ---------- 3) 过期开关不生效 ----------
  console.log('\n--- 3) 过期开关 ---');
  const expiredSwitch = await addSwitch({
    scopeType: 'platform',
    scopeKey: '1688',
    action: 'block_writes',
    enabledBy: adminId,
    expiresAt: new Date(Date.now() - 60_000),
  });
  expectHttp('3) expires_at 已过 → publish 不受影响（428）',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 428, code: 'approval_required' });
  await expectAllowed(svc, { platform: '1688', taskType: 'publish' }, '3) 服务级过期开关放行');
  await disableSwitch(expiredSwitch.id, adminId);

  // ---------- 4) fail-closed ----------
  console.log('\n--- 4) fail-closed（DB 查询抛错）---');
  const brokenPrisma = {
    killSwitch: {
      findMany: async () => {
        throw new Error('simulated db outage');
      },
    },
  } as unknown as PrismaClient;
  const brokenSvc = new KillSwitchService(brokenPrisma, app.audit);
  await expectBlocked(brokenSvc, { platform: 'pdd', taskType: 'publish' }, '4) DB 抛错 → fail-closed 阻断');
  try {
    await brokenSvc.assertNotBlocked({ platform: 'pdd', taskType: 'stock' });
    record('4) fail-closed 时 assertNotBlocked 抛 kill_switch_on', false, '未抛异常（放行了）');
  } catch (error) {
    const apiError = error as { code?: string; detail?: { guard?: string } };
    record(
      '4) fail-closed 时 assertNotBlocked 抛 kill_switch_on',
      apiError.code === 'kill_switch_on' && apiError.detail?.guard === 'unavailable',
      `code=${apiError.code} guard=${apiError.detail?.guard}`,
    );
  }

  // ---------- 6) readonly 也阻断写 ----------
  console.log('\n--- 6) readonly ---');
  const readonlySwitch = await addSwitch({
    scopeType: 'global',
    scopeKey: '*',
    action: 'readonly',
    enabledBy: adminId,
  });
  expectHttp('6) global/readonly 阻断 publish 写',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 503, code: 'kill_switch_on' });
  expectHttp('6) global/readonly 阻断 stock 写',
    await call('POST', '/api/listings/write', operator, stockBody), { status: 503, code: 'kill_switch_on' });
  await expectBlocked(svc, { platform: 'pdd', taskType: 'publish' }, '6) 服务级 readonly 命中');
  // 读请求不受影响
  expectHttp('6) readonly 不影响读（GET /api/products 200）',
    await call('GET', '/api/products?limit=5', operator), { status: 200 });

  // ---------- 7) 审计留痕 ----------
  console.log('\n--- 7) 审计留痕 ---');
  // 7.1 走 HTTP 创建（真实链路：路由 → KillSwitchService.create → audit.record）
  const httpCreate = await call('POST', '/api/kill-switch', admin, {
    scope_type: 'task_type',
    scope_key: 'message',
    action: 'block_replies',
    mode: 'block',
    reason: 'M9 drill http path',
    drill: true,
  });
  let httpSwitchId: string | null = null;
  if (httpCreate.status === 201) {
    const body = JSON.parse(httpCreate.raw) as { data?: { id?: string } };
    httpSwitchId = body.data?.id ?? null;
    if (httpSwitchId) createdSwitchIds.push(httpSwitchId);
  }
  record('7) HTTP POST /api/kill-switch 创建成功', httpCreate.status === 201, `HTTP ${httpCreate.status}`);

  const createAudit = httpSwitchId
    ? await prisma.auditLog.findFirst({
        // drill=true 的开关按 docs/11 §9 记 `kill_switch.drill`（演练与真实停写可区分）
        where: {
          resourceType: 'kill_switch',
          resourceId: httpSwitchId,
          action: { in: ['kill_switch.create', 'kill_switch.drill'] },
        },
        select: { action: true, after: true, requestId: true, actorId: true },
      })
    : null;
  record(
    '7) kill_switch.create/drill 有审计',
    Boolean(createAudit),
    createAudit ? `action=${createAudit.action} request_id=${createAudit.requestId}` : 'missing',
  );
  const anyAfter = createAudit?.after as Record<string, unknown> | undefined;
  record(
    '7) 审计含 scope_type/scope_key/action/drill',
    Boolean(anyAfter?.scope_type && anyAfter?.scope_key && anyAfter?.action && anyAfter?.drill === true),
    JSON.stringify(anyAfter ?? {}),
  );

  // 7.2 越权：operator 不能创建
  const operatorCreate = await call('POST', '/api/kill-switch', operator, {
    scope_type: 'global',
    scope_key: '*',
    action: 'block_writes',
    reason: 'operator 不应能建',
  });
  record(
    '7) operator 不能创建 kill switch（403 forbidden）',
    operatorCreate.status === 403 && operatorCreate.code === 'forbidden',
    `HTTP ${operatorCreate.status} ${operatorCreate.code ?? ''}`,
  );

  // 停用留痕
  await call('POST', `/api/kill-switch/${readonlySwitch.id}/disable`, admin, {
    reason: 'drill 结束，恢复写',
    confirm: true,
  });
  const disableAudit = await prisma.auditLog.findFirst({
    where: { resourceType: 'kill_switch', resourceId: readonlySwitch.id, action: 'kill_switch.disable' },
    select: { action: true, before: true, after: true },
  });
  record('7) kill_switch.disable 有审计', Boolean(disableAudit), disableAudit ? 'found' : 'missing');
  expectHttp('5b) HTTP disable 后 publish 恢复（428）',
    await call('POST', '/api/listings/publish', operator, publishBody), { status: 428, code: 'approval_required' });

  await app.close();
  return results.filter((row) => !row.pass).length === 0 ? 0 : 1;
}

// ------------------------------------------------------------
// 执行 + 清理
// ------------------------------------------------------------
let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('[drill] 演练异常终止：', error);
  exitCode = 1;
} finally {
  try {
    if (createdSwitchIds.length > 0) {
      await prisma.killSwitch.updateMany({
        where: { id: { in: createdSwitchIds } },
        data: { enabled: false, archivedAt: new Date() },
      });
    }
    if (createdListingIds.length > 0) {
      await prisma.listing.updateMany({
        where: { id: { in: createdListingIds } },
        data: { archivedAt: new Date() },
      });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.updateMany({
        where: { id: { in: createdProductIds } },
        data: { archivedAt: new Date() },
      });
    }
  } catch (error) {
    console.error('[drill] 清理失败（演练数据可能残留）：', error);
    exitCode = 1;
  }
  await prisma.$disconnect();
}

const failed = results.filter((row) => !row.pass);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  for (const row of failed) console.log(`  FAILED: ${row.name} — ${row.detail}`);
}
process.exit(exitCode);
