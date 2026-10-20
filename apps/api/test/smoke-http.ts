/**
 * t2 真实 HTTP 冒烟（非 inject）：构建 app → listen 127.0.0.1:0 → fetch。
 * 覆盖：/health、登录、/me、/audit、登出、登出后 401。
 *
 * 前置：测试库已迁移 + seed 过一个 admin（SEED_ADMIN_EMAIL/PASSWORD）。
 * 运行：DATABASE_URL=... SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... tsx test/smoke-http.ts
 */
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

function parseSetCookie(headers: string[]): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const header of headers) {
    const first = header.split(';')[0]!;
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    if (name === 'dssaas_sid' || name === 'dssaas_csrf') {
      cookies[name] = first.slice(index + 1);
    }
  }
  return cookies;
}

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.error('缺少 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD');
    process.exitCode = 2;
    return;
  }

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp(config, { disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;
  const result: Record<string, unknown> = { base };

  try {
    const health = await fetch(`${base}/api/health`);
    result.health = { status: health.status, body: await health.json() };

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = (await login.json()) as {
      data: { csrf_token: string; user: { role: string } };
      request_id: string;
    };
    const cookies = parseSetCookie(login.headers.getSetCookie());
    result.login = {
      status: login.status,
      request_id: loginBody.request_id,
      role: loginBody.data.user.role,
      cookie_names: Object.keys(cookies),
    };
    const cookieHeader = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    const me = await fetch(`${base}/api/me`, { headers: { cookie: cookieHeader } });
    result.me = { status: me.status, body: await me.json() };

    const audit = await fetch(`${base}/api/audit?action=auth.login&limit=3`, {
      headers: { cookie: cookieHeader },
    });
    const auditBody = (await audit.json()) as {
      data: { items: Array<{ action: string; request_id: string }> };
    };
    result.audit = {
      status: audit.status,
      actions: auditBody.data.items.map((item) => item.action),
      request_ids: auditBody.data.items.map((item) => item.request_id),
    };

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': loginBody.data.csrf_token },
    });
    result.logout = { status: logout.status, body: await logout.json() };

    const meAfter = await fetch(`${base}/api/me`, { headers: { cookie: cookieHeader } });
    result.me_after_logout = { status: meAfter.status };
  } finally {
    await app.close();
  }

  console.log(JSON.stringify(result, null, 2));
}

void main();
