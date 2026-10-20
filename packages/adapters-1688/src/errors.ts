/**
 * 适配层错误 —— 与 docs/12 §4 的错误码对齐，但**不依赖** apps/api 的类型。
 *
 * 说明：
 * - `CONTRACT_NOT_VERIFIED` 是本包独有的错误：1688 接口契约未核实时，任何真实调用
 *   都必须以它失败，而不是「猜一个 method 试一下」（docs/02 §0）；
 * - `retryable` 只表达「网络/限流/5xx 类可重试」，业务拒绝（`PLATFORM_REJECT`）与契约
 *   未核验一律不可重试；
 * - `todoIds` 让调用方把「缺什么」直接透出到工作台与验收记录，而不是一句「暂不支持」。
 */

import type { ValidationIssue } from './validation.js';
import type { TodoId } from './todo.js';

export type AdapterErrorCode =
  | 'CONTRACT_NOT_VERIFIED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UPSTREAM_5XX'
  | 'PLATFORM_REJECT'
  | 'RETRY_EXHAUSTED'
  | 'NO_FIXTURE'
  | 'FIXTURE_MISMATCH'
  | 'PARSE_ERROR'
  | 'ARCHIVE_FAILED';

export interface AdapterErrorInit {
  code: AdapterErrorCode;
  message: string;
  retryable?: boolean;
  todoIds?: TodoId[];
  /** 不写入日志原文的附加信息（错误码、HTTP 状态等）。 */
  details?: Record<string, string | number | boolean | null>;
  cause?: unknown;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly todoIds: TodoId[];
  readonly details: Record<string, string | number | boolean | null>;

  constructor(init: AdapterErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'AdapterError';
    this.code = init.code;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[init.code];
    this.todoIds = init.todoIds ?? [];
    this.details = init.details ?? {};
  }

  /** 契约未核验：默认不可重试，且必须带 TODO 列表。 */
  static contractNotVerified(message: string, todoIds: TodoId[], details: AdapterErrorInit['details'] = {}): AdapterError {
    return new AdapterError({ code: 'CONTRACT_NOT_VERIFIED', message, todoIds, details, retryable: false });
  }
}

const DEFAULT_RETRYABLE: Record<AdapterErrorCode, boolean> = {
  CONTRACT_NOT_VERIFIED: false,
  INVALID_REQUEST: false,
  RATE_LIMITED: true,
  TIMEOUT: true,
  NETWORK: true,
  UPSTREAM_5XX: true,
  PLATFORM_REJECT: false,
  RETRY_EXHAUSTED: false,
  NO_FIXTURE: false,
  FIXTURE_MISMATCH: false,
  PARSE_ERROR: false,
  ARCHIVE_FAILED: false,
};

/**
 * 领域校验失败（价格档位 / 起批量 / 代发 / 尺码表等）。
 * 携带 docs/19 §10 结构的问题列表，供写入门直接回 `422 invalid_fact`。
 */
export class DomainValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(subject: string, issues: ValidationIssue[]) {
    const first = issues[0];
    super(`${subject} 校验失败：${first ? `${first.code} @${first.field}` : '未知原因'}（共 ${issues.length} 项）`);
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}
