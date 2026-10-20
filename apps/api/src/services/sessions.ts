/**
 * 会话存储（M1）。
 *
 * docs/14 §4.1 的终态是 Redis；M1 先落进程内实现，接口保持不变，
 * 后续把 MemorySessionStore 换成 RedisSessionStore 即可，不动路由与中间件。
 * 约束：sid 为 32 字节随机、不透明；CSRF token 随会话生成（双提交）。
 */
import type { Role } from '@dssaas/core';
import { randomToken } from '../lib/ids.js';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  permissions: string[];
  orgId: number;
}

export interface SessionRecord {
  sid: string;
  user: SessionUser;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  ipHash: string | null;
  uaHash: string | null;
}

export interface SessionStore {
  create(user: SessionUser, meta: { ipHash: string | null; uaHash: string | null }): Promise<SessionRecord>;
  get(sid: string): Promise<SessionRecord | null>;
  delete(sid: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
  clear(): void;
}

interface MemorySessionStoreOptions {
  idleSeconds: number;
  adminIdleSeconds: number;
  absoluteSeconds: number;
  now?: () => number;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly options: MemorySessionStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 60_000);
    this.cleanupTimer.unref();
  }

  async create(
    user: SessionUser,
    meta: { ipHash: string | null; uaHash: string | null },
  ): Promise<SessionRecord> {
    const now = this.now();
    const idleMs = this.idleMsForRole(user.role);
    const record: SessionRecord = {
      sid: randomToken(32),
      user,
      csrfToken: randomToken(32),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: now + idleMs,
      absoluteExpiresAt: now + this.options.absoluteSeconds * 1000,
      ipHash: meta.ipHash,
      uaHash: meta.uaHash,
    };
    this.sessions.set(record.sid, record);
    return record;
  }

  async get(sid: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(sid);
    if (!record) return null;
    const now = this.now();
    if (now >= record.idleExpiresAt || now >= record.absoluteExpiresAt) {
      this.sessions.delete(sid);
      return null;
    }
    record.lastSeenAt = now;
    const idleMs = this.idleMsForRole(record.user.role);
    // 滑动续期：剩余不足 20% 时续期，但不超过绝对上限（docs/14 §4.2）。
    if (record.idleExpiresAt - now < idleMs * 0.2) {
      record.idleExpiresAt = Math.min(now + idleMs, record.absoluteExpiresAt);
    }
    return record;
  }

  async delete(sid: string): Promise<void> {
    this.sessions.delete(sid);
  }

  async deleteAllForUser(userId: string): Promise<void> {
    for (const [sid, record] of this.sessions) {
      if (record.user.id === userId) this.sessions.delete(sid);
    }
  }

  clear(): void {
    this.sessions.clear();
    clearInterval(this.cleanupTimer);
  }

  /** 测试/诊断用：当前会话数。 */
  size(): number {
    return this.sessions.size;
  }

  private idleMsForRole(role: Role): number {
    const seconds =
      role === 'admin' ? this.options.adminIdleSeconds : this.options.idleSeconds;
    return seconds * 1000;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [sid, record] of this.sessions) {
      if (now >= record.idleExpiresAt || now >= record.absoluteExpiresAt) {
        this.sessions.delete(sid);
      }
    }
  }
}
