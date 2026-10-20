/**
 * 熔断器（docs/07 §6.3）。
 * 键 = `${modelId}:${model.version}`：配置版本变化后旧熔断不粘新配置。
 * M1 进程内实现；多实例场景的 Redis 版本在后续里程碑替换（接口不变）。
 */
export interface BreakerOptions {
  windowMs?: number;
  minSamples?: number;
  failureRate?: number;
  consecutiveTimeouts?: number;
  openMs?: number;
  maxOpenMs?: number;
}

interface BreakerState {
  failures: number[];
  samples: number;
  timeouts: number;
  openUntil: number;
  openMs: number;
}

export class CircuitBreaker {
  private readonly states = new Map<string, BreakerState>();
  private readonly windowMs: number;
  private readonly minSamples: number;
  private readonly failureRate: number;
  private readonly consecutiveTimeouts: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;

  constructor(
    options: BreakerOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.windowMs = options.windowMs ?? 60_000;
    this.minSamples = options.minSamples ?? 10;
    this.failureRate = options.failureRate ?? 0.5;
    this.consecutiveTimeouts = options.consecutiveTimeouts ?? 5;
    this.baseOpenMs = options.openMs ?? 60_000;
    this.maxOpenMs = options.maxOpenMs ?? 600_000;
  }

  isOpen(key: string): boolean {
    const state = this.states.get(key);
    if (!state) return false;
    if (state.openUntil > this.now()) return true;
    // 半开：保留 state 让 1 个探针通过；探针结果决定闭合/重开。
    return false;
  }

  recordSuccess(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    state.failures = [];
    state.samples = 0;
    state.timeouts = 0;
    state.openUntil = 0;
    state.openMs = this.baseOpenMs;
  }

  recordFailure(key: string, kind: 'error' | 'timeout' = 'error'): void {
    const now = this.now();
    const state = this.states.get(key) ?? {
      failures: [],
      samples: 0,
      timeouts: 0,
      openUntil: 0,
      openMs: this.baseOpenMs,
    };
    state.failures = state.failures.filter((timestamp) => now - timestamp <= this.windowMs);
    state.failures.push(now);
    state.samples += 1;
    state.timeouts = kind === 'timeout' ? state.timeouts + 1 : 0;

    const failuresInWindow = state.failures.length;
    const openedByRate =
      state.samples >= this.minSamples && failuresInWindow / state.samples >= this.failureRate;
    const openedByTimeouts = state.timeouts >= this.consecutiveTimeouts;
    if (openedByRate || openedByTimeouts) {
      state.openUntil = now + state.openMs;
      state.openMs = Math.min(state.openMs * 2, this.maxOpenMs);
      state.samples = 0;
      state.timeouts = 0;
    }
    this.states.set(key, state);
  }

  reset(key?: string): void {
    if (key === undefined) this.states.clear();
    else this.states.delete(key);
  }
}
