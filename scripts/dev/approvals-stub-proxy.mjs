#!/usr/bin/env node
/**
 * M1 验收专用 stub 代理（不参与运行时交付）。
 *
 * 目的：验证前端「审批 API 404 → 演示数据、非 404 → 错误态」的分支，
 * 同时让登录 / /me / 健康检查透传到真实 API（保持真实会话与 Cookie）。
 *
 * 用法：
 *   UPSTREAM_PORT=3101 PROXY_PORT=3102 APPROVALS_MODE=404 node scripts/dev/approvals-stub-proxy.mjs
 *   APPROVALS_MODE=500 时 GET /api/approvals* 返回 500，用于验证"非 404 不回退"。
 */
import http from 'node:http';

const TARGET_HOST = process.env.UPSTREAM_HOST ?? '127.0.0.1';
const TARGET_PORT = Number(process.env.UPSTREAM_PORT ?? 3101);
const PORT = Number(process.env.PROXY_PORT ?? 3102);
const MODE = process.env.APPROVALS_MODE ?? '404';

const server = http.createServer((request, response) => {
  const url = request.url ?? '/';
  const isApprovals = /^\/api\/approvals(\/|\?|$)/.test(url) && request.method === 'GET';

  if (isApprovals && (MODE === '404' || MODE === '500')) {
    const status = MODE === '404' ? 404 : 500;
    const body = {
      request_id: 'req_stub_approvals',
      error: {
        code: MODE === '404' ? 'not_found' : 'upstream_5xx',
        message:
          MODE === '404'
            ? '审批端点尚未实现（stub 模拟 404）'
            : '审批端点故障（stub 模拟 500）',
        retryable: MODE !== '404',
        next_action: MODE === '404' ? 'none' : 'retry_later',
      },
    };
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': 'req_stub_approvals',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
    return;
  }

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: url,
      method: request.method,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on('error', (error) => {
    response.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        request_id: 'req_stub_proxy',
        error: { code: 'upstream_5xx', message: String(error), retryable: true },
      }),
    );
  });

  request.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[approvals-stub] ${PORT} -> ${TARGET_HOST}:${TARGET_PORT} approvals=${MODE}`);
});
