/**
 * C 级二次确认凭证（docs/11 §11.2 #11）：绑定 target_hash + user_id + 5 分钟 TTL，一次性。
 *
 * M4 用进程内实现；接口保持窄（issue/consume），多实例替换 Redis 即可，不影响写入门时序。
 */
import { randomBytes } from 'node:crypto';
import { ApiError } from '../lib/errors.js';

export interface ConfirmTokenRecord {
  token: string;
  approvalId: string;
  userId: string;
  action: string;
  targetHash: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface ConfirmTokenStore {
  issue(input: {
    approvalId: string;
    userId: string;
    action: string;
    targetHash: string;
    ttlMs?: number;
  }): ConfirmTokenRecord;
  consume(input: {
    token: string;
    approvalId: string;
    userId: string;
    action: string;
    targetHash: string;
  }): ConfirmTokenRecord;
  get(token: string): ConfirmTokenRecord | null;
  cleanup(now?: Date): void;
}

export class InMemoryConfirmTokenStore implements ConfirmTokenStore {
  private readonly tokens = new Map<string, ConfirmTokenRecord>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  issue(input: {
    approvalId: string;
    userId: string;
    action: string;
    targetHash: string;
    ttlMs?: number;
  }): ConfirmTokenRecord {
    const now = this.clock();
    const token = `ct_${randomBytes(24).toString('base64url')}`;
    const record: ConfirmTokenRecord = {
      token,
      approvalId: input.approvalId,
      userId: input.userId,
      action: input.action,
      targetHash: input.targetHash,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 5 * 60 * 1000)),
      usedAt: null,
    };
    this.tokens.set(token, record);
    return record;
  }

  consume(input: {
    token: string;
    approvalId: string;
    userId: string;
    action: string;
    targetHash: string;
  }): ConfirmTokenRecord {
    const record = this.tokens.get(input.token);
    if (!record) throw new ApiError('irreversible', 'C 级二次确认凭证不存在', { detail: { reason: 'confirm_token_missing' } });
    if (record.usedAt) {
      throw new ApiError('irreversible', 'C 级二次确认凭证已被使用（一次性）', {
        detail: { reason: 'confirm_token_used' },
      });
    }
    if (record.expiresAt.getTime() <= this.clock().getTime()) {
      throw new ApiError('irreversible', 'C 级二次确认凭证已过期', { detail: { reason: 'confirm_token_expired' } });
    }
    if (
      record.approvalId !== input.approvalId ||
      record.userId !== input.userId ||
      record.action !== input.action ||
      record.targetHash !== input.targetHash
    ) {
      throw new ApiError('irreversible', 'C 级二次确认凭证与审批/执行人/内容不匹配', {
        detail: { reason: 'confirm_token_mismatch' },
      });
    }
    record.usedAt = this.clock();
    return record;
  }

  get(token: string): ConfirmTokenRecord | null {
    return this.tokens.get(token) ?? null;
  }

  cleanup(now: Date = this.clock()): void {
    for (const [token, record] of this.tokens) {
      if (record.expiresAt.getTime() <= now.getTime() || record.usedAt) this.tokens.delete(token);
    }
  }
}
