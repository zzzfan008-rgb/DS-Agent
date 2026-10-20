/**
 * kill switch（docs/11 §9）：权威读 Postgres，作用域 global/platform/category/task_type。
 *
 * DB CHECK 只允许 4 种 scope_type（t1）；docs 中的 listing/provider 作用域当前无承载列，
 * 以 task_type/platform 组合近似，缺口登记在验收记录。
 * fail-closed：查询失败一律抛 kill_switch_on（guard=unavailable），绝不放行。
 */
import type { PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from '../services/audit.js';

export type KillSwitchTaskType = 'publish' | 'price' | 'stock' | 'message' | 'media' | 'sync' | 'batch';
export type KillSwitchScopeType = 'global' | 'platform' | 'category' | 'task_type';
export type KillSwitchAction = 'block_writes' | 'block_replies' | 'block_media' | 'block_model' | 'readonly';

export interface KillSwitchHit {
  id: string;
  scopeType: string;
  scopeKey: string;
  mode: 'block' | 'drain';
  action: string;
  reason: string;
  drill: boolean;
}

export interface KillSwitchCheckInput {
  platform: 'pdd' | '1688';
  taskType: KillSwitchTaskType;
  categoryId?: string | null;
}

const SCOPE_PRIORITY: Record<string, number> = {
  task_type: 4,
  category: 3,
  platform: 2,
  global: 1,
};

export class KillSwitchService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 返回命中的最严开关；未命中返回 null。DB 异常 fail-closed。 */
  async check(input: KillSwitchCheckInput): Promise<KillSwitchHit | null> {
    try {
      const now = this.now();
      const rows = await this.prisma.killSwitch.findMany({
        where: {
          orgId: 1n,
          enabled: true,
          archivedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
      });
      const hits: KillSwitchHit[] = [];
      for (const row of rows) {
        const matched =
          (row.scopeType === 'global' && (row.scopeKey === '*' || row.scopeKey === '')) ||
          (row.scopeType === 'platform' && row.scopeKey === input.platform) ||
          (row.scopeType === 'task_type' &&
            (row.scopeKey === `${input.platform}:${input.taskType}` ||
              row.scopeKey === input.taskType ||
              row.scopeKey === `*:${input.taskType}`)) ||
          (row.scopeType === 'category' &&
            input.categoryId !== null &&
            input.categoryId !== undefined &&
            (row.scopeKey === `${input.platform}:${input.categoryId}` ||
              row.scopeKey === input.categoryId));
        if (!matched) continue;
        hits.push({
          id: row.id,
          scopeType: row.scopeType,
          scopeKey: row.scopeKey,
          mode: row.mode === 'drain' ? 'drain' : 'block',
          action: row.action,
          reason: row.reason,
          drill: row.drill,
        });
      }
      if (hits.length === 0) return null;
      hits.sort((a, b) => {
        const modeRank = (hit: KillSwitchHit) => (hit.mode === 'block' ? 2 : 1);
        return (
          modeRank(b) - modeRank(a) ||
          (SCOPE_PRIORITY[b.scopeType] ?? 0) - (SCOPE_PRIORITY[a.scopeType] ?? 0)
        );
      });
      return hits[0]!;
    } catch (error) {
      throw new ApiError('kill_switch_on', 'kill switch 读取失败，按 fail-closed 阻断写', {
        detail: { guard: 'unavailable', cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async assertNotBlocked(input: KillSwitchCheckInput): Promise<void> {
    const hit = await this.check(input);
    if (hit) {
      throw new ApiError('kill_switch_on', `kill switch 已阻断：${hit.reason}`, {
        detail: { ...hit, guard: 'hit' },
      });
    }
  }

  async create(
    input: {
      scopeType: KillSwitchScopeType;
      scopeKey: string;
      action: KillSwitchAction;
      mode?: 'block' | 'drain';
      reason: string;
      expiresAt?: string | null;
      drill?: boolean;
    },
    context: { userId: string; requestId: string; role: string; ip: string | null; userAgent: string | null },
  ) {
    if (context.role !== 'admin') throw new ApiError('forbidden', '只有 admin 可以创建 kill switch');
    if (input.reason.trim().length < 3) {
      throw new ApiError('validation_failed', 'reason 至少 3 个字符', { detail: { field: 'reason' } });
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new ApiError('validation_failed', 'expires_at 不是合法时间', { detail: { field: 'expires_at' } });
    }
    const row = await this.prisma.killSwitch.create({
      data: {
        orgId: 1n,
        scopeType: input.scopeType,
        scopeKey: input.scopeKey || '*',
        action: input.action,
        mode: input.mode ?? 'block',
        enabled: true,
        reason: input.reason,
        enabledBy: context.userId,
        expiresAt,
        drill: input.drill ?? false,
        createdBy: context.userId,
      },
    });
    await this.audit.record({
      action: input.drill ? 'kill_switch.drill' : 'kill_switch.create',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'kill_switch',
      resourceId: row.id,
      after: {
        scope_type: row.scopeType,
        scope_key: row.scopeKey,
        action: row.action,
        mode: row.mode,
        reason: row.reason,
        expires_at: row.expiresAt?.toISOString() ?? null,
        drill: row.drill,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role },
    });
    return row;
  }

  async disable(
    id: string,
    input: { reason: string; confirm: boolean },
    context: { userId: string; requestId: string; role: string; ip: string | null; userAgent: string | null },
  ) {
    if (context.role !== 'admin') throw new ApiError('forbidden', '只有 admin 可以关闭 kill switch');
    if (!input.confirm) {
      throw new ApiError('validation_failed', '关闭 kill switch 需要二次确认', { detail: { field: 'confirm' } });
    }
    if (input.reason.trim().length < 3) {
      throw new ApiError('validation_failed', 'reason 至少 3 个字符', { detail: { field: 'reason' } });
    }
    const row = await this.prisma.killSwitch.findFirst({ where: { id, archivedAt: null } });
    if (!row) throw new ApiError('not_found', 'kill switch 不存在');
    if (!row.enabled) return row;
    const updated = await this.prisma.killSwitch.update({
      where: { id },
      data: {
        enabled: false,
        disabledBy: context.userId,
        disabledAt: this.now(),
        reason: `${row.reason} / disabled: ${input.reason}`,
      },
    });
    await this.audit.record({
      action: 'kill_switch.disable',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'kill_switch',
      resourceId: id,
      before: { enabled: true, reason: row.reason },
      after: { enabled: false, reason: input.reason },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role },
    });
    return updated;
  }

  async list() {
    return this.prisma.killSwitch.findMany({
      where: { orgId: 1n, archivedAt: null },
      orderBy: [{ enabled: 'desc' }, { enabledAt: 'desc' }],
      take: 100,
    });
  }
}
