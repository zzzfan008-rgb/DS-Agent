/**
 * t3 验收冒烟：真实 HTTP + 本地 Host（协议桩）+ DSH_BRIDGE_TOKEN_FILE。
 *
 * 两种模式：
 *   SMOKE_MODE=stream     → POST /api/agent/run（202）→ GET events（SSE）收齐 hello…run.finished
 *   SMOKE_MODE=host-down  → Host 未启动时 POST 必须返回可读 503 dsh_unavailable
 *
 * 依赖：DATABASE_URL（测试库）、DSH_BRIDGE_URL、DSH_BRIDGE_TOKEN_FILE。
 * 运行：
 *   SMOKE_MODE=stream pnpm --filter @dssaas/api exec tsx test/agent-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

const mode = process.env.SMOKE_MODE ?? 'stream';
const email = process.env.SMOKE_AGENT_EMAIL ?? 'smoke.agent@test.local';
const password = process.env.SMOKE_AGENT_PASSWORD ?? 'SmokeAgentPassword!2026';
const prisma = new PrismaClient();

async function ensureOperator(): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { code: 'operator', archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  const passwordHash = await hashPassword(password);
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, status: 'active', failedAttempts: 0, lockedUntil: null },
    });
    const membership = await prisma.membership.findFirst({
      where: { orgId: 1n, userId: existing.id, roleId: role.id },
    });
    if (membership) {
      await prisma.membership.update({ where: { id: membership.id }, data: { status: 'active' } });
    } else {
      await prisma.membership.create({
        data: { orgId: 1n, userId: existing.id, roleId: role.id, status: 'active' },
      });
    }
    return;
  }
  const user = await prisma.user.create({
    data: {
      orgId: 1n,
      email,
      displayName: 'Agent 冒烟操作员',
      passwordHash,
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
}

function parseCookies(headers: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of headers) {
    const first = header.split(';')[0]!;
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    if (name === 'dssaas_sid' || name === 'dssaas_csrf') cookies[name] = first.slice(index + 1);
  }
  return cookies;
}

interface SseEvent {
  name: string;
  id: string | null;
  data: Record<string, any> | null;
}

function parseFrames(buffer: string, events: SseEvent[]): string {
  let index = buffer.indexOf('\n\n');
  while (index >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    let name = 'message';
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'id') id = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length > 0) {
      try {
        events.push({ name, id, data: JSON.parse(dataLines.join('\n')) as Record<string, any> });
      } catch {
        events.push({ name, id, data: null });
      }
    }
    index = buffer.indexOf('\n\n');
  }
  return buffer;
}

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    LOG_LEVEL: 'silent',
  });
  if (config.dshBridgeTokenFile) {
    // 启动自检：生产要求令牌文件可读，失败即拒绝启动（docs/14 §4.3）。
    const token = readFileSync(config.dshBridgeTokenFile, 'utf8').trim();
    if (!token) throw new Error('DSH_BRIDGE_TOKEN_FILE 为空');
  }
  await ensureOperator();
  const app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const result: Record<string, any> = {
    mode,
    base,
    bridge_url: config.dshBridgeUrl,
    token_source: config.dshBridgeToken ? 'env:DSH_BRIDGE_TOKEN' : `file:${config.dshBridgeTokenFile}`,
  };

  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = (await loginResponse.json()) as Record<string, any>;
    if (loginResponse.status !== 200) throw new Error(`login failed: ${JSON.stringify(loginBody)}`);
    const cookies = parseCookies(loginResponse.headers.getSetCookie());
    const cookieHeader = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const csrf = String(loginBody.data.csrf_token);
    result.login = { status: loginResponse.status, cookie_names: Object.keys(cookies), role: loginBody.data.user.role };
    const health = await fetch(`${base}/api/health`);
    const healthBody = (await health.json()) as Record<string, any>;
    result.health = {
      status: health.status,
      dsh_host: healthBody?.data?.checks?.dsh_host,
      detail: healthBody?.data?.checks?.dsh_host_detail ?? null,
      agent: healthBody?.data?.checks?.agent ?? null,
    };

    const idempotencyKey = randomUUID();
    const runStartedAt = Date.now();
    const createResponse = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
        'x-request-id': `smoke-${Date.now()}`,
      },
      body: JSON.stringify({
        intent: 'content.draft',
        context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID() },
        input: { text: '给这款风衣写拼多多标题，突出防风', params: { platform: 'pdd', length_max: 60 } },
        stream: true,
        timeout_ms: 30000,
      }),
    });
    const createBody = (await createResponse.json()) as Record<string, any>;
    result.create = { status: createResponse.status, body: createBody };
    if (mode === 'host-down') {
      result.expectation = '503 且错误码为 dsh_unavailable';
      result.pass =
        createResponse.status === 503 &&
        createBody?.error?.code === 'dsh_unavailable' &&
        typeof createBody?.error?.message === 'string' &&
        createBody.error.message.includes('DSH Host 不可达');
      const health = await fetch(`${base}/api/health`);
      const healthBody = (await health.json()) as Record<string, any>;
      result.health = { status: health.status, dsh_host: healthBody?.data?.checks?.dsh_host };
      console.log(JSON.stringify(result, null, 2));
      if (!result.pass) process.exitCode = 1;
      return;
    }
    if (createResponse.status !== 202) throw new Error(`run create failed: ${JSON.stringify(createBody)}`);
    const runId = String(createBody.data.run_id);

    const events: SseEvent[] = [];
    const sseResponse = await fetch(`${base}/api/agent/runs/${runId}/events`, {
      headers: { cookie: cookieHeader, accept: 'text/event-stream' },
    });
    result.sse = { status: sseResponse.status, content_type: sseResponse.headers.get('content-type') };
    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error('SSE 超时未收到 run.finished');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseFrames(buffer, events);
      if (events.some((event) => event.name === 'run.finished' || event.name === 'run.error')) break;
    }
    await reader.cancel().catch(() => undefined);

    const viewResponse = await fetch(`${base}/api/agent/runs/${runId}`, { headers: { cookie: cookieHeader } });
    const viewBody = (await viewResponse.json()) as Record<string, any>;
    result.run_id = runId;
    result.elapsed_ms = Date.now() - runStartedAt;
    result.event_sequence = events.map((event) => ({
      event: event.name,
      id: event.id,
      seq: event.data?.seq ?? null,
    }));
    result.finished = events.find((event) => event.name === 'run.finished')?.data ?? null;
    result.view = viewBody?.data ?? null;
    const names = result.event_sequence.map((item: { event: string }) => item.event);
    result.pass =
      names[0] === 'hello' &&
      names.includes('run.started') &&
      names.includes('run.delta') &&
      names.at(-1) === 'run.finished' &&
      viewBody?.data?.status === 'succeeded';
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
