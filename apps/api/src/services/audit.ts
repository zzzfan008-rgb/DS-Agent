/**
 * 审计服务：追加写 + 哈希链 + 查询（docs/06 §4.8.4、docs/14 §6、docs/12 §3.11）。
 *
 * 关键约束：
 * - 只 INSERT；DB 触发器 `trg_audit_no_update` 会拒绝 UPDATE/DELETE（42501）；
 * - `chain_hash` 为 NOT NULL 且 DB 不代算，必须由应用在同一事务内取链尾后计算；
 * - 并发写入用 `pg_advisory_xact_lock` 串行化，避免两条记录同时指向同一 chain_prev；
 * - canonical(row) = 键排序 JSON（不含 seq / chain_prev / chain_hash），
 *   chain_hash = sha256(chain_prev ?? '' + canonical(row))；verify 脚本用同一函数复算。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { canonicalJson, sha256Hex, sha256Json, uuidv7 } from '../lib/ids.js';
import type { MetricsRegistry } from './metrics.js';

export type AuditActorType = 'user' | 'agent' | 'worker' | 'system';

export interface AuditRecordInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  requestId: string;
  before?: unknown;
  after?: unknown;
  diff?: unknown;
  irreversible?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
  orgId?: bigint | number;
}

export interface AuditChainRow {
  id: string;
  orgId: bigint;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string;
  before: unknown;
  after: unknown;
  diff: unknown;
  irreversible: boolean;
  ip: string | null;
  userAgent: string | null;
  meta: unknown;
  chainPrev: string | null;
  chainHash: string;
  seq: bigint;
}

export interface AuditItem {
  id: string;
  at: string;
  actor: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  level: string | null;
  irreversible: boolean;
  approval_id: string | null;
  request_id: string;
  before_hash: string;
  after_hash: string;
  ticket_id: string | null;
}

export interface AuditListFilters {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  irreversible?: boolean;
  from?: Date;
  to?: Date;
  cursorSeq?: bigint;
  limit: number;
  withTotal?: boolean;
}

export interface AuditListResult {
  items: AuditItem[];
  nextCursorSeq: string | null;
  total?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === undefined || value === null) return {};
  return JSON.parse(canonicalJson(value)) as Prisma.InputJsonValue;
}

/** 参与哈希链的规范化行（字段名用 DB 列名，便于人工复算）。 */
export function auditCanonicalRow(row: Omit<AuditChainRow, 'seq' | 'chainHash'>): string {
  return canonicalJson({
    id: row.id,
    org_id: row.orgId.toString(),
    occurred_at: row.occurredAt.toISOString(),
    actor_type: row.actorType,
    actor_id: row.actorId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    request_id: row.requestId,
    before: row.before,
    after: row.after,
    diff: row.diff,
    irreversible: row.irreversible,
    ip: row.ip,
    user_agent: row.userAgent,
    meta: row.meta,
  });
}

export function computeChainHash(
  chainPrev: string | null,
  row: Omit<AuditChainRow, 'seq' | 'chainHash'>,
): string {
  return sha256Hex(`${chainPrev ?? ''}${auditCanonicalRow(row)}`);
}

export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly metrics?: MetricsRegistry,
  ) {}

  /** 追加一条审计；返回 seq。失败时抛出，由调用方决定 fail-closed 还是记录日志。 */
  async record(input: AuditRecordInput): Promise<bigint> {
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('dssaas.audit_log.chain')::bigint)::text AS locked",
      );
      const tail = await tx.$queryRaw<Array<{ chain_hash: string }>>`
        SELECT chain_hash FROM audit_log ORDER BY seq DESC LIMIT 1
      `;
      const chainPrev = tail[0]?.chain_hash ?? null;
      const occurredAt = new Date();
      const id = uuidv7();
      const actorId = input.actorId ?? null;
      const resourceId = input.resourceId ?? null;
      const ip = input.ip ?? null;
      const userAgent = input.userAgent ?? null;
      const before = toJsonValue(input.before);
      const after = toJsonValue(input.after);
      const diff = toJsonValue(input.diff);
      const meta = toJsonValue(input.meta);
      const irreversible = input.irreversible ?? false;
      const orgId = input.orgId === undefined ? 1n : BigInt(input.orgId);

      const row: Omit<AuditChainRow, 'seq' | 'chainHash'> = {
        id,
        orgId,
        occurredAt,
        actorType: input.actorType,
        actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId,
        requestId: input.requestId,
        before,
        after,
        diff,
        irreversible,
        ip,
        userAgent,
        meta,
        chainPrev,
      };
      const chainHash = computeChainHash(chainPrev, row);

      const result = await tx.auditLog.create({
        data: {
          id,
          orgId,
          occurredAt,
          actorType: input.actorType,
          actorId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId,
          requestId: input.requestId,
          before,
          after,
          diff,
          irreversible,
          ip,
          userAgent,
          meta,
          chainPrev,
          chainHash,
        },
        select: { seq: true },
      });
      return result.seq;
    });

    this.metrics?.inc('dssaas_audit_writes_total', '审计写入条数', {
      action: input.action,
    });
    return created;
  }

  async list(filters: AuditListFilters): Promise<AuditListResult> {
    const where: Prisma.AuditLogWhereInput = {};
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.action) where.action = filters.action;
    if (filters.resourceType) where.resourceType = filters.resourceType;
    if (filters.resourceId) where.resourceId = filters.resourceId;
    if (filters.irreversible !== undefined) where.irreversible = filters.irreversible;
    if (filters.from || filters.to) {
      where.occurredAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    if (filters.cursorSeq !== undefined) where.seq = { lt: filters.cursorSeq };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { seq: 'desc' },
        take: filters.limit + 1,
      }),
      filters.withTotal ? this.prisma.auditLog.count({ where }) : Promise.resolve(undefined),
    ]);

    const page = rows.slice(0, filters.limit);
    const items = page.map((row) => {
      const meta = asRecord(row.meta);
      const after = asRecord(row.after);
      return {
        id: row.id,
        at: row.occurredAt.toISOString(),
        actor: row.actorId,
        actor_role: typeof meta.actor_role === 'string' ? meta.actor_role : null,
        action: row.action,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        level:
          typeof meta.level === 'string'
            ? meta.level
            : typeof after.operation_level === 'string'
              ? after.operation_level
              : null,
        irreversible: row.irreversible,
        approval_id: typeof meta.approval_id === 'string' ? meta.approval_id : null,
        request_id: row.requestId,
        before_hash: sha256Json(row.before),
        after_hash: sha256Json(row.after),
        ticket_id: typeof meta.ticket_id === 'string' ? meta.ticket_id : null,
      } satisfies AuditItem;
    });

    return {
      items,
      nextCursorSeq: rows.length > filters.limit ? String(page[page.length - 1]!.seq) : null,
      ...(total === undefined ? {} : { total }),
    };
  }

  /** 全链复算：chain_prev 指针 + chain_hash 都校验。 */
  async verifyChain(): Promise<{
    ok: boolean;
    checked: number;
    brokenAtSeq: string | null;
    reason: string | null;
  }> {
    let lastSeq = 0n;
    let previousHash: string | null = null;
    let checked = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { seq: { gt: lastSeq } },
        orderBy: { seq: 'asc' },
        take: 500,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const expectedPrev = previousHash;
        if ((row.chainPrev ?? null) !== expectedPrev) {
          return {
            ok: false,
            checked,
            brokenAtSeq: String(row.seq),
            reason: `chain_prev 不匹配：期望 ${expectedPrev ?? 'null'}`,
          };
        }
        const expectedHash = computeChainHash(row.chainPrev, row);
        if (row.chainHash !== expectedHash) {
          return {
            ok: false,
            checked,
            brokenAtSeq: String(row.seq),
            reason: 'chain_hash 复算不匹配',
          };
        }
        previousHash = row.chainHash;
        lastSeq = row.seq;
        checked += 1;
      }
    }
    return { ok: true, checked, brokenAtSeq: null, reason: null };
  }
}
