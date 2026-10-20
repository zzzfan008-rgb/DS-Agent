/**
 * M9 SSE 长连接压测：验证并发连接下的内存、心跳与稳定性。
 *
 * 目的：找出"多少个 SSE 连接会让进程出问题"，而不是刷一个好看的数字。
 * 用法：
 *   DATABASE_URL=... TEST_DATABASE_URL=... node --experimental-strip-types apps/api/test/sse-load.mts
 *
 * 观察点：
 * 1) 建连成功率与建连耗时
 * 2) 心跳是否按时到达（15s 间隔）
 * 3) 连接期间 RSS 增长
 * 4) 断开后是否释放（RSS 回落 / 句柄数）
 */
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

const prisma = new PrismaClient();
const CONNECTIONS = Number(process.env.SSE_CONNECTIONS ?? 100);
const HOLD_MS = Number(process.env.SSE_HOLD_MS ?? 60000);
const HEARTBEAT_MS = 15000;

const email = 'sse.load@test.local';
const password = 'SseLoadPassword!2026';

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function ensureUser() {
  const role = await prisma.role.findFirstOrThrow({ where: { code: 'viewer', archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) return existing.id;
  const row = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      displayName: 'SSE Load',
      status: 'active',
      createdBy: existing?.id ?? null,
    },
  });
  await prisma.membership.create({
    data: { userId: row.id, roleId: role.id, status: 'active' },
  });
  return row.id;
}

const app = await buildApp(loadConfig());
await app.ready();

// 登录取 cookie
const login = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  headers: { 'content-type': 'application/json' },
  payload: { email, password },
});
if (login.statusCode !== 200) {
  console.error('登录失败', login.statusCode, login.body);
  process.exit(2);
}
const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0];

const baselineRss = rssMb();
const connectStartedAt = Date.now();
const openedAt = [];
const heartbeats = [];
const errors = [];
const closes = [];

/** 用 app.inject 无法做流式；这里用真实监听 + fetch 流。 */
const address = await app.listen({ port: 0, host: '127.0.0.1' });
const base = address.replace('127.0.0.1', 'localhost');

async function openOne(index) {
  const controller = new AbortController();
  try {
    const res = await fetch(`${base}/api/events/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      errors.push({ index, status: res.status });
      return null;
    }
    openedAt.push(Date.now() - connectStartedAt);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const started = Date.now();
    // 读一段时间，记录心跳与首帧
    (async () => {
      try {
        while (Date.now() - started < HOLD_MS) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf('\n\n');
          while (idx >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (frame.includes('event: heartbeat') || frame.includes(': hb')) {
              heartbeats.push(Date.now() - started);
            }
            idx = buffer.indexOf('\n\n');
          }
        }
      } catch {
        /* abort 正常 */
      } finally {
        controller.abort();
        closes.push(index);
      }
    })();
    return controller;
  } catch (err) {
    errors.push({ index, err: String(err) });
    return null;
  }
}

console.log(`[sse] 基线 RSS ${baselineRss}MB，准备建 ${CONNECTIONS} 个连接`);
const controllers = [];
for (let i = 0; i < CONNECTIONS; i += 1) {
  const c = await openOne(i);
  if (c) controllers.push(c);
}
const connectElapsed = Date.now() - connectStartedAt;
const afterConnectRss = rssMb();

console.log(`[sse] 建连完成：成功 ${openedAt.length}/${CONNECTIONS}，耗时 ${connectElapsed}ms，RSS ${afterConnectRss}MB`);

// 保持一段时间观察心跳与内存
await new Promise((r) => setTimeout(r, HOLD_MS));
const duringRss = rssMb();

// 全部断开
for (const c of controllers) c.abort();
await new Promise((r) => setTimeout(r, 3000));
const afterCloseRss = rssMb();

const heartbeatOk = heartbeats.length >= Math.floor(HOLD_MS / HEARTBEAT_MS) * openedAt.length * 0.8;
const sortedOpen = [...openedAt].sort((a, b) => a - b);

const report = {
  generated_at: new Date().toISOString(),
  connections_requested: CONNECTIONS,
  connections_ok: openedAt.length,
  connect_errors: errors.length,
  connect_elapsed_ms: connectElapsed,
  connect_p50_ms: sortedOpen[Math.floor(sortedOpen.length * 0.5)] ?? 0,
  connect_p95_ms: sortedOpen[Math.floor(sortedOpen.length * 0.95)] ?? 0,
  connect_max_ms: sortedOpen[sortedOpen.length - 1] ?? 0,
  hold_ms: HOLD_MS,
  heartbeats_received: heartbeats.length,
  heartbeats_expected_min: Math.floor(HOLD_MS / HEARTBEAT_MS) * openedAt.length,
  heartbeat_ok: heartbeatOk,
  rss: {
    baseline_mb: baselineRss,
    after_connect_mb: afterConnectRss,
    during_mb: duringRss,
    after_close_mb: afterCloseRss,
    per_connection_kb:
      openedAt.length > 0 ? Math.round(((afterConnectRss - baselineRss) * 1024) / openedAt.length) : 0,
    released_after_close_mb: duringRss - afterCloseRss,
  },
};

console.log(JSON.stringify(report, null, 2));
await app.close();
await prisma.$disconnect();
