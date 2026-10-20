/**
 * `sync_cursor` 存取 —— Postgres（真实）与 Memory（单测）。
 *
 * 关键语义：
 * - 唯一键 `(org_id, platform, shop_id, resource)`（DB 已有唯一索引；Prisma schema 未声明 `@@unique`，
 *   故用 findFirst + create，并吞掉并发创建的 P2002 后重读）；
 * - **租约**：`lease_owner/lease_until` 抢占，防同平台同 resource 并发跑；
 * - **断点续跑**：每页推进 `cursor/watermark_at`，失败保留最后成功游标；
 * - `consecutive_failures >= 5` → `status='error'`（docs/06 §4.5.2 要求告警）。
 */

import type { PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import type { Platform } from '../reconcile/types.js';
import type { SyncCursorRecord, SyncResource } from './types.js';

export const MAX_CONSECUTIVE_FAILURES = 5;

export interface SyncCursorStore {
  readonly name: 'postgres' | 'memory';
  getOrCreate(platform: Platform, resource: SyncResource, shopId?: string): Promise<SyncCursorRecord>;
  tryAcquire(id: string, owner: string, now: Date, leaseMs: number): Promise<boolean>;
  checkpoint(
    id: string,
    patch: { cursor: string | null; watermarkAt: Date | null; stats: Record<string, number> },
    now: Date,
  ): Promise<SyncCursorRecord>;
  recordFailure(id: string, input: { errorCode: string }, now: Date): Promise<SyncCursorRecord>;
  release(id: string): Promise<void>;
  list(platform?: Platform): Promise<SyncCursorRecord[]>;
}

function emptyStats(): Record<string, number> {
  return { pulled: 0, created: 0, updated: 0, skipped: 0 };
}

function parseStats(raw: unknown): Record<string, number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyStats();
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return { ...emptyStats(), ...out };
}

export class PrismaSyncCursorStore implements SyncCursorStore {
  readonly name = 'postgres' as const;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly orgId: bigint = 1n,
  ) {}

  private map(row: {
    id: string;
    platform: string;
    shopId: string;
    resource: string;
    cursor: string | null;
    watermarkAt: Date | null;
    pageSize: number;
    lastRunAt: Date | null;
    lastSuccessAt: Date | null;
    consecutiveFailures: number;
    status: string;
    leaseOwner: string | null;
    leaseUntil: Date | null;
    errorCode: string | null;
    stats: unknown;
  }): SyncCursorRecord {
    return {
      id: row.id,
      platform: row.platform as Platform,
      shopId: row.shopId,
      resource: row.resource as SyncResource,
      cursor: row.cursor,
      watermarkAt: row.watermarkAt,
      pageSize: row.pageSize,
      lastRunAt: row.lastRunAt,
      lastSuccessAt: row.lastSuccessAt,
      consecutiveFailures: row.consecutiveFailures,
      status: row.status as SyncCursorRecord['status'],
      leaseOwner: row.leaseOwner,
      leaseUntil: row.leaseUntil,
      errorCode: row.errorCode,
      stats: parseStats(row.stats),
    };
  }

  async getOrCreate(platform: Platform, resource: SyncResource, shopId = 'default'): Promise<SyncCursorRecord> {
    const where = { orgId: this.orgId, platform, shopId, resource, archivedAt: null };
    const existing = await this.prisma.syncCursor.findFirst({ where });
    if (existing) return this.map(existing);
    try {
      const created = await this.prisma.syncCursor.create({
        data: {
          orgId: this.orgId,
          platform,
          shopId,
          resource,
          cursor: null,
          pageSize: 100,
          status: 'active',
          stats: emptyStats(),
        },
      });
      return this.map(created);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const raced = await this.prisma.syncCursor.findFirst({ where });
        if (raced) return this.map(raced);
      }
      throw error;
    }
  }

  async tryAcquire(id: string, owner: string, now: Date, leaseMs: number): Promise<boolean> {
    const until = new Date(now.getTime() + leaseMs);
    const updated = await this.prisma.syncCursor.updateMany({
      where: {
        id,
        status: { not: 'paused' },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner: owner }],
      },
      data: { leaseOwner: owner, leaseUntil: until, lastRunAt: now },
    });
    return updated.count > 0;
  }

  async checkpoint(
    id: string,
    patch: { cursor: string | null; watermarkAt: Date | null; stats: Record<string, number> },
    now: Date,
  ): Promise<SyncCursorRecord> {
    const row = await this.prisma.syncCursor.update({
      where: { id },
      data: {
        cursor: patch.cursor,
        watermarkAt: patch.watermarkAt,
        lastRunAt: now,
        lastSuccessAt: now,
        consecutiveFailures: 0,
        status: 'active',
        errorCode: null,
        leaseOwner: null,
        leaseUntil: null,
        stats: patch.stats,
      },
    });
    return this.map(row);
  }

  async recordFailure(id: string, input: { errorCode: string }, now: Date): Promise<SyncCursorRecord> {
    const current = await this.prisma.syncCursor.update({
      where: { id },
      data: {
        lastRunAt: now,
        errorCode: input.errorCode,
        leaseOwner: null,
        leaseUntil: null,
        consecutiveFailures: { increment: 1 },
      },
    });
    if (current.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && current.status !== 'paused') {
      const updated = await this.prisma.syncCursor.update({
        where: { id },
        data: { status: 'error' },
      });
      return this.map(updated);
    }
    return this.map(current);
  }

  async release(id: string): Promise<void> {
    await this.prisma.syncCursor.updateMany({
      where: { id },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }

  async list(platform?: Platform): Promise<SyncCursorRecord[]> {
    const rows = await this.prisma.syncCursor.findMany({
      where: {
        orgId: this.orgId,
        archivedAt: null,
        ...(platform ? { platform } : {}),
      },
      orderBy: [{ platform: 'asc' }, { resource: 'asc' }],
    });
    return rows.map((row) => this.map(row));
  }
}

/** 内存实现（单测/无 DB 场景）；语义与 Prisma 版一致。 */
export class MemorySyncCursorStore implements SyncCursorStore {
  readonly name = 'memory' as const;
  private readonly rows = new Map<string, SyncCursorRecord>();

  private key(platform: Platform, resource: SyncResource, shopId: string): string {
    return `${platform}|${shopId}|${resource}`;
  }

  async getOrCreate(platform: Platform, resource: SyncResource, shopId = 'default'): Promise<SyncCursorRecord> {
    const key = this.key(platform, resource, shopId);
    const existing = this.rows.get(key);
    if (existing) return { ...existing };
    const created: SyncCursorRecord = {
      id: `mem-${key}`,
      platform,
      shopId,
      resource,
      cursor: null,
      watermarkAt: null,
      pageSize: 100,
      lastRunAt: null,
      lastSuccessAt: null,
      consecutiveFailures: 0,
      status: 'active',
      leaseOwner: null,
      leaseUntil: null,
      errorCode: null,
      stats: emptyStats(),
    };
    this.rows.set(key, created);
    return { ...created };
  }

  async tryAcquire(id: string, owner: string, now: Date, leaseMs: number): Promise<boolean> {
    const row = [...this.rows.values()].find((item) => item.id === id);
    if (!row || row.status === 'paused') return false;
    if (row.leaseUntil && row.leaseUntil.getTime() > now.getTime() && row.leaseOwner !== owner) return false;
    row.leaseOwner = owner;
    row.leaseUntil = new Date(now.getTime() + leaseMs);
    row.lastRunAt = now;
    return true;
  }

  async checkpoint(
    id: string,
    patch: { cursor: string | null; watermarkAt: Date | null; stats: Record<string, number> },
    now: Date,
  ): Promise<SyncCursorRecord> {
    const row = [...this.rows.values()].find((item) => item.id === id);
    if (!row) throw new ApiError('not_found', `sync_cursor 不存在：${id}`);
    row.cursor = patch.cursor;
    row.watermarkAt = patch.watermarkAt;
    row.lastRunAt = now;
    row.lastSuccessAt = now;
    row.consecutiveFailures = 0;
    row.status = 'active';
    row.errorCode = null;
    row.leaseOwner = null;
    row.leaseUntil = null;
    row.stats = patch.stats;
    return { ...row };
  }

  async recordFailure(id: string, input: { errorCode: string }, now: Date): Promise<SyncCursorRecord> {
    const row = [...this.rows.values()].find((item) => item.id === id);
    if (!row) throw new ApiError('not_found', `sync_cursor 不存在：${id}`);
    row.consecutiveFailures += 1;
    row.lastRunAt = now;
    row.errorCode = input.errorCode;
    row.leaseOwner = null;
    row.leaseUntil = null;
    if (row.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && row.status !== 'paused') row.status = 'error';
    return { ...row };
  }

  async release(id: string): Promise<void> {
    const row = [...this.rows.values()].find((item) => item.id === id);
    if (!row) return;
    row.leaseOwner = null;
    row.leaseUntil = null;
  }

  async list(platform?: Platform): Promise<SyncCursorRecord[]> {
    return [...this.rows.values()]
      .filter((row) => (platform ? row.platform === platform : true))
      .sort((a, b) => `${a.platform}|${a.resource}`.localeCompare(`${b.platform}|${b.resource}`))
      .map((row) => ({ ...row }));
  }
}
