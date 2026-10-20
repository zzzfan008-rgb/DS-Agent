/**
 * 登录限流（docs/14 §3.1：单 IP 5 次/分钟）。
 * M1 用进程内滑动窗口；多实例/重启后的严格限流由 Redis 承载（M2+）。
 */
import { ApiError } from '../lib/errors.js';

export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  /** 记一次尝试；超限抛 429 rate_limited。 */
  consume(key: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (existing.length >= this.max) {
      const oldest = existing[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      this.hits.set(key, existing);
      throw new ApiError('rate_limited', `登录尝试过于频繁，请 ${retryAfterSeconds} 秒后重试`, {
        headers: { 'Retry-After': String(retryAfterSeconds) },
        detail: { retry_after_s: retryAfterSeconds },
      });
    }
    existing.push(now);
    this.hits.set(key, existing);
    if (this.hits.size > 10_000) this.purge(cutoff);
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private purge(cutoff: number): void {
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((timestamp) => timestamp > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
