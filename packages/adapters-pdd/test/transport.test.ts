import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { isPddError } from '../src/errors.js';
import { FetchTransport, assertSafeHttpUrl, type TransportRequest } from '../src/http/transport.js';

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function requestFor(url: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-custom': 'v1' },
    bodyText: '{"a":1}',
    timeoutMs: 2_000,
    maxResponseBytes: 1024,
    requestId: 'req_transport_test',
    interfaceKey: 'test.echo',
    ...overrides,
  };
}

test('FetchTransport 发送方法/头/体并解析 JSON 响应', async () => {
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-test-header': 'ok' });
      res.end(JSON.stringify({ method: req.method, body, custom: req.headers['x-custom'] }));
    });
  });
  try {
    const transport = new FetchTransport();
    const response = await transport.request(requestFor(`${server.url}/echo`));
    assert.equal(response.status, 200);
    assert.equal(response.truncated, false);
    assert.equal(response.headers['x-test-header'], 'ok');
    assert.deepEqual(response.body, { method: 'POST', body: '{"a":1}', custom: 'v1' });
  } finally {
    await server.close();
  }
});

test('FetchTransport 超过 maxResponseBytes 时截断并标记', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(200));
  });
  try {
    const transport = new FetchTransport();
    const response = await transport.request(requestFor(`${server.url}/big`, { maxResponseBytes: 32 }));
    assert.equal(response.truncated, true);
    assert.equal(response.bodyText.length, 32);
    assert.equal(response.body, undefined);
  } finally {
    await server.close();
  }
});

test('URL 安全校验：https 与本机 http 放行，其余 http/内嵌凭据/fragment 拒绝', () => {
  assert.doesNotThrow(() => assertSafeHttpUrl('https://api.pdd.example.invalid/openapi'));
  assert.doesNotThrow(() => assertSafeHttpUrl('http://127.0.0.1:8080/replay'));
  assert.doesNotThrow(() => assertSafeHttpUrl('http://localhost:8080/replay'));
  for (const url of [
    'http://api.pdd.example.invalid/openapi',
    'https://user:pass@api.pdd.example.invalid/openapi',
    'https://api.pdd.example.invalid/openapi#frag',
    'not-a-url',
  ]) {
    assert.throws(
      () => assertSafeHttpUrl(url),
      (error: unknown) => isPddError(error) && error.code === 'config_error',
      url,
    );
  }
});
