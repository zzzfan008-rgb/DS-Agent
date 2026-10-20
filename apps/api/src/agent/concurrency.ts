/**
 * Agent 并发闸门（docs/17 §4.2、§4.3；docs/21 §12 裁决）。
 *
 * 判定顺序固定：单用户 → 单会话 → 全局并发 → 排队。
 *  - 单用户第 3 个（含排队）→ 409 `concurrency_user_limit`；
 *  - 单会话第 2 个 → 409 `concurrency_session_limit`；
 *  - 全局满但队列未满 → 202 + queue_position（**不是** 409）；
 *  - 队列满 → 429 `queue_full`（带 Retry-After）。
 *
 * 进程内实现（M1）：接口保持纯函数式，后续换 Redis/DB 时替换实现即可。
 */

export interface GateOptions {
  maxConcurrency: number;
  queueLimit: number;
  maxPerUser: number;
  maxPerSession: number;
}

export interface GateTicket {
  runId: string;
  userId: string;
  sessionKey: string;
  enqueuedAt: number;
}

export type Admission =
  | { kind: 'started' }
  | { kind: 'queued'; position: number }
  | {
      kind: 'rejected';
      reason: 'user_busy' | 'session_busy' | 'queue_full';
      retryAfterSeconds: number;
      user_in_flight: number;
      queue_depth: number;
    };

export class AgentConcurrencyGate {
  private readonly active = new Map<string, GateTicket>();
  private readonly queue: GateTicket[] = [];

  constructor(
    private readonly options: GateOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  admit(input: { runId: string; userId: string; sessionKey: string }): Admission {
    const userInFlight = this.userInFlight(input.userId);
    if (userInFlight >= this.options.maxPerUser) {
      return {
        kind: 'rejected',
        reason: 'user_busy',
        retryAfterSeconds: 5,
        user_in_flight: userInFlight,
        queue_depth: this.queue.length,
      };
    }
    if (this.sessionInFlight(input.sessionKey) >= this.options.maxPerSession) {
      return {
        kind: 'rejected',
        reason: 'session_busy',
        retryAfterSeconds: 5,
        user_in_flight: userInFlight,
        queue_depth: this.queue.length,
      };
    }
    if (this.active.size < this.options.maxConcurrency) {
      this.active.set(input.runId, {
        runId: input.runId,
        userId: input.userId,
        sessionKey: input.sessionKey,
        enqueuedAt: this.now(),
      });
      return { kind: 'started' };
    }
    if (this.queue.length >= this.options.queueLimit) {
      return {
        kind: 'rejected',
        reason: 'queue_full',
        retryAfterSeconds: 5,
        user_in_flight: userInFlight,
        queue_depth: this.queue.length,
      };
    }
    this.queue.push({
      runId: input.runId,
      userId: input.userId,
      sessionKey: input.sessionKey,
      enqueuedAt: this.now(),
    });
    return { kind: 'queued', position: this.queue.length };
  }

  /** 释放运行槽位（幂等；只删 active）。 */
  release(runId: string): void {
    this.active.delete(runId);
  }

  /** 从队列移除（取消/排队超时）；返回被移除的票。 */
  removeQueued(runId: string): GateTicket | null {
    const index = this.queue.findIndex((ticket) => ticket.runId === runId);
    if (index < 0) return null;
    return this.queue.splice(index, 1)[0] ?? null;
  }

  /**
   * 取下一个可运行的排队项并按 FIFO 标记 active；无可运行项返回 null。
   * 跳过会让单用户/单会话超限的项（保持队列顺序，不丢票）。
   */
  dequeue(): GateTicket | null {
    for (let index = 0; index < this.queue.length; index += 1) {
      const ticket = this.queue[index]!;
      if (this.userActive(ticket.userId) >= this.options.maxPerUser) continue;
      if (this.sessionActive(ticket.sessionKey) >= this.options.maxPerSession) continue;
      this.queue.splice(index, 1);
      this.active.set(ticket.runId, ticket);
      return ticket;
    }
    return null;
  }

  /** 全局在跑数。 */
  activeCount(): number {
    return this.active.size;
  }

  queueDepth(): number {
    return this.queue.length;
  }

  /** 用户占用 = 在跑 + 排队（docs/17 §4.3「同一用户连续排队不超过 2 个」）。 */
  userInFlight(userId: string): number {
    let count = this.userActive(userId);
    for (const ticket of this.queue) if (ticket.userId === userId) count += 1;
    return count;
  }

  userActive(userId: string): number {
    let count = 0;
    for (const ticket of this.active.values()) if (ticket.userId === userId) count += 1;
    return count;
  }

  sessionInFlight(sessionKey: string): number {
    let count = this.sessionActive(sessionKey);
    for (const ticket of this.queue) if (ticket.sessionKey === sessionKey) count += 1;
    return count;
  }

  sessionActive(sessionKey: string): number {
    let count = 0;
    for (const ticket of this.active.values()) if (ticket.sessionKey === sessionKey) count += 1;
    return count;
  }

  /** 供指标/测试使用。 */
  snapshot(): { active: number; queued: number; active_by_user: Record<string, number> } {
    const activeByUser: Record<string, number> = {};
    for (const ticket of this.active.values()) {
      activeByUser[ticket.userId] = (activeByUser[ticket.userId] ?? 0) + 1;
    }
    return { active: this.active.size, queued: this.queue.length, active_by_user: activeByUser };
  }

  clear(): void {
    this.active.clear();
    this.queue.length = 0;
  }
}
