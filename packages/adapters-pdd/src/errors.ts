/**
 * 拼多多适配层的错误模型。
 *
 * 设计约束（docs/12 §4、docs/15 §6）：
 * - 错误必须可分类：retryable（可退避重试）/ manual（需人工处理）/ permanent（永久失败）；
 * - 每个错误带 `next_action`，调用方不得凭 code 猜下一步；
 * - 不把平台原始报文直接抛给上层：原始报文进留档（redacted），上层只拿 code/detail。
 */

/** 与 docs/12 §4 的 next_action 词表保持一致。 */
export type PddNextAction =
  | 'retry_later'
  | 'reopen_approval'
  | 'fix_and_resubmit'
  | 'create_compensation'
  | 'contact_admin'
  | 'login'
  | 'none';

export type PddErrorClass = 'retryable' | 'manual' | 'permanent';

export type PddErrorCode =
  | 'config_error'
  | 'interface_not_registered'
  | 'unverified_interface'
  | 'dry_run_blocked'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'timeout'
  | 'network_error'
  | 'auth_failed'
  | 'signature_invalid'
  | 'platform_reject'
  | 'replay_mismatch'
  | 'unknown';

export interface PddErrorInit {
  code: PddErrorCode;
  message: string;
  errorClass: PddErrorClass;
  nextAction?: PddNextAction;
  status?: number;
  detail?: Record<string, unknown>;
  requestId?: string;
  attempts?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class PddError extends Error {
  readonly code: PddErrorCode;
  readonly errorClass: PddErrorClass;
  readonly nextAction: PddNextAction;
  readonly status: number | undefined;
  readonly detail: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;
  readonly attempts: number | undefined;
  /** 平台/网关切流的建议等待时间（来自 Retry-After 或退避计算）。 */
  readonly retryAfterMs: number | undefined;

  constructor(init: PddErrorInit) {
    super(init.message, { cause: init.cause });
    this.name = 'PddError';
    this.code = init.code;
    this.errorClass = init.errorClass;
    this.nextAction = init.nextAction ?? defaultNextAction(init.errorClass);
    this.status = init.status;
    this.detail = init.detail;
    this.requestId = init.requestId;
    this.attempts = init.attempts;
    this.retryAfterMs = init.retryAfterMs;
  }

  get retryable(): boolean {
    return this.errorClass === 'retryable';
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      error_class: this.errorClass,
      retryable: this.retryable,
      next_action: this.nextAction,
      status: this.status,
      message: this.message,
      detail: this.detail,
      request_id: this.requestId,
      attempts: this.attempts,
      retry_after_ms: this.retryAfterMs,
    };
  }
}

export function isPddError(error: unknown): error is PddError {
  return error instanceof PddError;
}

export function defaultNextAction(errorClass: PddErrorClass): PddNextAction {
  if (errorClass === 'retryable') return 'retry_later';
  if (errorClass === 'manual') return 'contact_admin';
  return 'fix_and_resubmit';
}

/** 未配置/半配置也必须是显式错误，而不是静默降级。 */
export function configError(message: string, detail?: Record<string, unknown>): PddError {
  return new PddError({ code: 'config_error', message, errorClass: 'permanent', nextAction: 'contact_admin', detail });
}
