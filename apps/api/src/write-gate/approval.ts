/**
 * approval 生命周期（docs/11 §6.4–§6.5）：服务端定级、target_hash 绑定、四眼、SLA。
 *
 * DB 只存 operation_level（A/B/C），没有 second_confirm_by / payload_patch / batch_id 列；
 * C 级二次确认由 confirm_token（绑定 approval+user+target_hash）实现，缺口登记验收记录。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { canonicalHash } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from '../services/audit.js';
import { contentDraftTargetHash } from '../services/content-target.js';
import {
  computeLevel,
  getActionMeta,
  type DbApprovalAction,
  type Level,
  type LevelContext,
} from './actions.js';

export interface ApprovalContext {
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface ApprovalCreateInput {
  subject_type:
    | 'content_draft'
    | 'listing'
    | 'message'
    | 'quote'
    | 'media_asset'
    | 'price_change'
    | 'batch_action';
  subject_id: string;
  action: DbApprovalAction;
  platform: 'pdd' | '1688';
  /** 审批绑定的规范化对象（diff 右侧/建议改动）；hash 由服务端计算。 */
  target_payload: Record<string, unknown>;
  fact_snapshot?: Record<string, unknown>;
  risk_meta?: Record<string, unknown>;
  diff?: Record<string, unknown>;
  context?: LevelContext;
  scheduled_at?: string | null;
  expires_at?: string | null;
}

const SLA_DECISION_MS: Record<Level, number> = {
  C: 60 * 60 * 1000,
  B: 4 * 60 * 60 * 1000,
  A: 8 * 60 * 60 * 1000,
};
const APPROVAL_TTL_MS: Record<Level, number> = {
  C: 24 * 60 * 60 * 1000,
  B: 48 * 60 * 60 * 1000,
  A: 72 * 60 * 60 * 1000,
};

const DB_ACTION_TO_CODE: Record<DbApprovalAction, string> = {
  publish: 'listing.create',
  update_price: 'listing.update_price',
  update_stock: 'listing.update_stock',
  replace_main_image: 'listing.replace_main_image',
  change_category: 'listing.update_category',
  send_reply: 'message.send',
  send_quote: 'inquiry.quote',
  upload_video: 'listing.update_content',
  batch_offline: 'listing.batch_offline',
  publish_content: 'content.publish',
};

export function actionCodeForApproval(action: DbApprovalAction): string {
  return DB_ACTION_TO_CODE[action];
}

export function computeApprovalSubjectHash(payload: Record<string, unknown>): string {
  return canonicalHash(payload);
}

export class ApprovalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: ApprovalCreateInput, context: ApprovalContext) {
    if (context.role === 'viewer') throw new ApiError('forbidden', 'viewer 不能发起审批');
    const actionCode = actionCodeForApproval(input.action);
    const meta = getActionMeta(actionCode);
    const levelDecision = computeLevel(actionCode, {
      ...(input.context ?? {}),
      listingStatus: input.context?.listingStatus ?? null,
    });
    const level = levelDecision.level;
    const targetHash = computeApprovalSubjectHash(input.target_payload);
    const now = this.now();

    const existing = await this.prisma.approval.findFirst({
      where: {
        orgId: 1n,
        subjectType: input.subject_type,
        subjectId: input.subject_id,
        action: input.action,
        targetHash,
        status: 'pending',
        archivedAt: null,
      },
      select: { id: true, version: true },
    });
    if (existing) {
      throw new ApiError('conflict', '同一内容已有待审批记录', {
        detail: { approval_id: existing.id, target_hash: targetHash },
      });
    }

    const riskMeta = {
      ...(input.risk_meta ?? {}),
      ...(level === 'C' ? { impact_scope: input.risk_meta?.impact_scope ?? {} } : {}),
      level_reasons: levelDecision.reasons,
      action_code: actionCode,
      approval_action: input.action,
    };
    const expiresAt = input.expires_at ? new Date(input.expires_at) : new Date(now.getTime() + APPROVAL_TTL_MS[level]);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new ApiError('validation_failed', 'expires_at 不是合法时间', { detail: { field: 'expires_at' } });
    }
    const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : null;
    const row = await this.prisma.approval.create({
      data: {
        orgId: 1n,
        subjectType: input.subject_type,
        subjectId: input.subject_id,
        action: input.action,
        platform: input.platform,
        operationLevel: level,
        status: 'pending',
        targetHash,
        factSnapshot: (input.fact_snapshot ?? {}) as Prisma.InputJsonValue,
        riskMeta: riskMeta as Prisma.InputJsonValue,
        diff: {
          ...(input.diff ?? {}),
          target_payload: input.target_payload,
        } as Prisma.InputJsonValue,
        slaDueAt: new Date(now.getTime() + SLA_DECISION_MS[level]),
        expiresAt,
        scheduledAt,
        requestId: context.requestId,
        createdBy: context.userId,
      },
    });

    await this.audit.record({
      action: 'approval.create',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'approval',
      resourceId: row.id,
      after: {
        subject_type: input.subject_type,
        subject_id: input.subject_id,
        action: input.action,
        platform: input.platform,
        level,
        target_hash: targetHash,
        expires_at: expiresAt.toISOString(),
        sla_due_at: row.slaDueAt?.toISOString() ?? null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, level_reasons: levelDecision.reasons, meta_action: meta.code },
    });

    return { ...row, levelReasons: levelDecision.reasons };
  }

  async decide(
    id: string,
    input: {
      decision: 'approve' | 'approve_with_edit' | 'reject' | 'schedule';
      comment?: string;
      scheduled_at?: string | null;
      confirm_token?: string;
    },
    context: ApprovalContext,
  ) {
    const row = await this.prisma.approval.findFirst({ where: { id, archivedAt: null } });
    if (!row) throw new ApiError('not_found', '审批不存在');
    if (row.subjectType === 'content_draft' || row.action === 'publish_content') {
      const draft = await this.prisma.contentDraft.findFirst({
        where: { id: row.subjectId, archivedAt: null },
      });
      if (!draft) {
        throw new ApiError('approval_stale', '审批绑定的内容草稿已不存在', {
          detail: { approval_id: row.id, subject_id: row.subjectId, next_action: 'resubmit' },
        });
      }
      const currentHash = contentDraftTargetHash({
        id: draft.id,
        productId: draft.productId,
        platform: draft.platform,
        contentType: draft.contentType,
        body: draft.body,
        facts: draft.facts,
      });
      if (currentHash !== row.targetHash) {
        throw new ApiError('approval_stale', '内容已变更，审批 target_hash 失效', {
          detail: {
            approval_id: row.id,
            expected_hash: row.targetHash,
            current_hash: currentHash,
            next_action: 'resubmit',
          },
        });
      }
    }
    if (!['pending', 'escalated'].includes(row.status)) {
      throw new ApiError('conflict', '审批已决策', { detail: { status: row.status } });
    }
    if (row.expiresAt.getTime() <= this.now().getTime()) {
      throw new ApiError('approval_stale', '审批已过期');
    }
    if (row.operationLevel === 'C' && context.role !== 'admin') {
      throw new ApiError('forbidden', 'C 级审批只能由 admin 决策');
    }
    if (context.role === 'viewer') throw new ApiError('forbidden', 'viewer 不能决策');
    if (row.createdBy === context.userId) {
      throw new ApiError('forbidden', '四眼原则：申请人不能审批自己的申请');
    }
    if (input.decision === 'reject' && (!input.comment || input.comment.trim().length === 0)) {
      throw new ApiError('validation_failed', '拒绝必须填写理由', { detail: { field: 'comment' } });
    }

    const status =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'approve_with_edit'
          ? 'approved_with_edit'
          : input.decision === 'schedule'
            ? 'scheduled'
            : 'rejected';
    const scheduledAt = input.scheduled_at ? new Date(input.scheduled_at) : row.scheduledAt;
    const updated = await this.prisma.approval.update({
      where: { id },
      data: {
        status,
        decision: input.decision,
        decidedBy: context.userId,
        decidedAt: this.now(),
        decisionNote: input.comment ?? null,
        scheduledAt,
        ...(input.decision === 'reject' ? { invalidatedAt: this.now(), invalidReason: input.comment ?? null } : {}),
      },
    });
    await this.audit.record({
      action: 'approval.decide',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'approval',
      resourceId: id,
      before: { status: row.status },
      after: { status, decision: input.decision, comment: input.comment ?? null, scheduled_at: scheduledAt?.toISOString() ?? null },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, subject_type: row.subjectType, level: row.operationLevel, target_hash: row.targetHash },
    });
    return updated;
  }

  async list(query: {
    status?: string;
    level?: string;
    platform?: string;
    action?: string;
    overdue?: boolean;
    cursor?: string;
    limit: number;
    assignee?: string;
  }) {
    const where: Prisma.ApprovalWhereInput = { orgId: 1n, archivedAt: null };
    if (query.status) where.status = query.status;
    if (query.level) where.operationLevel = query.level;
    if (query.platform) where.platform = query.platform;
    if (query.action) where.action = query.action;
    if (query.overdue) {
      where.status = 'pending';
      where.slaDueAt = { lt: this.now() };
    }
    if (query.cursor) where.id = { lt: query.cursor };
    const rows = await this.prisma.approval.findMany({
      where,
      orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const now = this.now().getTime();
    return {
      items: page.map((row) => ({
        id: row.id,
        object_type: row.subjectType,
        object_id: row.subjectId,
        action: row.action,
        level: row.operationLevel,
        platform: row.platform,
        status: row.status,
        sla_due_at: row.slaDueAt?.toISOString() ?? null,
        overdue: Boolean(row.slaDueAt && row.slaDueAt.getTime() < now && row.status === 'pending'),
        risk_notes: ((row.riskMeta as Record<string, unknown>)?.risk_notes as string[] | undefined) ?? [],
        risk_meta: row.riskMeta,
        requested_by: row.createdBy,
        requested_at: row.createdAt.toISOString(),
        target_hash: row.targetHash,
      })),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }

  async get(id: string) {
    const row = await this.prisma.approval.findFirst({ where: { id, archivedAt: null } });
    if (!row) throw new ApiError('not_found', '审批不存在');
    return {
      id: row.id,
      subject_type: row.subjectType,
      subject_id: row.subjectId,
      action: row.action,
      platform: row.platform,
      level: row.operationLevel,
      status: row.status,
      decision: row.decision,
      target_hash: row.targetHash,
      fact_snapshot: row.factSnapshot,
      risk_meta: row.riskMeta,
      diff: row.diff,
      requested_by: row.createdBy,
      decided_by: row.decidedBy,
      decided_at: row.decidedAt?.toISOString() ?? null,
      decision_note: row.decisionNote,
      sla_due_at: row.slaDueAt?.toISOString() ?? null,
      scheduled_at: row.scheduledAt?.toISOString() ?? null,
      expires_at: row.expiresAt.toISOString(),
      executed_at: row.executedAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
      allowed_decisions: row.status === 'pending' ? ['approve', 'approve_with_edit', 'reject', 'schedule'] : [],
    };
  }

  async markExecuted(id: string, now: Date = this.now()): Promise<void> {
    await this.prisma.approval.update({
      where: { id },
      data: { status: 'executed', executedAt: now },
    });
  }
}
