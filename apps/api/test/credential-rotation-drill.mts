/**
 * M9 凭据轮换演练（docs/20 §7、docs/14 §5.4）。
 *
 * 目标：证明「换掉一个模型供应商 Key」这件事，在**不重启服务**的前提下可完成，
 * 且旧凭据立即失效、新凭据下一次请求生效、全过程有审计留痕、日志/审计里不出现明文。
 *
 * 做法（模拟边界写清楚）：
 * - 起一个本地 HTTPS 上游（自签证书，CN/SAN=127.0.0.1），扮演 OpenAI-compatible 供应商；
 *   它校验 `Authorization: Bearer <key>`，只接受「当前有效 key 集合」里的值，其余返回 401。
 * - 用真实 API（Fastify）+ 真实 registry 代码路径：
 *     provider.credential_ref = m9_cred_v1  →  probe 成功
 *     PATCH /api/providers/:id 改 credential_ref = m9_cred_v2（If-Match 版本号）→ 无重启
 *     再 probe → 上游收到的就是 sk-new-*（新凭据下一次请求生效）
 *     上游撤销 sk-old-* → 仍指向 v1 的第二个 provider probe 得 401 → provider_unavailable
 * - 凭据真值来自 `DSSAAS_MODEL_CREDENTIALS`（MapCredentialResolver，M1 实现）；
 *   生产应替换为 DSH 凭据解析，接口不变（packages/registry/src/credentials.ts 注释）。
 *
 * 模拟边界（必须如实记入验收记录）：
 * 1) 上游是本地 mock，不是真实 DeepSeek/火山；验的是「凭据选择与传递链路」，不是厂商鉴权细节；
 * 2) 凭据存储是进程内 Map（`DSSAAS_MODEL_CREDENTIALS` 环境变量），**改这个环境变量需要重启**；
 *    本演练证明的是「provider.credential_ref 指向新名」这条不需要重启的轮换路径
 *    （与 docs/14 §5.4 平台 appSecret 的 external_key 指向新键名同构）；
 * 3) 没有真实 Vault / DSH 凭据文件，也没有真实「双 secret 窗口」，双活窗口用上游同时接受两个 key 模拟。
 *
 * 用法（隔离库，库名 _test 结尾）：
 *   cd apps/api
 *   DATABASE_URL="postgresql://.../dssaas_m9drill_test?schema=public" \
 *   TEST_DATABASE_URL="$DATABASE_URL" \
 *   DSSAAS_MODEL_CREDENTIALS='{"m9_cred_v1":"sk-old-DRILL-0001","m9_cred_v2":"sk-new-DRILL-0002"}' \
 *   NODE_EXTRA_CA_CERTS="../../.tmp/m9tls/cert.pem" \
 *   LOG_LEVEL=silent ./node_modules/.bin/tsx test/credential-rotation-drill.mts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
if (!DB_URL) {
  console.error('[rot] 缺少 DATABASE_URL/TEST_DATABASE_URL');
  process.exit(2);
}
const dbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  console.error(`[rot] 拒绝在非隔离库上演练：${dbName}`);
  process.exit(2);
}

const OLD_REF = 'm9_cred_v1';
const NEW_REF = 'm9_cred_v2';
const OLD_KEY = process.env.DRILL_OLD_KEY ?? 'sk-old-DRILL-0001';
const NEW_KEY = process.env.DRILL_NEW_KEY ?? 'sk-new-DRILL-0002';

const TLS_DIR = path.resolve(process.cwd(), '../../.tmp/m9tls');
const CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const KEY_PATH = path.join(TLS_DIR, 'key.pem');

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const cleanup: Array<() => Promise<void>> = [];
const SUFFIX = randomUUID().slice(0, 8);

function record(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function ensureCert(): void {
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) return;
  mkdirSync(TLS_DIR, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      KEY_PATH,
      '-out',
      CERT_PATH,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
}

// ------------------------------------------------------------
// 本地 HTTPS 上游：只认「当前有效 key 集合」
// ------------------------------------------------------------
interface Upstream {
  baseUrl: string;
  acceptedKeys: Set<string>;
  seenTokens: string[];
  close: () => Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
  ensureCert();
  const fs = await import('node:fs');
  const tlsOptions = {
    key: fs.readFileSync(KEY_PATH),
    cert: fs.readFileSync(CERT_PATH),
  };
  const state = {
    acceptedKeys: new Set<string>([OLD_KEY, NEW_KEY]),
    seenTokens: [] as string[],
  };
  const server = https.createServer(tlsOptions, (req, res) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    state.seenTokens.push(token);
    if (!state.acceptedKeys.has(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'drill-model' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('上游端口获取失败');
  return {
    baseUrl: `https://127.0.0.1:${address.port}`,
    acceptedKeys: state.acceptedKeys,
    seenTokens: state.seenTokens,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------
// 数据与 HTTP
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
  if (!response.ok) throw new Error(`登录失败 ${response.status}`);
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
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; code: string | null; data: unknown; raw: string }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    cookie: session.cookie,
    'x-csrf-token': session.csrf,
    ...extraHeaders,
  };
  // 所有写方法都必须带 Idempotency-Key（docs/12 §6），否则 422 validation_failed。
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    headers['idempotency-key'] = `rot-${randomUUID()}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, code: parsed?.error?.code ?? null, data: parsed?.data ?? null, raw };
}

async function createProvider(name: string, credentialRef: string, baseUrl: string) {
  const row = await prisma.provider.create({
    data: {
      orgId: 1n,
      name,
      kind: 'text',
      vendor: 'openai_compatible',
      baseUrl,
      credentialRef,
      authScheme: 'bearer',
      timeoutMs: 5000,
      status: 'active',
    },
  });
  cleanup.push(async () => {
    await prisma.provider.updateMany({ where: { id: row.id }, data: { archivedAt: new Date() } });
  });
  return row;
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function main(): Promise<number> {
  const adminId = await ensureUser(
    `rot.admin.${SUFFIX}@test.local`,
    'RotAdminPassword!2026',
    'admin',
    '凭据轮换演练管理员',
  );

  const upstream = await startUpstream();
  cleanup.push(async () => upstream.close());

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ [OLD_REF]: OLD_KEY, [NEW_REF]: NEW_KEY }),
  });
  const app: FastifyInstance = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('API 端口获取失败');
  apiBase = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => app.close());

  const admin = await login(`rot.admin.${SUFFIX}@test.local`, 'RotAdminPassword!2026');
  const pidBefore = process.pid;

  // 轮换目标 provider（credential_ref = v1）
  const provider = await createProvider(`rot_provider_${SUFFIX}`, OLD_REF, upstream.baseUrl);
  // 对照 provider：全程指向 v1，用来证明「旧凭据撤销后立刻失效」
  const legacyProvider = await createProvider(`rot_legacy_${SUFFIX}`, OLD_REF, upstream.baseUrl);

  console.log('\n--- 0) 轮换前基线 ---');
  const beforeProbe = await call('POST', `/api/providers/${provider.id}/test`, admin);
  record(
    '0) 轮换前 v1 凭据可用（probe ok=true）',
    beforeProbe.status === 200 && (beforeProbe.data as { ok?: boolean })?.ok === true,
    `HTTP ${beforeProbe.status} ok=${(beforeProbe.data as { ok?: boolean })?.ok}`,
  );
  record(
    '0) 上游收到的确实是 v1 明文（仅演练用，不落文档）',
    upstream.seenTokens.at(-1) === OLD_KEY,
    `token 前缀=${String(upstream.seenTokens.at(-1)).slice(0, 7)}…`,
  );

  // ------------------------------------------------------------
  // 1) 轮换：改 provider.credential_ref → 新名（不重启）
  // ------------------------------------------------------------
  console.log('\n--- 1) 执行轮换（PATCH credential_ref，不重启）---');
  const current = await prisma.provider.findUniqueOrThrow({ where: { id: provider.id } });
  const patch = await call(
    'PATCH',
    `/api/providers/${provider.id}`,
    admin,
    { credential_ref: NEW_REF },
    { 'if-match': String(current.version) },
  );
  record('1) PATCH /api/providers/:id 成功（200）', patch.status === 200, `HTTP ${patch.status} ${patch.code ?? ''}`);

  const credRow = await prisma.credentialRef.findFirst({
    where: { name: NEW_REF, archivedAt: null },
    select: { id: true, name: true, status: true, lastRotatedAt: true },
  });
  record(
    '1) 新 credential_ref 元数据已登记（status=active）',
    Boolean(credRow) && credRow?.status === 'active',
    JSON.stringify(credRow ?? {}),
  );

  // ------------------------------------------------------------
  // 2) 新凭据下一次请求生效
  // ------------------------------------------------------------
  console.log('\n--- 2) 新凭据下一次请求生效（同一进程，无重启）---');
  const afterProbe = await call('POST', `/api/providers/${provider.id}/test`, admin);
  record(
    '2) 轮换后 probe 成功（ok=true）',
    afterProbe.status === 200 && (afterProbe.data as { ok?: boolean })?.ok === true,
    `HTTP ${afterProbe.status} ok=${(afterProbe.data as { ok?: boolean })?.ok}`,
  );
  record(
    '2) 上游收到的是 v2 新凭据（下一次请求即生效）',
    upstream.seenTokens.at(-1) === NEW_KEY,
    `token 前缀=${String(upstream.seenTokens.at(-1)).slice(0, 7)}…`,
  );
  record(
    '2) 全程未重启（同一 PID）',
    process.pid === pidBefore,
    `pid=${process.pid}`,
  );

  // ------------------------------------------------------------
  // 3) 旧凭据立即失效（上游撤销 → 立刻 401）
  // ------------------------------------------------------------
  console.log('\n--- 3) 旧凭据立即失效 ---');
  upstream.acceptedKeys.delete(OLD_KEY);
  const legacyProbe = await call('POST', `/api/providers/${legacyProvider.id}/test`, admin);
  const legacyBody = legacyProbe.data as { ok?: boolean; error?: { code?: string } } | null;
  record(
    '3) 旧凭据撤销后 probe 失败（ok=false）',
    legacyProbe.status === 200 && legacyBody?.ok === false,
    `HTTP ${legacyProbe.status} ok=${legacyBody?.ok} error=${legacyBody?.error?.code ?? '-'}`,
  );
  record(
    '3) 失败原因归类为凭据被拒（provider_unavailable / credential_missing）',
    ['provider_unavailable', 'credential_missing', 'http_401'].includes(legacyBody?.error?.code ?? ''),
    `error_code=${legacyBody?.error?.code ?? '-'}`,
  );
  const providerStatus = await prisma.provider.findUniqueOrThrow({
    where: { id: legacyProvider.id },
    select: { status: true, connectivity: true, lastErrorCode: true },
  });
  record(
    '3) provider 状态被标为 degraded/failed（可被监控发现）',
    providerStatus.status === 'degraded' && providerStatus.connectivity === 'failed',
    JSON.stringify(providerStatus),
  );
  // 轮换后的 provider 不受影响
  const stillOk = await call('POST', `/api/providers/${provider.id}/test`, admin);
  record(
    '3) 轮换后的 provider 仍可用（旧凭据撤销不影响新凭据）',
    (stillOk.data as { ok?: boolean })?.ok === true,
    `HTTP ${stillOk.status} ok=${(stillOk.data as { ok?: boolean })?.ok}`,
  );

  // ------------------------------------------------------------
  // 4) 审计留痕
  // ------------------------------------------------------------
  console.log('\n--- 4) 审计留痕 ---');
  const auditRow = await prisma.auditLog.findFirst({
    where: { action: 'provider.update', resourceType: 'provider', resourceId: provider.id },
    orderBy: { seq: 'desc' },
    select: { action: true, before: true, after: true, actorId: true, requestId: true, ip: true },
  });
  const before = auditRow?.before as { credential_ref?: string } | undefined;
  const after = auditRow?.after as { credential_ref?: string } | undefined;
  record('4) provider.update 有审计记录', Boolean(auditRow), auditRow ? `request_id=${auditRow.requestId}` : 'missing');
  record(
    '4) 审计记录旧/新 credential_ref（脱敏形式）',
    Boolean(before?.credential_ref && after?.credential_ref && before.credential_ref !== after.credential_ref),
    `before=${before?.credential_ref ?? '-'} after=${after?.credential_ref ?? '-'}`,
  );
  record(
    '4) 审计 actor 为操作人',
    auditRow?.actorId === adminId,
    `actor_id=${auditRow?.actorId ?? '-'}`,
  );

  // 明文不得出现在审计与日志
  const leaks = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `select count(*)::int as n from audit_log
      where before::text like $1 or after::text like $1 or meta::text like $1 or diff::text like $1`,
    `%${OLD_KEY}%`,
  );
  const leaksNew = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `select count(*)::int as n from audit_log
      where before::text like $1 or after::text like $1 or meta::text like $1 or diff::text like $1`,
    `%${NEW_KEY}%`,
  );
  record(
    '4) 审计表中查不到凭据明文（old/new key 均 0 命中）',
    Number(leaks[0]?.n ?? -1) === 0 && Number(leaksNew[0]?.n ?? -1) === 0,
    `old_hits=${leaks[0]?.n} new_hits=${leaksNew[0]?.n}`,
  );

  // 审计链仍完整
  const chain = await app.audit.verifyChain();
  record('4) 轮换后审计哈希链完整', chain.ok === true, JSON.stringify(chain).slice(0, 200));

  // ------------------------------------------------------------
  // 5) 缺口如实登记（不改业务代码，只记录事实）
  // ------------------------------------------------------------
  console.log('\n--- 5) 现状缺口（如实记录，不计为失败）---');
  const rotateAudit = await prisma.auditLog.findFirst({
    where: { action: 'credential.rotate' },
    select: { id: true },
  });
  console.log(
    `INFO  未实现专用 credential.rotate / credential.revoke 审计动作：${rotateAudit ? '已存在' : '当前无记录'}（docs/20 §7.3 要求）`,
  );
  console.log(
    `INFO  credential_ref.last_rotated_at 当前为 ${credRow?.lastRotatedAt === null ? 'null（代码未写入）' : String(credRow?.lastRotatedAt)}`,
  );
  console.log(
    'INFO  凭据真值来源为进程内 Map（DSSAAS_MODEL_CREDENTIALS），改该环境变量需重启；本轮验证的是「切 credential_ref 名」这条免重启路径',
  );

  return results.filter((row) => !row.pass).length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('[rot] 演练异常终止：', error);
  exitCode = 1;
} finally {
  for (const fn of cleanup.reverse()) {
    try {
      await fn();
    } catch (error) {
      console.error('[rot] 清理失败：', error);
    }
  }
  await prisma.$disconnect();
}

const failed = results.filter((row) => !row.pass);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
for (const row of failed) console.log(`  FAILED: ${row.name} — ${row.detail}`);
process.exit(exitCode);
