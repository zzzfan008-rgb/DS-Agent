/**
 * 本地令牌桶限流（每接口一个桶）。
 *
 * 重要边界：平台真实限流（QPS/日上限/超限错误码）在 docs/01 §2 全部为「待填」，
 * 因此这里**不复制任何平台数字**。`qps` 是内部保守节流值（默认 0.5，可由
 * `PDD_INTERNAL_QPS` 调整），只用于避免本系统在未核验前高频打平台。
 *
 * 设计：
 * - 令牌桶 + 预占（允许短暂负余额），并发调用会按队列自然拉开；
 * - 等待超过 `maxQueueWaitMs` 直接抛 `rate_limited`，由上层决定排队或失败；
 * - `clock`/`sleep` 可注入，单测无需真实等待。
 */

import { PddError } from '../errors.js';

export interface RateLimiter {
  /** 获取一个调用许可；返回本次实际等待毫秒数。超时抛 rate_limited。 */
  acquire(key: string, options?: { signal?: AbortSignal }): Promise<number>;
}

export interface TokenBucketLimiterOptions {
  /** 每秒补充令牌数（内部节流值，不是平台事实）。 */
  qps: number;
  /** 桶容量（允许的突发数）。默认 1。 */
  burst?: number;
  /** 单次调用最多排队等待毫秒；超过直接 rate_limited。默认 30000。 */
  maxQueueWaitMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class TokenBucketLimiter implements RateLimiter {
  private readonly qps: number;
  private readonly burst: number;
  private readonly maxQueueWaitMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketLimiterOptions) {
    if (!Number.isFinite(options.qps) || options.qps <= 0) {
      throw new Error(`TokenBucketLimiter.qps 必须为正数，实际 ${options.qps}`);
    }
    this.qps = options.qps;
    this.burst = options.burst ?? 1;
    if (!Number.isInteger(this.burst) || this.burst < 1) {
      throw new Error(`TokenBucketLimiter.burst 必须为 >=1 的整数，实际 ${options.burst}`);
    }
    this.maxQueueWaitMs = options.maxQueueWaitMs ?? 30_000;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async acquire(key: string, options: { signal?: AbortSignal } = {}): Promise<number> {
    const now = this.clock();
    const bucket = this.refill(key, now);
    bucket.tokens -= 1;
    if (bucket.tokens >= 0) return 0;

    const rawWaitMs = Math.ceil((-bucket.tokens / this.qps) * 1000);
    if (rawWaitMs > this.maxQueueWaitMs) {
      bucket.tokens += 1; // 回滚预占
      throw new PddError({
        code: 'rate_limited',
        message: `本地限流队列等待 ${rawWaitMs}ms 超过上限 ${this.maxQueueWaitMs}ms（接口 ${key}）`,
        errorClass: 'retryable',
        nextAction: 'retry_later',
        retryAfterMs: rawWaitMs,
        detail: { interface_key: key, qps: this.qps, wait_ms: rawWaitMs },
      });
    }

    await this.wait(rawWaitMs, options.signal);
    // 真实 sleep 后时钟已推进；注入 fake clock 时测试的 sleep 负责推进。
    this.refill(key, this.clock());
    return rawWaitMs;
  }

  /** 当前桶的可用令牌数（用于诊断/测试）。 */
  snapshot(key: string): { tokens: number; qps: number; burst: number } {
    const bucket = this.refill(key, this.clock());
    return { tokens: bucket.tokens, qps: this.qps, burst: this.burst };
  }

  private refill(key: string, now: number): BucketState {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefillMs: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedMs = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsedMs / 1000) * this.qps);
    bucket.lastRefillMs = now;
    return bucket;
  }

  private async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new PddError({
        code: 'rate_limited',
        message: '等待限流许可时被取消',
        errorClass: 'manual',
        nextAction: 'none',
        detail: { aborted: true },
      });
    }
    await this.sleep(ms);
    if (signal?.aborted) {
      throw new PddError({
        code: 'rate_limited',
        message: '等待限流许可时被取消',
        errorClass: 'manual',
        nextAction: 'none',
        detail: { aborted: true },
      });
    }
  }
}
