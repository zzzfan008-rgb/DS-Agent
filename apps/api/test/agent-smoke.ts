/**
 * t3/t18 验收冒烟：真实 HTTP + DSH Host。
 *
 * 模式（SMOKE_MODE）：
 *   stream     → POST /api/agent/run（202）→ GET events（SSE）收齐 hello…run.finished
 *   host-down  → Host 未启动时 POST 必须返回可读 503 dsh_unavailable
 *   cancel     → 真实 Host 中途取消：≤2s 终态 + Host active_runs 归零
 *   auth       → 直连桥接端点：缺失/错误/轮换后旧令牌均 401，正确令牌 200
 *
 * 依赖：DATABASE_URL（stream/host-down/cancel）、DSH_BRIDGE_URL、DSH_BRIDGE_TOKEN_FILE。
 * 运行：
 *   SMOKE_MODE=stream pnpm --filter @dssaas/api exec tsx test/agent-smoke.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
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

function bridgeToken(config: AppConfig): string {
  if (config.dshBridgeToken) return config.dshBridgeToken.trim();
  if (!config.dshBridgeTokenFile) throw new Error('缺少 DSH_BRIDGE_TOKEN / DSH_BRIDGE_TOKEN_FILE');
  return readFileSync(config.dshBridgeTokenFile, 'utf8').trim();
}

async function bridgeHealth(config: AppConfig, token: string): Promise<Record<string, any>> {
  const response = await fetch(`${config.dshBridgeUrl}/internal/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function bridgeHealthStatus(config: AppConfig, token: string, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${config.dshBridgeUrl}/internal/health`, {
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  await response.text().catch(() => undefined);
  return response.status;
}

async function waitForHostIdle(config: AppConfig, token: string, timeoutMs = 3000): Promise<{ idle: boolean; elapsed_ms: number; last: Record<string, any> | null }> {
  const started = Date.now();
  let last: Record<string, any> | null = null;
  for (;;) {
    const health = await bridgeHealth(config, token);
    last = health.body;
    if (health.status === 200 && health.body?.active_runs === 0) {
      return { idle: true, elapsed_ms: Date.now() - started, last };
    }
    if (Date.now() - started > timeoutMs) return { idle: false, elapsed_ms: Date.now() - started, last };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** auth 模式：直连 Host 桥接端点做令牌矩阵（不需要 DB / api）。 */
async function runAuthMatrix(config: AppConfig): Promise<void> {
  const tokenPath = config.dshBridgeTokenFile;
  if (!tokenPath) throw new Error('auth 模式需要 DSH_BRIDGE_TOKEN_FILE');
  const original = readFileSync(tokenPath, 'utf8').trim();
  const result: Record<string, any> = {
    mode,
    bridge_url: config.dshBridgeUrl,
    token_source: `file:${tokenPath}`,
  };
  try {
    const correct = await bridgeHealthStatus(config, original);
    const missing = await bridgeHealthStatus(config, '');
    const wrong = await bridgeHealthStatus(config, 'wrong-token-0123456789');
    result.correct_token = correct;
    result.missing_token = missing;
    result.wrong_token = wrong;

    // 模拟「过期」：Host 轮换令牌文件后，旧令牌立即失效。
    const rotated = `${randomUUID()}-${randomUUID()}`;
    writeFileSync(tokenPath, `${rotated}\n`, { encoding: 'utf8', mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const oldAfterRotate = await bridgeHealthStatus(config, original);
    const newAfterRotate = await bridgeHealthStatus(config, rotated);
    result.old_token_after_rotate = oldAfterRotate;
    result.new_token_after_rotate = newAfterRotate;

    result.pass =
      correct === 200 &&
      missing === 401 &&
      wrong === 401 &&
      oldAfterRotate === 401 &&
      newAfterRotate === 200;
  } finally {
    writeFileSync(tokenPath, `${original}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
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
  if (mode === 'auth') {
    await runAuthMatrix(config);
    return;
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

    const startedAt = Date.now();
    const createResponse = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': csrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        'x-request-id': `smoke-${Date.now()}`,
      },
      body: JSON.stringify({
        intent: 'content.draft',
        context: { page: 'copy_workbench', object_type: 'product', object_id: randomUUID() },
        input: {
          text:
            mode === 'cancel'
              ? '写一篇 1500 字的秋季风衣商品详情页文案，分 5 个小节，分别写版型、面料、搭配、洗护和尺码建议，尽量详细具体。'
              : '给这款风衣写拼多多标题，突出防风',
          params: { platform: 'pdd', length_max: 60 },
        },
        stream: true,
        timeout_ms: Number(process.env.SMOKE_RUN_TIMEOUT_MS ?? 30000),
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
    const deadline = Date.now() + Number(process.env.SMOKE_RUN_TIMEOUT_MS ?? 30000) + 60_000;
    let cancelRequestAt: number | null = null;
    let cancelResponse: Record<string, any> | null = null;

    for (;;) {
      if (Date.now() > deadline) throw new Error('SSE 超时未收到终态事件');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseFrames(buffer, events);
      if (
        mode === 'cancel' &&
        cancelRequestAt === null &&
        events.some((event) => event.name === 'run.delta')
      ) {
        cancelRequestAt = Date.now();
        const cancelResponseRaw = await fetch(`${base}/api/agent/runs/${runId}/cancel`, {
          method: 'POST',
          headers: {
            cookie: cookieHeader,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          },
          body: JSON.stringify({ reason: 't18 real host cancel smoke' }),
        });
        cancelResponse = {
          status: cancelResponseRaw.status,
          body: (await cancelResponseRaw.json().catch(() => ({}))) as Record<string, any>,
        };
      }
      if (events.some((event) => event.name === 'run.finished' || event.name === 'run.error')) break;
    }
    await reader.cancel().catch(() => undefined);
    result.run_id = runId;
    result.elapsed_ms = Date.now() - startedAt;
    result.event_sequence = events.map((event) => ({
      event: event.name,
      id: event.id,
      seq: event.data?.seq ?? null,
      ts: event.data?.ts ?? null,
    }));
    const startedEvent = events.find((event) => event.name === 'run.started');
    const firstDelta = events.find((event) => event.name === 'run.delta');
    result.first_delta_after_started_ms =
      startedEvent?.data?.ts && firstDelta?.data?.ts
        ? Date.parse(String(firstDelta.data.ts)) - Date.parse(String(startedEvent.data.ts))
        : null;
    result.finished = events.find((event) => event.name === 'run.finished')?.data ?? null;
    result.error_event = events.find((event) => event.name === 'run.error')?.data ?? null;

    let viewBody: Record<string, any>;
    if (mode === 'cancel') {
      const cancelStart = cancelRequestAt ?? Date.now();
      let cancelledAt: number | null = null;
      for (;;) {
        const view = await fetch(`${base}/api/agent/runs/${runId}`, { headers: { cookie: cookieHeader } });
        viewBody = (await view.json()) as Record<string, any>;
        if (viewBody?.data?.status === 'cancelled') {
          cancelledAt = Date.now();
          break;
        }
        if (Date.now() - cancelStart > 5000) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const token = bridgeToken(config);
      const hostIdle = await waitForHostIdle(config, token, 3000);
      result.cancel = {
        request_at: cancelRequestAt === null ? null : new Date(cancelRequestAt).toISOString(),
        response: cancelResponse,
        terminal_latency_ms: cancelledAt === null ? null : cancelledAt - cancelStart,
        view_status: viewBody?.data?.status ?? null,
        partial: viewBody?.data?.output?.partial ?? null,
        host_active_runs_after: hostIdle.last?.active_runs ?? null,
        host_release_ms: hostIdle.elapsed_ms,
        host_idle: hostIdle.idle,
      };
      result.view = viewBody?.data ?? null;
      result.pass =
        cancelResponse?.status === 200 &&
        cancelResponse?.body?.data?.status === 'cancelled' &&
        viewBody?.data?.status === 'cancelled' &&
        result.cancel.terminal_latency_ms !== null &&
        result.cancel.terminal_latency_ms <= 2000 &&
        hostIdle.idle === true;
      console.log(JSON.stringify(result, null, 2));
      if (!result.pass) process.exitCode = 1;
      return;
    }

    const viewResponse = await fetch(`${base}/api/agent/runs/${runId}`, { headers: { cookie: cookieHeader } });
    viewBody = (await viewResponse.json()) as Record<string, any>;
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
