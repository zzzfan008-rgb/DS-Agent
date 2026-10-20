'use client';

/** M3 浏览器侧读写封装：同源 `/api/*`、CSRF 双提交、Idempotency-Key、If-Match。 */
import { failureFromResponse, parseApiResponse, type ApiFailure, type ApiResult } from './api';

export function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const here = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?return_url=${encodeURIComponent(here)}`);
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ik_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: Record<string, unknown>;
  requestId: string | null;
}

/** 列表接口需要读 meta（next_cursor），因此单独解析完整信封。 */
export async function getEnvelope<T>(path: string, signal?: AbortSignal): Promise<ApiEnvelope<T>> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  const requestId = response.headers.get('x-request-id');
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw failureFromResponse(response.status, body, requestId);
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw {
      ok: false,
      status: response.status,
      code: 'invalid_response',
      message: '服务返回了无法识别的响应',
      requestId,
      nextAction: 'retry_later',
      retryable: true,
      detail: null,
    } satisfies ApiFailure;
  }
  const envelope = body as { data: T; meta?: unknown };
  return {
    data: envelope.data,
    meta:
      typeof envelope.meta === 'object' && envelope.meta !== null
        ? (envelope.meta as Record<string, unknown>)
        : {},
    requestId,
  };
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const envelope = await getEnvelope<T>(path, signal);
  return envelope.data;
}

export interface MutationOptions {
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function mutateJson<T>(
  path: string,
  options: MutationOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(options.headers ?? {}),
  };
  if (!(options.body instanceof FormData)) headers['content-type'] = 'application/json';  const csrf = readCookie('dssaas_csrf');
  if (csrf) headers['x-csrf-token'] = csrf;
  headers['idempotency-key'] = options.idempotencyKey ?? newIdempotencyKey();

  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body:
      options.body instanceof FormData
        ? options.body
        : options.body === undefined
          ? method === 'DELETE'
            ? undefined
            : '{}'
          : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseApiResponse<T>(response);
}

/** 表单/接口错误的统一提取（detail.issues / detail.rows_failed / message）。 */
export function failureSummary(failure: ApiFailure): string {
  const detail = failure.detail;
  if (detail) {
    const issues = detail.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0] as { message?: unknown; field?: unknown };
      if (typeof first.message === 'string') {
        return `${failure.message}：${typeof first.field === 'string' ? `${first.field} ` : ''}${first.message}`;
      }
    }
    const missing = detail.missing;
    if (Array.isArray(missing) && missing.length > 0) {
      return `${failure.message}：${missing.map(String).join('、')}`;
    }
  }
  return failure.message;
}
