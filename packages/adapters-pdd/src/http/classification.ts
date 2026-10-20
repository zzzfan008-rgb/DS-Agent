/**
 * 失败分类（docs/15 §6：超时 / 5xx / 限流 / 平台业务拒绝 / 配置错误）。
 *
 * 平台响应包络**未核验**（docs/01 §2），因此业务错误的识别是保守启发式：
 * - HTTP 层：2xx = 成功，429/5xx = 可重试，401/403 = 认证失败，4xx = 平台拒绝；
 * - 包络层：仅识别 `success === false` / `error_code` / `error_response` 三种常见形态，
 *   命中即按 platform_reject（或限流）处理；未命中原样返回成功。
 * 核验后应在 `classifyHttpResponse` 里替换为官方错误码表。
 */

import { PddError } from '../errors.js';

export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
}

export function headerValue(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return null;
}

/** 解析 Retry-After：秒数或 HTTP-date；非法返回 null。 */
export function parseRetryAfterMs(headers: Record<string, string>, nowMs = Date.now()): number | null {
  const raw = headerValue(headers, 'retry-after');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

interface EnvelopeError {
  code: string | null;
  message: string | null;
}

/** 从未核验的响应中提取业务错误；识别不到返回 null。 */
export function extractEnvelopeError(body: unknown): EnvelopeError | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const nested =
    record.error_response && typeof record.error_response === 'object'
      ? (record.error_response as Record<string, unknown>)
      : null;
  const successFalse = record.success === false;
  const errorCode =
    typeof record.error_code === 'string'
      ? record.error_code
      : typeof nested?.error_code === 'string'
        ? nested.error_code
        : null;
  if (!successFalse && errorCode === null && !nested) return null;
  const message =
    typeof record.error_msg === 'string'
      ? record.error_msg
      : typeof record.message === 'string'
        ? record.message
        : typeof nested?.error_msg === 'string'
          ? nested.error_msg
          : null;
  return { code: errorCode, message };
}

function isRateLimitCode(code: string | null): boolean {
  if (!code) return false;
  return /rate[_-]?limit|too[_-]?many|throttl|qps|frequen/i.test(code);
}

/**
 * 成功返回 null；失败返回 PddError。
 * 调用方（PddClient）负责：retryable 的错误按策略重试，其余直接抛。
 */
export function classifyHttpResponse(response: HttpResponseLike, nowMs = Date.now()): PddError | null {
  const { status } = response;
  const retryAfterMs = parseRetryAfterMs(response.headers, nowMs) ?? undefined;
  const envelope = extractEnvelopeError(response.body);
  const detail: Record<string, unknown> = {
    http_status: status,
    platform_error_code: envelope?.code ?? null,
    platform_error_message: envelope?.message ?? null,
  };
  const platformRequestId =
    response.body && typeof response.body === 'object'
      ? ((response.body as Record<string, unknown>).request_id ?? null)
      : null;
  if (typeof platformRequestId === 'string') detail.platform_request_id = platformRequestId;

  if (envelope && isRateLimitCode(envelope.code)) {
    return new PddError({
      code: 'rate_limited',
      message: `平台限流：${envelope.message ?? envelope.code ?? 'rate limited'}`,
      errorClass: 'retryable',
      nextAction: 'retry_later',
      status,
      retryAfterMs,
      detail,
    });
  }

  if (status >= 200 && status < 300) {
    if (envelope) {
      return new PddError({
        code: 'platform_reject',
        message: `平台业务拒绝：${envelope.message ?? envelope.code ?? 'unknown'}`,
        errorClass: 'manual',
        nextAction: 'fix_and_resubmit',
        status,
        detail,
      });
    }
    return null;
  }

  if (status === 401 || status === 403) {
    return new PddError({
      code: 'auth_failed',
      message: `平台认证/授权失败（HTTP ${status}）`,
      errorClass: 'manual',
      nextAction: 'contact_admin',
      status,
      detail,
    });
  }

  if (status === 408 || status === 425 || status === 429) {
    return new PddError({
      code: 'rate_limited',
      message: `平台限流或请求超时（HTTP ${status}）`,
      errorClass: 'retryable',
      nextAction: 'retry_later',
      status,
      retryAfterMs,
      detail,
    });
  }

  if (status >= 500 && status <= 599) {
    return new PddError({
      code: 'upstream_5xx',
      message: `平台/网关 5xx（HTTP ${status}）`,
      errorClass: 'retryable',
      nextAction: 'retry_later',
      status,
      retryAfterMs,
      detail,
    });
  }

  if (status >= 400 && status < 500) {
    return new PddError({
      code: 'platform_reject',
      message: `平台拒绝请求（HTTP ${status}）`,
      errorClass: 'manual',
      nextAction: 'fix_and_resubmit',
      status,
      detail,
    });
  }

  return new PddError({
    code: 'unknown',
    message: `未识别的平台响应（HTTP ${status}）`,
    errorClass: 'manual',
    nextAction: 'contact_admin',
    status,
    detail,
  });
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** fetch/网络错误分类；超时与连接类可重试，URL/配置类永久失败。 */
export function classifyTransportError(error: unknown): PddError {
  if (error instanceof PddError) return error;
  const record = error as { name?: string; code?: string; message?: string } | null;
  const name = record?.name ?? '';
  const code = record?.code ?? '';
  const message = record?.message ?? String(error);

  if (name === 'AbortError' || name === 'TimeoutError' || /timeout/i.test(message)) {
    return new PddError({
      code: 'timeout',
      message: `请求超时：${message}`,
      errorClass: 'retryable',
      nextAction: 'retry_later',
      detail: { transport_code: code || name },
      cause: error,
    });
  }
  if (code === 'ERR_INVALID_URL' || code === 'ERR_INVALID_ARG_TYPE') {
    return new PddError({
      code: 'config_error',
      message: `请求配置非法：${message}`,
      errorClass: 'permanent',
      nextAction: 'contact_admin',
      detail: { transport_code: code },
      cause: error,
    });
  }
  if (RETRYABLE_NETWORK_CODES.has(code) || /fetch failed|socket|network/i.test(message)) {
    return new PddError({
      code: 'network_error',
      message: `网络错误：${message}`,
      errorClass: 'retryable',
      nextAction: 'retry_later',
      detail: { transport_code: code || name },
      cause: error,
    });
  }
  return new PddError({
    code: 'unknown',
    message: `未识别的传输错误：${message}`,
    errorClass: 'manual',
    nextAction: 'contact_admin',
    detail: { transport_code: code || name },
    cause: error,
  });
}
