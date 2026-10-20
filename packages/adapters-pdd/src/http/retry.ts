/**
 * 退避计算（纯函数，便于单测）。
 *
 * 采用指数退避 + 全抖动（full jitter）：
 *   base = min(maxDelayMs, baseDelayMs * 2^(attempt-1))
 *   delay = base * (1 - jitterRatio + random() * jitterRatio)
 * 平台给出 Retry-After 时取两者较大值（平台指示优先）。
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** 0..1；0 表示不抖动。默认 0.25。 */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
};

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 10) {
    throw new Error(`RetryPolicy.maxAttempts 必须是 1..10 的整数，实际 ${policy.maxAttempts}`);
  }
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new Error(`RetryPolicy.baseDelayMs 必须 >=0，实际 ${policy.baseDelayMs}`);
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error(`RetryPolicy.maxDelayMs 必须 >= baseDelayMs，实际 ${policy.maxDelayMs}`);
  }
  if (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error(`RetryPolicy.jitterRatio 必须是 0..1，实际 ${policy.jitterRatio}`);
  }
}

/**
 * @param attempt 第几次尝试（1 开始）
 * @param retryAfterMs 平台建议等待（可选）
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  validateRetryPolicy(policy);
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const jitter = 1 - policy.jitterRatio + random() * policy.jitterRatio;
  const jittered = Math.min(policy.maxDelayMs, Math.round(base * jitter));
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > jittered) {
    return Math.round(retryAfterMs);
  }
  return jittered;
}

/** 是否还能再试。 */
export function hasAttemptsLeft(attempt: number, policy: RetryPolicy): boolean {
  return attempt < policy.maxAttempts;
}
