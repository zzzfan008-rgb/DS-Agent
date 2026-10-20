/**
 * 令牌桶限流 —— 与平台配额的**唯一**关系是：平台配额未知。
 *
 * `TODO-1688-004`：1688 各接口的 QPS / 日上限 / 超限错误码 / 改价冷静期均未核验
 * （docs/02 §二 各表「限流」列全为待填）。因此：
 * - 本模块只实现**客户端保护性限流**（挡住我们自己把平台打过载、也挡住重试风暴）；
 * - `ASSUMED_CLIENT_RATE_LIMIT` 是保守假设，带 `source='unverified-assumed'`，
 *   回填文档后必须替换，且不得把它写进对运营的承诺（如"每秒最多 N 次"）；
 * - 平台返回 429 时以 `Retry-After` 为准，见 `retry.ts`。
 */

import { AdapterError } from '../errors.js';
import type { Clock } from './types.js';
import { systemClock } from './types.js';

export interface RateLimitConfig {
  /** 桶容量（允许的突发量）。 */
  capacity: number;
  /** 每秒补充的令牌数（≈ 持续 QPS）。 */
  refillPerSecond: number;
  /** 配置来源：`verified` 来自平台文档；`unverified-assumed` 是我方保守假设。 */
  source: 'verified' | 'unverified-assumed';
  /** 人工可读说明（含 TODO id）。 */
  note: string;
  /** 单次 acquire 最长等待；超出直接 429，交上层退避/排队。 */
  maxWaitMs?: number;
}

/**
 * 本地保护性限流（非平台配额）：
 * 1 个令牌容量 + 0.2/s 补充 ≈ 每 5 秒 1 次调用；只在未核验期使用。
 */
export const ASSUMED_CLIENT_RATE_LIMIT: RateLimitConfig = {
  capacity: 1,
  refillPerSecond: 0.2,
  source: 'unverified-assumed',
  note: 'TODO-1688-004：平台配额未核验，本值仅为客户端保护性上限，不代表平台真实限流',
  maxWaitMs: 60_000,
};

export interface RateLimiter {
  /** 取得一个令牌；返回实际等待时长（毫秒）。超限抛 `RATE_LIMITED`。 */
  acquire(scope: string): Promise<{ waitedMs: number }>;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

/** 按 scope（通常是 operation id）隔离的令牌桶。 */
export class TokenBucketRateLimiter implements RateLimiter {
  readonly config: RateLimitConfig;
  private readonly clock: Clock;
  private readonly buckets = new Map<string, BucketState>();

  constructor(config: RateLimitConfig = ASSUMED_CLIENT_RATE_LIMIT, clock: Clock = systemClock) {
    if (config.capacity < 1) throw new TypeError('capacity 必须 ≥ 1');
    if (config.refillPerSecond <= 0) throw new TypeError('refillPerSecond 必须 > 0');
    this.config = config;
    this.clock = clock;
  }

  async acquire(scope: string): Promise<{ waitedMs: number }> {
    const maxWaitMs = this.config.maxWaitMs ?? 60_000;
    let waitedMs = 0;

    for (;;) {
      const now = this.clock.now();
      const bucket = this.buckets.get(scope) ?? { tokens: this.config.capacity, updatedAt: now };
      const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
      const tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSeconds * this.config.refillPerSecond);

      if (tokens >= 1) {
        this.buckets.set(scope, { tokens: tokens - 1, updatedAt: now });
        return { waitedMs };
      }

      // 记住当前（已补充的）令牌数，再等；下一轮从等待结束时刻继续补充。
      this.buckets.set(scope, { tokens, updatedAt: now });
      const waitMs = Math.max(1, Math.ceil(((1 - tokens) / this.config.refillPerSecond) * 1000));
      if (waitedMs + waitMs > maxWaitMs) {
        throw new AdapterError({
          code: 'RATE_LIMITED',
          message: `本地限流：${scope} 在 ${maxWaitMs}ms 内无法取得令牌，请稍后重试`,
          retryable: true,
          details: { scope, waitedMs, maxWaitMs, source: this.config.source },
        });
      }
      await this.clock.sleep(waitMs);
      waitedMs += waitMs;
    }
  }
}
