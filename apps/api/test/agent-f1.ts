/**
 * t23 F1 真实 Host 采样：同一 reply_draft（support.suggest）输入重复 N 次，
 * 记录首 token / 总时延 / tokens / cost / tool_call，用于改造前后对比。
 *
 * 运行（Host 已由 scripts/dev/start-dsh-host.ps1 启动）：
 *   DSH_BRIDGE_URL=http://127.0.0.1:43181 \
 *   DSH_BRIDGE_TOKEN_FILE=D:/DSSAAS/dsh-bundle/.dev-home/secrets/bridge-token \
 *   F1_MODE=injected F1_RUNS=5 \
 *   pnpm --filter @dssaas/api exec tsx test/agent-f1.ts
 *
 * 基线（Host 配置 skillInjection.enabled=false 时）：
 *   F1_MODE=baseline F1_RUNS=3 F1_FIRST_TOKEN_TIMEOUT_MS=30000 ...
 *
 * 只读观测：不写业务表（除 run/audit 自带），不改 Host 配置。
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const email = process.env.F1_AGENT_EMAIL ?? 'f1.agent@test.local';
const password = process.env.F1_AGENT_PASSWORD ?? 'F1AgentPassword!2026';
const runs = Math.max(1, Math.min(Number(process.env.F1_RUNS ?? 5), 10));
const intent = process.env.F1_INTENT ?? 'support.suggest';
const mode = process.env.F1_MODE ?? 'injected';
const firstTokenOverride = process.env.F1_FIRST_TOKEN_TIMEOUT_MS
  ? Number(process.env.F1_FIRST_TOKEN_TIMEOUT_MS)
  : undefined;
const runTimeoutMs = Number(process.env.F1_RUN_TIMEOUT_MS ?? 60_000);
const inputText =
  process.env.F1_INPUT_TEXT ??
  '客户问：我身高 165、体重 60kg，这件风衣选什么码？收到后不合适能退吗？请给我一段可以直接发给客户的回复。';

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
      displayName: 'F1 采样操作员',
      passwordHash,
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function hostIdle(config: { dshBridgeUrl: string; dshBridgeToken: string | null; dshBridgeTokenFile: string | null }, timeoutMs = 3000): Promise<boolean> {
  const token = config.dshBridgeToken ?? (config.dshBridgeTokenFile ? readFileSync(config.dshBridgeTokenFile, 'utf8').trim() : '');
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${config.dshBridgeUrl}/internal/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as Record<string, any>;
      if (response.status === 200 && body.active_runs === 0) return true;
    } catch {
      // 忽略瞬时错误
    }
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function main(): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    LOG_LEVEL: 'silent',
  });
  // 静态估算（不依赖 Host 内部模块）：用于对比「注入体积」；实际 prompt tokens 看 run view。
  let injectionEstimate: Record<string, unknown> | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync('D:/DSSAAS/dsh-bundle/manifest.json', 'utf8'),
    ) as { intents?: Record<string, { skills?: string[] }> };
    const refs = manifest.intents?.[intent]?.skills ?? [];
    const skills = refs.map((ref) => {
      const at = ref.lastIndexOf('@');
      const name = ref.slice(0, at);
      const version = ref.slice(at + 1);
      const path = `D:/DSSAAS/dsh-bundle/skills/${name}/${version}/SKILL.md`;
      const body = readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\s*/, '').trim();
      const bytes = Buffer.byteLength(body, 'utf8');
      return { ref, bytes, tokens_estimate: Math.max(1, Math.ceil([...body].length / 1.6)) };
    });
    const bytes = skills.reduce((sum, skill) => sum + skill.bytes, 0);
    injectionEstimate = {
      skills: skills.map((skill) => skill.ref),
      bytes,
      tokens_estimate: Math.max(1, Math.ceil(bytes / 1.6)),
    };
  } catch (error) {
    injectionEstimate = { error: error instanceof Error ? error.message : String(error) };
  }

  await ensureOperator();
  const app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

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

    const samples: Array<Record<string, any>> = [];
    for (let index = 1; index <= runs; index += 1) {
      const startedAt = Date.now();
      const createResponse = await fetch(`${base}/api/agent/run`, {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
          'x-request-id': `f1-${mode}-${index}-${Date.now()}`,
        },
        body: JSON.stringify({
          intent,
          context: { page: 'inbox', object_type: 'conversation', object_id: randomUUID() },
          input: { text: inputText, params: { platform: 'pdd', tone: 'friendly' } },
          stream: true,
          timeout_ms: runTimeoutMs,
          ...(firstTokenOverride === undefined ? {} : { first_token_timeout_ms: firstTokenOverride }),
        }),
      });
      const createBody = (await createResponse.json()) as Record<string, any>;
      if (createResponse.status !== 202) {
        samples.push({
          index,
          status: `create_${createResponse.status}`,
          error: createBody,
          total_ms: Date.now() - startedAt,
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
      const deadline = Date.now() + runTimeoutMs + 30_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error('SSE 超时未收到终态');
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = parseFrames(buffer, events);
        if (events.some((event) => event.name === 'run.finished' || event.name === 'run.error')) break;
      }
      await reader.cancel().catch(() => undefined);

      const startedEvent = events.find((event) => event.name === 'run.started');
      const firstDelta = events.find((event) => event.name === 'run.delta');
      const finished = events.find((event) => event.name === 'run.finished')?.data ?? null;
      const errorEvent = events.find((event) => event.name === 'run.error')?.data ?? null;
      const viewResponse = await fetch(`${base}/api/agent/runs/${runId}`, {
        headers: { cookie: cookieHeader },
      });
      const viewBody = (await viewResponse.json()) as Record<string, any>;
      const view = viewBody.data ?? null;
      const toolCalls = events
        .filter((event) => event.name === 'run.tool_call')
        .map((event) => String(event.data?.tool ?? 'unknown'));

      samples.push({
        index,
        run_id: runId,
        status: view?.status ?? (errorEvent ? 'run_error' : 'unknown'),
        error: errorEvent,
        started_ts: startedEvent?.data?.ts ?? null,
        first_delta_ts: firstDelta?.data?.ts ?? null,
        first_delta_after_started_ms:
          startedEvent?.data?.ts && firstDelta?.data?.ts
            ? Date.parse(String(firstDelta.data.ts)) - Date.parse(String(startedEvent.data.ts))
            : null,
        total_ms: Date.now() - startedAt,
        api_first_token_ms: view?.first_token_ms ?? null,
        first_token_timeout_ms: view?.first_token_timeout_ms ?? null,
        tokens_in: view?.tokens?.in ?? null,
        tokens_out: view?.tokens?.out ?? null,
        cost_cents: view?.cost_cents ?? null,
        tool_calls: toolCalls,
        skill_tool_calls: toolCalls.filter((tool) => tool.toLowerCase().includes('skill')).length,
        ...(process.env.F1_DEBUG_EVENTS === '1'
          ? {
              event_sequence: events.map((event) => ({
                event: event.name,
                ts: event.data?.ts ?? null,
                tool: event.data?.payload?.tool ?? null,
                step: event.data?.payload?.step ?? null,
                code: event.data?.payload?.code ?? null,
              })),
            }
          : {}),
        output_chars: typeof view?.output?.text === 'string' ? view.output.text.length : 0,
        finished,
      });
      await hostIdle(config);
    }

    const firstDeltas = samples
      .map((sample) => sample.first_delta_after_started_ms)
      .filter((value): value is number => typeof value === 'number');
    const totals = samples
      .map((sample) => sample.total_ms)
      .filter((value): value is number => typeof value === 'number');
    const summary = {
      mode,
      intent,
      runs,
      success: samples.filter((sample) => sample.status === 'succeeded').length,
      first_delta_ms: {
        median: median(firstDeltas),
        max: firstDeltas.length ? Math.max(...firstDeltas) : null,
        min: firstDeltas.length ? Math.min(...firstDeltas) : null,
      },
      total_ms: {
        median: median(totals),
        max: totals.length ? Math.max(...totals) : null,
      },
      tokens_in_total: samples.reduce((sum, sample) => sum + (sample.tokens_in ?? 0), 0),
      tokens_out_total: samples.reduce((sum, sample) => sum + (sample.tokens_out ?? 0), 0),
      cost_cents_total: samples.reduce((sum, sample) => sum + (sample.cost_cents ?? 0), 0),
      skill_tool_calls: samples.reduce((sum, sample) => sum + (sample.skill_tool_calls ?? 0), 0),
    };
    console.log(JSON.stringify({ injection_estimate: injectionEstimate, summary, samples }, null, 2));
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
