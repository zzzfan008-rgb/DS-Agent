#!/usr/bin/env node
/** M9 SSE 心跳复核：单连接 35s，打印原始帧计数，确认 /events/stream 心跳是否真的发出。 */
import { PrismaClient } from '../../packages/db/src/index.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { hashPassword } from '../../apps/api/src/lib/password.ts';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
let app;
try {
  const role = await prisma.role.findFirstOrThrow({ where: { code: 'admin', archivedAt: null } });
  const email = 'm9.sse@test.local';
  let user = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        orgId: 1n,
        email,
        displayName: 'M9 SSE',
        passwordHash: await hashPassword('M9SsePassword!2026'),
        status: 'active',
        totpEnabled: false,
      },
    });
    await prisma.membership.create({ data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' } });
  }
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
  });
  app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'M9SsePassword!2026' }),
  });
  const json = await login.json();
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  const stream = await fetch(`${base}/api/events/stream`, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: AbortSignal.timeout(35_000),
  });
  console.log('status', stream.status, 'content-type', stream.headers.get('content-type'));
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const started = Date.now();
  for (;;) {
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5_000)),
    ]);
    if (result.timeout) {
      console.log(`[${Date.now() - started}ms] read timeout; buffered=${JSON.stringify(text.slice(-160))}`);
      continue;
    }
    if (result.done) {
      console.log(`[${Date.now() - started}ms] done`);
      break;
    }
    const chunk = decoder.decode(result.value, { stream: true });
    text += chunk;
    console.log(`[${Date.now() - started}ms] chunk=${JSON.stringify(chunk.slice(0, 120))}`);
    if (Date.now() - started > 34_000) break;
  }
  console.log('heartbeats=', (text.match(/: hb /g) ?? []).length, 'snapshots=', (text.match(/event: unread\.snapshot/g) ?? []).length);
} finally {
  try {
    await app?.close();
  } catch {}
  await prisma.$disconnect().catch(() => {});
}
