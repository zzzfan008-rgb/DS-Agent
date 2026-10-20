/**
 * 统一 API 响应解析（docs/12 §1、§4）。
 *
 * 浏览器只访问同源 `/api/*`；服务端组件用 `API_INTERNAL_URL` 直连 Fastify 并转发 Cookie。
 * 失败 envelope：{ request_id, error: { code, message, retryable, next_action, detail } }
 */
import type { ApiErrorResponse } from './contracts';

export const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:3001';

export interface ApiFailure {
  ok: false;
  status: number;
  code: string;
  message: string;
  requestId: string | null;
  nextAction: string | null;
  retryable: boolean;
  detail: Record<string, unknown> | null;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T; requestId: string | null }
  | ApiFailure;

function headerValue(headers: Headers, name: string): string | null {
  return headers.get(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function failureFromResponse(
  status: number,
  body: unknown,
  requestId: string | null,
): ApiFailure {
  const envelope = isRecord(body) ? (body as Partial<ApiErrorResponse>) : null;
  const error = envelope && isRecord(envelope.error) ? envelope.error : null;
  return {
    ok: false,
    status,
    code: typeof error?.code === 'string' ? error.code : `http_${status}`,
    message:
      typeof error?.message === 'string'
        ? error.message
        : `请求失败（HTTP ${status}）`,
    requestId:
      (typeof envelope?.request_id === 'string' ? envelope.request_id : null) ??
      requestId ??
      null,
    nextAction: typeof error?.next_action === 'string' ? error.next_action : null,
    retryable: error?.retryable === true,
    detail: error && isRecord(error.detail) ? error.detail : null,
  };
}

export function failureFromUnknown(error: unknown): ApiFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    status: 0,
    code: 'network_error',
    message: `无法连接服务：${message}`,
    requestId: null,
    nextAction: 'retry_later',
    retryable: true,
    detail: null,
  };
}

/** 解析任意 HTTP 响应为 ApiResult；调用方负责把 404 等业务分支前置。 */
export async function parseApiResponse<T>(response: Response): Promise<ApiResult<T>> {
  const requestId = headerValue(response.headers, 'x-request-id');
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) return failureFromResponse(response.status, body, requestId);
  if (!isRecord(body) || !('data' in body)) {
    return {
      ok: false,
      status: response.status,
      code: 'invalid_response',
      message: '服务返回了无法识别的响应',
      requestId,
      nextAction: 'retry_later',
      retryable: true,
      detail: null,
    };
  }
  return { ok: true, status: response.status, data: (body as { data: T }).data, requestId };
}

/** 服务端组件请求：转发 Cookie，禁止缓存。 */
export async function serverFetchApi(
  path: string,
  cookieHeader: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (cookieHeader) headers.set('cookie', cookieHeader);
  return fetch(`${API_INTERNAL_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    signal: init?.signal ?? AbortSignal.timeout(8_000),
  });
}
