/**
 * 配额（docs/07 §7.2；docs/21 §8）。
 *
 * M1 实现：
 * - rpm/tpm/concurrency 用进程内滑动窗口与信号量；
 * - daily_calls / daily_cost_cents / monthly_cost_cents 用 `model_call_log` 聚合（DB 真源）；
 * - 生效值 = min(route, model, provider)，缺键不限制；
 * - 只统计未超配额的真实调用（quota_rejected 不计入日调用）。
 *
 * Redis 版本（多实例、带 TTL 的 q:{org}:... 键）在后续里程碑替换本类，接口不变。
 */
import type { QuotaLimits } from './types.js';

export interface QuotaUsageRepo {
  countCallsSince(routeId: string, since: Date): Promise<number>;
  sumCostSince(routeId: string, since: Date): Promise<number>;
}

export interface QuotaReservation {
  ok: true;
  release(): void;
}

export interface QuotaRejection {
  ok: false;
  reason: 'rpm' | 'tpm' | 'concurrency' | 'daily_calls' | 'daily_cost' | 'monthly_cost';
  retryAfterSeconds: number;
}

export interface QuotaReserveInput {
  routeId: string;
  limits: QuotaLimits;
  tokensEstimated: number;
  costEstimatedCents: number;
  now?: Date;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function utcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

interface WindowEvent {
  at: number;
  amount: number;
}

export class QuotaService {
  private readonly rpmEvents = new Map<string, number[]>();
  private readonly tpmEvents = new Map<string, WindowEvent[]>();
  private readonly active = new Map<string, number>();

  constructor(
    private readonly repo: QuotaUsageRepo,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async reserve(input: QuotaReserveInput): Promise<QuotaReservation | QuotaRejection> {
    const nowMs = this.now();
    const now = input.now ?? new Date(nowMs);
    const key = input.routeId;
    const limits = input.limits;

    // rpm：60s 滑动窗口
    if (limits.rpm !== undefined) {
      const events = (this.rpmEvents.get(key) ?? []).filter((at) => nowMs - at < 60_000);
      if (events.length >= limits.rpm) {
        const oldest = events[0] ?? nowMs;
        this.rpmEvents.set(key, events);
        return {
          ok: false,
          reason: 'rpm',
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - nowMs) / 1000)),
        };
      }
      events.push(nowMs);
      this.rpmEvents.set(key, events);
    }

    // tpm：60s 滑动窗口（按 token 估算）
    if (limits.tpm !== undefined) {
      const events = (this.tpmEvents.get(key) ?? []).filter((event) => nowMs - event.at < 60_000);
      const used = events.reduce((sum, event) => sum + event.amount, 0);
      if (used + input.tokensEstimated > limits.tpm) {
        this.tpmEvents.set(key, events);
        return { ok: false, reason: 'tpm', retryAfterSeconds: 60 };
      }
      events.push({ at: nowMs, amount: input.tokensEstimated });
      this.tpmEvents.set(key, events);
    }

    // concurrency：信号量
    if (limits.concurrency !== undefined) {
      const active = this.active.get(key) ?? 0;
      if (active >= limits.concurrency) {
        return { ok: false, reason: 'concurrency', retryAfterSeconds: 2 };
      }
      this.active.set(key, active + 1);
    }

    try {
      // daily_calls
      if (limits.dailyCalls !== undefined) {
        const count = await this.repo.countCallsSince(key, utcDayStart(now));
        if (count >= limits.dailyCalls) {
          this.releaseConcurrency(key, limits);
          return { ok: false, reason: 'daily_calls', retryAfterSeconds: 60 };
        }
      }

      // daily_cost_cents
      if (limits.dailyCostCents !== undefined) {
        const spent = await this.repo.sumCostSince(key, utcDayStart(now));
        if (spent + input.costEstimatedCents > limits.dailyCostCents) {
          this.releaseConcurrency(key, limits);
          return { ok: false, reason: 'daily_cost', retryAfterSeconds: 60 };
        }
      }

      // monthly_cost_cents
      if (limits.monthlyCostCents !== undefined) {
        const spent = await this.repo.sumCostSince(key, utcMonthStart(now));
        if (spent + input.costEstimatedCents > limits.monthlyCostCents) {
          this.releaseConcurrency(key, limits);
          return { ok: false, reason: 'monthly_cost', retryAfterSeconds: 60 };
        }
      }
    } catch (error) {
      this.releaseConcurrency(key, limits);
      throw error;
    }

    return { ok: true, release: () => this.releaseConcurrency(key, limits) };
  }

  reset(): void {
    this.rpmEvents.clear();
    this.tpmEvents.clear();
    this.active.clear();
  }

  private releaseConcurrency(key: string, limits: QuotaLimits): void {
    if (limits.concurrency === undefined) return;
    const active = this.active.get(key) ?? 0;
    if (active > 0) this.active.set(key, active - 1);
  }
}
