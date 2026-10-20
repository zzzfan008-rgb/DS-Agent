/**
 * 录制回放服务器（零依赖，node:http）。
 *
 * 只绑定 127.0.0.1 随机端口；回放用例只访问该地址，配合测试断言不触达真实平台。
 * 匹配规则：method + pathname + query 完全一致（fixture 中敏感 query 已是占位符）。
 */

import http from 'node:http';

function normalizeQuery(query) {
  const entries = [...query.entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function bodyTextOf(body) {
  if (body === undefined) return '';
  return typeof body === 'string' ? body : JSON.stringify(body);
}

export async function startReplayServer(fixtures, { host = '127.0.0.1' } = {}) {
  const routes = new Map();
  for (const { fixture } of fixtures) {
    const key = `${fixture.request.method} ${fixture.request.path} ${normalizeQuery(
      new URLSearchParams(fixture.request.query ?? {}),
    )}`;
    // 同一请求可能有多条录制（成功 / 429 / 业务驳回），按加载顺序依次回放。
    if (!routes.has(key)) routes.set(key, []);
    routes.get(key).push(fixture);
  }

  const calls = [];
  const unmatched = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const key = `${req.method} ${url.pathname} ${normalizeQuery(url.searchParams)}`;
    const queue = routes.get(key);
    // 重复路由按顺序消费；用完后继续返回最后一条，避免回放顺序变化导致误判。
    const fixture = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : undefined;
    calls.push({ key, at: new Date().toISOString() });

    if (!fixture) {
      unmatched.push(key);
      res.writeHead(501, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'no_fixture', key }));
      return;
    }

    const respond = () => {
      res.writeHead(fixture.response.status, {
        'content-type': 'application/json; charset=utf-8',
        ...fixture.response.headers,
      });
      res.end(bodyTextOf(fixture.response.body));
    };
    const delay = fixture.response.delay_ms ?? 0;
    if (delay > 0) setTimeout(respond, delay);
    else respond();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const baseUrl = `http://${host}:${address.port}`;

  return {
    baseUrl,
    calls,
    unmatched,
    routes,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** 回放一条 fixture，返回服务端响应与原始 HTTP 信息。 */
export async function replayFixture(fixture, server) {
  const url = new URL(fixture.request.path, server.baseUrl);
  for (const [key, value] of Object.entries(fixture.request.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const headers = {};
  for (const [key, value] of Object.entries(fixture.request.headers ?? {})) {
    headers[key] = String(value);
  }
  const hasBody = fixture.request.body !== undefined;
  if (hasBody && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json; charset=utf-8';
  }

  const response = await fetch(url, {
    method: fixture.request.method,
    headers,
    body: hasBody ? bodyTextOf(fixture.request.body) : undefined,
  });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}
