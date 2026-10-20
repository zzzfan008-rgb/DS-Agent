/**
 * 重试与退避 —— 与 docs/11 §…「禁止重试清单」、docs/15 FI-01 对齐。
 *
 * 三条硬规则：
 * 1. **B/C 级与不可逆写不得盲目重试**：没有幂等键时，重试可能造成重复写
 *    （写入门要求幂等键 = hash(platform + action + payload)，见 docs/00 §9.2）。
 *    因此 `policyForOperation()` 会直接把 `maxAttempts` 压到 1；
 * 2. 平台明确拒绝（4xx 业务错误）不可重试；`PLATFORM_REJECT` 一律不重试；
 * 3. 429 必须尊重 `Retry-After`，且上限 30 分钟（docs/11 §…「429 超过 Retry-After 上限」）。
 *
 * 平台是否提供 `Retry-After`、错误码如何分类均未核验（`TODO-1688-004`），
 * 所以这里只做**通用**处理，具体错误码映射等契约回填后补。
 */

import { AdapterError } from '../errors.js';
import type { Clock, RandomSource } from './types.js';
import { systemClock, systemRandom } from './types.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 抖动比例（0–1）：避免多实例同步重试。 */
  jitterRatio: number;
  /** 是否在响应头带 `Retry-After` 时以其为准。 */
  respectRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitterRatio: 0.2,
  respectRetryAfter: true,
};

/** `Retry-After` 的硬上限（docs/11：超过 30 分钟不再自动重试）。 */
export const MAX_RETRY_AFTER_MS = 30 * 60 * 1000;

export interface RetryContext {
  riskLevel: 'A' | 'B' | 'C' | null;
  irreversible: boolean;
  idempotencyKey: string | null | undefined;
}

/**
 * 按操作级别裁剪重试策略：
 * - 只读/A 级：用基础策略；
 * - B/C 级或不可逆：**仅当**有幂等键才允许重试，否则只发一次。
 */
export function policyForOperation(base: RetryPolicy, context: RetryContext): RetryPolicy {
  const risky = context.irreversible || context.riskLevel === 'B' || context.riskLevel === 'C';
  if (!risky) return base;
  if (context.idempotencyKey) return base;
  return { ...base, maxAttempts: 1 };
}

/** 指数退避 + 抖动；`attempt` 从 1 开始。 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: RandomSource = systemRandom): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * (random.next() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** 解析 `Retry-After`（秒数或 HTTP 日期），返回毫秒；无法解析返回 null。 */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  if (delta <= 0) return 0;
  return delta <= MAX_RETRY_AFTER_MS ? delta : null;
}

export interface RetryDeps {
  clock: Clock;
  random: RandomSource;
  /** 每次失败后的回调（可用于留档/指标）；`operation` 是调用方传入的操作 id。 */
  onRetry?: (info: { operation: string; attempt: number; delayMs: number; error: unknown }) => void;
}

export interface RetryOutcome<T> {
  result: T;
  attempts: number;
  delaysMs: number[];
}

/**
 * 执行一次可重试调用。只有 `AdapterError.retryable === true` 才会重试，
 * 其它异常（含契约未核验、平台拒绝）立即上抛。
 */
export async function executeWithRetry<T>(
  operation: string,
  call: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  deps: RetryDeps = { clock: systemClock, random: systemRandom },
): Promise<RetryOutcome<T>> {
  const delaysMs: number[] = [];
  let attempt = 1;

  for (;;) {
    try {
      const result = await call(attempt);
      return { result, attempts: attempt, delaysMs };
    } catch (error) {
      const retryable = error instanceof AdapterError && error.retryable;
      if (!retryable || attempt >= policy.maxAttempts) throw error;

      const retryAfterMs =
        policy.respectRetryAfter && error instanceof AdapterError && typeof error.details.retryAfterMs === 'number'
          ? error.details.retryAfterMs
          : null;
      const delayMs = retryAfterMs ?? backoffDelay(attempt, policy, deps.random);
      delaysMs.push(delayMs);
      deps.onRetry?.({ operation, attempt, delayMs, error });
      await deps.clock.sleep(delayMs);
      attempt += 1;
    }
  }
}
