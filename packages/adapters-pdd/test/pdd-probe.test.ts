/**
 * 拼多多连通性探针测试。
 *
 * 用注入的 fetchImpl 覆盖 6 种结果，不需要真实网络、不需要真实凭据。
 * 真实环境的连通用验收记录里的实测记录证明，不放进 CI（CI 无凭据）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probePddConnection } from '../src/http/pdd-probe.js';
import { PDD_GATEWAY } from '../src/http/pdd-signer.js';

const CREDS = { clientId: 'app123', clientSecret: 'secret456', accessToken: 'tok789' };

function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('成功：返回 ok，且请求打到官方网关、body 含 sign 与公共参数', async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const fetchImpl = mockFetch((url, init) => {
    captured = { url, body: JSON.parse(String(init.body)) };
    return jsonResponse({ time_get_response: { time: 1700000000 } });
  });

  const result = await probePddConnection({ ...CREDS, fetchImpl, timestamp: 1700000000 });

  assert.equal(result.outcome, 'ok');
  assert.equal(result.ok, true);
  assert.equal(result.gateway, PDD_GATEWAY);
  assert.equal(captured!.url, PDD_GATEWAY);
  assert.equal(captured!.body.type, 'pdd.time.get');
  assert.equal(captured!.body.client_id, 'app123');
  assert.equal(captured!.body.access_token, 'tok789');
  assert.match(String(captured!.body.sign), /^[0-9A-F]{32}$/);
});

test('clientId 无效（实测码 10016）：归类为 credential_invalid，提示核对 client_id', async () => {
  // 这个码是 2026-10-21 用无效凭据真实调用 gw-api.pinduoduo.com 得到的，
  // 不是猜的：{"error_code":10016,"error_msg":"client下线或者clientId不正确"}
  const fetchImpl = mockFetch(() =>
    jsonResponse({
      error_response: {
        error_msg: 'client下线或者clientId不正确',
        sub_msg: 'client下线或者clientId不正确',
        sub_code: '10016',
        error_code: 10016,
        request_id: '17925693750550058',
      },
    }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'credential_invalid');
  assert.equal(result.nextAction, 'recheck_client_id');
  assert.match(result.message, /client_id/);
  assert.equal(result.errorCode, 10016);
});

test('签名错误：error_response.error_code 归类为 signature_invalid，给出改 secret 的建议', async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse({ error_response: { error_code: 10001, error_msg: 'sign check fail', sub_code: 'sign_error' } }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'signature_invalid');
  assert.equal(result.ok, false);
  assert.equal(result.nextAction, 'recheck_client_secret');
  assert.equal(result.errorCode, 10001);
  assert.match(result.message, /client_secret/);
});

test('token 失效：归类为 token_invalid，建议重新授权', async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse({ error_response: { error_code: 10003, error_msg: 'access token invalid' } }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'token_invalid');
  assert.equal(result.nextAction, 'reauth');
});

test('权限不足：归类为 permission_denied，建议申请权限', async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse({ error_response: { error_code: 10004, error_msg: 'no permission' } }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'permission_denied');
  assert.equal(result.nextAction, 'apply_permission');
});

test('未收录错误码：不臆造分类，归 unknown_error 并保留原始码', async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse({ error_response: { error_code: 99999, error_msg: 'something odd' } }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'unknown_error');
  assert.equal(result.errorCode, 99999);
  assert.equal(result.nextAction, 'check_platform_error_doc');
  assert.match(result.message, /99999/);
});

test('未收录错误码但文案含「签名」：按文案兜底归类', async () => {
  const fetchImpl = mockFetch(() =>
    jsonResponse({ error_response: { error_code: 88888, error_msg: '签名不合法' } }),
  );
  const result = await probePddConnection({ ...CREDS, fetchImpl });
  assert.equal(result.outcome, 'signature_invalid');
});

test('网络不通：归类为 unreachable，消息含网关地址', async () => {
  const fetchImpl = mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'unreachable');
  assert.equal(result.nextAction, 'check_network_and_firewall');
  assert.match(result.message, /gw-api\.pinduoduo\.com/);
});

test('超时：归类为 unreachable，消息说明超时时长', async () => {
  const fetchImpl = mockFetch(async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  const result = await probePddConnection({ ...CREDS, fetchImpl, timeoutMs: 1234 });

  assert.equal(result.outcome, 'unreachable');
  assert.match(result.message, /超时（1234ms）/);
});

test('HTTP 200 但响应无法解析：归 unknown_error，不误判为成功', async () => {
  const fetchImpl = mockFetch(() => new Response('not-json', { status: 200 }));
  const result = await probePddConnection({ ...CREDS, fetchImpl });

  assert.equal(result.outcome, 'unknown_error');
  assert.equal(result.ok, false);
});

test('失败结果绝不返回 ok=true（防"乐观成功"）', async () => {
  const cases: Array<() => Response> = [
    () => jsonResponse({ error_response: { error_code: 10001 } }),
    () => jsonResponse({ error_response: { error_code: 10003 } }),
    () => jsonResponse({ error_response: { error_code: 10004 } }),
    () => jsonResponse({ error_response: { error_code: 99999 } }),
    () => new Response('bad', { status: 500 }),
  ];
  for (const make of cases) {
    const result = await probePddConnection({ ...CREDS, fetchImpl: mockFetch(make) });
    assert.equal(result.ok, false, `outcome=${result.outcome} 不应为 ok`);
  }
});

test('探针不重试：fetch 只被调用一次', async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls += 1;
    return jsonResponse({ error_response: { error_code: 10001 } });
  });
  await probePddConnection({ ...CREDS, fetchImpl });
  assert.equal(calls, 1);
});

test('响应体截断到 2000 字符，避免超大响应撑爆日志', async () => {
  const huge = { error_response: { error_code: 10001, error_msg: 'x'.repeat(5000) } };
  const fetchImpl = mockFetch(() => jsonResponse(huge));
  const result = await probePddConnection({ ...CREDS, fetchImpl });
  assert.ok(result.rawResponse !== null);
  assert.ok(result.rawResponse!.length <= 2001);
});
