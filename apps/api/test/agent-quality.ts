/**
 * t42 质量对照：20 条客服场景 × reasoning=off/high。
 *
 * 运行（Host 配置需与 QUALITY_MODE 对应；见 dev-host.patch.yml reasoningEffort）：
 *   QUALITY_MODE=off  ... pnpm --filter @dssaas/api exec tsx test/agent-quality.ts
 *   QUALITY_MODE=high ... pnpm --filter @dssaas/api exec tsx test/agent-quality.ts
 *
 * 输出 JSON：scenario 元数据 + 实际回复 + 时延/tokens/cost/tool_calls。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const email = process.env.QUALITY_AGENT_EMAIL ?? 'quality.agent@test.local';
const password = process.env.QUALITY_AGENT_PASSWORD ?? 'QualityAgentPassword!2026';
const mode = process.env.QUALITY_MODE ?? 'off';
const scenarioFile =
  process.env.QUALITY_SCENARIOS ?? 'D:/DSSAAS/data/golden/customer-scenarios.json';

interface Scenario {
  id: string;
  category: string;
  spu_code: string;
  question: string;
  facts: Record<string, unknown>;
  expected: Record<string, unknown>;
  forbidden: string[];
}

interface SseEvent {
  name: string;
  data: Record<string, any> | null;
}

function parseFrames(buffer: string, events: SseEvent[]): string {
  let index = buffer.indexOf('\n\n');
  while (index >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    let name = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') name = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length > 0) {
      try {
        events.push({ name, data: JSON.parse(dataLines.join('\n')) as Record<string, any> });
      } catch {
        events.push({ name, data: null });
      }
    }
    index = buffer.indexOf('\n\n');
  }
  return buffer;
}

function cookiesFrom(headers: string[]): Record<string, string> {
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
      displayName: '质量对照操作员',
      passwordHash,
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
}

async function main(): Promise<void> {
  const parsed = JSON.parse(readFileSync(scenarioFile, 'utf8')) as { scenarios: Scenario[] };
  const scenarios = parsed.scenarios;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    LOG_LEVEL: 'silent',
  });
  await ensureOperator();
  const app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  const samples: Array<Record<string, any>> = [];
  try {
    const loginResponse = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = (await loginResponse.json()) as Record<string, any>;
    if (loginResponse.status !== 200) throw new Error(`login failed: ${JSON.stringify(loginBody)}`);
    const cookies = cookiesFrom(loginResponse.headers.getSetCookie());
    const cookieHeader = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const csrf = String(loginBody.data.csrf_token ?? cookies.dssaas_csrf ?? '');

    for (const scenario of scenarios) {
      const startedAt = Date.now();
      const createResponse = await fetch(`${base}/api/agent/run`, {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          'x-request-id': `quality-${mode}-${scenario.id}`,
        },
        body: JSON.stringify({
          intent: 'support.suggest',
          context: { page: 'inbox', object_type: 'conversation', object_id: randomUUID() },
          input: {
            text: scenario.question,
            params: { ...scenario.facts, reply_max_chars: 180 },
          },
          stream: true,
          timeout_ms: 60_000,
          first_token_timeout_ms: 30_000,
        }),
      });
      const createBody = (await createResponse.json()) as Record<string, any>;
      if (createResponse.status !== 202) {
        samples.push({
          ...scenario,
          status: `create_${createResponse.status}`,
          error: createBody,
          total_ms: Date.now() - startedAt,
          output: '',
          tool_calls: [],
        });
        continue;
      }
      const runId = String(createBody.data.run_id);
      const events: SseEvent[] = [];
      const sseResponse = await fetch(`${base}/api/agent/runs/${runId}/events`, {
        headers: { cookie: cookieHeader, accept: 'text/event-stream' },
      });
      const reader = sseResponse.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 90_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error(`SSE timeout ${scenario.id}`);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseFrames(buffer, events);
        if (events.some((event) => event.name === 'run.finished' || event.name === 'run.error')) break;
      }
      await reader.cancel().catch(() => undefined);
      const viewResponse = await fetch(`${base}/api/agent/runs/${runId}`, {
        headers: { cookie: cookieHeader },
      });
      const viewBody = (await viewResponse.json()) as Record<string, any>;
      const view = viewBody.data ?? null;
      const startedEvent = events.find((event) => event.name === 'run.started');
      const firstDelta = events.find((event) => event.name === 'run.delta');
      const toolCalls = events
        .filter((event) => event.name === 'run.tool_call')
        .map((event) => String(event.data?.payload?.tool ?? 'unknown'));
      samples.push({
        id: scenario.id,
        category: scenario.category,
        spu_code: scenario.spu_code,
        question: scenario.question,
        expected: scenario.expected,
        forbidden: scenario.forbidden,
        status: view?.status ?? 'unknown',
        output: view?.output?.text ?? '',
        total_ms: Date.now() - startedAt,
        first_delta_ms:
          startedEvent?.data?.ts && firstDelta?.data?.ts
            ? Date.parse(String(firstDelta.data.ts)) - Date.parse(String(startedEvent.data.ts))
            : null,
        tokens_in: view?.tokens?.in ?? null,
        tokens_out: view?.tokens?.out ?? null,
        cost_cents: view?.cost_cents ?? null,
        tool_calls: toolCalls,
        error: events.find((event) => event.name === 'run.error')?.data?.payload ?? null,
      });
      // 等待 Host 空闲，避免下一场景撞并发
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const token = config.dshBridgeToken ?? (config.dshBridgeTokenFile ? readFileSync(config.dshBridgeTokenFile, 'utf8').trim() : '');
          const health = await fetch(`${config.dshBridgeUrl}/internal/health`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const body = (await health.json()) as Record<string, any>;
          if (health.status === 200 && body.active_runs === 0) break;
        } catch {
          // 继续等待
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    console.log(
      JSON.stringify(
        {
          mode,
          model: 'deepseek-flash',
          scenario_file: scenarioFile,
          generated_at: new Date().toISOString(),
          samples,
        },
        null,
        2,
      ),
    );
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
