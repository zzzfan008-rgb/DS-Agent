/**
 * 可配置 mock 平台（零依赖，node:http）。
 * 每个故障场景一个实例；测试结束后 close() 并强制断开悬挂连接。
 */

import http from 'node:http';

export async function startMockPlatform(mode, options = {}) {
  const failures = options.failures ?? 3;
  const retryAfterSeconds = options.retryAfterSeconds ?? 1;
  const state = {
    hits: 0,
    requests: [],
    effects: 0,
    deliveries: 0,
    seenEvents: new Set(),
    retryIds: [],
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    state.hits += 1;
    state.requests.push({ method: req.method, url: req.url, body });

    const json = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(payload));
    };

    // 部分成功后的失败项重试入口（与主场景解耦）
    if (req.url === '/batch-retry') {
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      state.retryIds.push(...ids);
      json(200, { success: true, retried: ids });
      return;
    }

    switch (mode) {
      case 'http_5xx':
        if (state.hits <= failures) {
          json(502, { success: false, error_code: 'UPSTREAM_5XX', error_msg: 'bad gateway' });
        } else {
          json(200, { success: true, result: { ok: true } });
        }
        break;

      case 'rate_limit':
        if (state.hits <= failures) {
          json(
            429,
            { success: false, error_code: 'RATE_LIMIT', error_msg: '请求过于频繁' },
            { 'retry-after': String(retryAfterSeconds) },
          );
        } else {
          json(200, { success: true, result: { ok: true } });
        }
        break;

      case 'read_timeout':
        // 已发出响应头与部分 body，随后挂起：客户端必须判定「结果未知」
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.write('{"success":true,');
        break;

      case 'partial_success': {
        const results = Array.from({ length: 10 }, (_, index) => ({
          id: `item-${index + 1}`,
          ok: ![2, 5, 8].includes(index),
          error_code: [2, 5, 8].includes(index) ? 'ITEM_REJECT' : null,
        }));
        json(200, { success: true, results });
        break;
      }

      case 'batch_retry': {
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        state.retryIds.push(...ids);
        json(200, { success: true, retried: ids });
        break;
      }

      case 'duplicate_callback': {
        state.deliveries += 1;
        const eventId = body?.event_id ?? '(missing)';
        const deduped = state.seenEvents.has(eventId);
        if (!deduped) {
          state.seenEvents.add(eventId);
          state.effects += 1;
        }
        json(200, { success: true, deduped });
        break;
      }

      case 'contract_drift_missing':
        // 缺少 item.add schema 要求的 result.goods_id
        json(200, { success: true, result: { created_at: '2026-10-20T02:00:00.000Z' } });
        break;

      case 'contract_drift_type':
        // goods_id 应为 string，实际 number
        json(200, { success: true, result: { goods_id: 123456, created_at: '2026-10-20T02:00:00.000Z' } });
        break;

      case 'html_error':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>502 Bad Gateway</h1></body></html>');
        break;

      case 'signature_invalid':
        json(401, { success: false, errorCode: '401', errorMessage: '签名校验失败' });
        break;

      case 'ok':
        json(200, { success: true, result: { ok: true } });
        break;

      default:
        json(500, { success: false, error_code: 'MOCK_MODE_UNKNOWN', error_msg: mode });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
