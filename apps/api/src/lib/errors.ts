/**
 * 统一错误码与 HTTP 映射（docs/12 §4）。
 *
 * 所有业务错误都抛 ApiError，由 app 的 errorHandler 转成统一信封：
 * { request_id, error: { code, message, retryable, next_action, detail? } }
 */
import { ZodError } from 'zod';

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'invalid_fact'
  | 'approval_required'
  | 'approval_stale'
  | 'irreversible'
  | 'conflict'
  | 'idempotency_conflict'
  | 'rate_limited'
  | 'quota'
  | 'concurrency_user_limit'
  | 'concurrency_session_limit'
  | 'queue_full'
  | 'locked'
  | 'platform_reject'
  | 'upstream_5xx'
  | 'dsh_unavailable'
  | 'kill_switch_on'
  | 'audit_failed'
  | 'timeout'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error';

export type NextAction =
  | 'retry_later'
  | 'reopen_approval'
  | 'fix_and_resubmit'
  | 'create_compensation'
  | 'contact_admin'
  | 'login'
  | 'none';

export interface ErrorDefinition {
  http: number;
  retryable: boolean;
  nextAction: NextAction;
  message: string;
}

export const ERROR_DEFS: Record<ErrorCode, ErrorDefinition> = {
  unauthorized: { http: 401, retryable: false, nextAction: 'login', message: '未登录或会话已过期' },
  forbidden: { http: 403, retryable: false, nextAction: 'contact_admin', message: '权限不足' },
  not_found: { http: 404, retryable: false, nextAction: 'none', message: '资源不存在或已归档' },
  validation_failed: { http: 422, retryable: false, nextAction: 'fix_and_resubmit', message: '请求参数校验失败' },
  invalid_fact: { http: 422, retryable: false, nextAction: 'fix_and_resubmit', message: '与主数据不一致的事实错误' },
  approval_required: { http: 428, retryable: false, nextAction: 'reopen_approval', message: '缺少有效审批' },
  approval_stale: { http: 409, retryable: false, nextAction: 'reopen_approval', message: '审批对象已变更，审批失效' },
  irreversible: { http: 409, retryable: false, nextAction: 'create_compensation', message: '不可逆动作被拒绝' },
  conflict: { http: 409, retryable: false, nextAction: 'retry_later', message: '状态冲突，请刷新后重试' },
  idempotency_conflict: { http: 409, retryable: false, nextAction: 'fix_and_resubmit', message: '同一幂等键对应了不同请求内容' },
  rate_limited: { http: 429, retryable: true, nextAction: 'retry_later', message: '请求过于频繁，请稍后重试' },
  quota: { http: 429, retryable: false, nextAction: 'contact_admin', message: '配额已耗尽' },
  concurrency_user_limit: { http: 409, retryable: false, nextAction: 'retry_later', message: '用户并发数已达上限' },
  concurrency_session_limit: { http: 409, retryable: false, nextAction: 'retry_later', message: '会话并发数已达上限' },
  queue_full: { http: 429, retryable: true, nextAction: 'retry_later', message: '队列已满' },
  locked: { http: 423, retryable: false, nextAction: 'contact_admin', message: '账号已锁定' },
  platform_reject: { http: 422, retryable: false, nextAction: 'fix_and_resubmit', message: '平台驳回' },
  upstream_5xx: { http: 502, retryable: true, nextAction: 'retry_later', message: '上游服务异常' },
  dsh_unavailable: { http: 503, retryable: true, nextAction: 'retry_later', message: 'DSH Host 不可达' },
  kill_switch_on: { http: 503, retryable: false, nextAction: 'contact_admin', message: 'kill switch 已启用，写操作被阻断' },
  audit_failed: { http: 503, retryable: true, nextAction: 'retry_later', message: '审计写入失败，操作未确认' },
  timeout: { http: 504, retryable: true, nextAction: 'retry_later', message: '请求超时' },
  method_not_allowed: { http: 405, retryable: false, nextAction: 'none', message: 'HTTP 方法不允许' },
  payload_too_large: { http: 413, retryable: false, nextAction: 'fix_and_resubmit', message: '请求体过大' },
  unsupported_media_type: { http: 415, retryable: false, nextAction: 'fix_and_resubmit', message: '不支持的媒体类型' },
  internal_error: { http: 500, retryable: false, nextAction: 'contact_admin', message: '服务内部错误' },
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly nextAction: NextAction;
  readonly detail?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message?: string,
    options: { detail?: unknown; headers?: Record<string, string>; cause?: unknown } = {},
  ) {
    const def = ERROR_DEFS[code];
    super(message ?? def.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = def.http;
    this.retryable = def.retryable;
    this.nextAction = def.nextAction;
    this.detail = options.detail;
    this.headers = options.headers;
  }
}

export interface ErrorEnvelope {
  request_id: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    next_action: NextAction;
    detail?: unknown;
  };
}

export function errorEnvelope(requestId: string, error: ApiError): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    request_id: requestId,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      next_action: error.nextAction,
    },
  };
  if (error.detail !== undefined) envelope.error.detail = error.detail;
  return envelope;
}

/** 把任意异常统一成 ApiError（Fastify/Ajv/Zod 都覆盖）。 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError('validation_failed', '请求参数校验失败', {
      detail: {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
    });
  }
  const candidate = error as {
    code?: string;
    statusCode?: number;
    message?: string;
    validation?: unknown;
  };
  switch (candidate?.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new ApiError('payload_too_large');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new ApiError('unsupported_media_type');
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
      return new ApiError('validation_failed', '请求体不是合法 JSON');
    case 'FST_ERR_VALIDATION':
      return new ApiError('validation_failed', '请求参数校验失败', { detail: candidate.validation });
    default:
      break;
  }
  if (candidate?.statusCode === 404) return new ApiError('not_found');
  if (candidate?.statusCode === 405) return new ApiError('method_not_allowed');
  return new ApiError('internal_error', undefined, { cause: error });
}
