/**
 * 写入门（docs/11 §7）：唯一平台写入口。
 *
 * 固定时序，调用方不可重排：
 *   S1 身份 → S1.5 kill switch 预检 → S2 approval → S3 快照 → S4 幂等
 *   → S5 kill switch 权威检 + 并发锁 + 限流 → S6 adapter（M4 仅 dry-run）
 *   → S7 结果分类 → S8 审计/写留痕/补偿工单（同一 DB 事务）→ S9 回写
 *
 * 硬约束：
 * - 未带 approval_id：approval_required；
 * - C 级缺 confirm_token：irreversible，且 token 绑定 approval/user/target_hash，一次性；
 * - B/C 动作没有可调用的回滚路径；rollback 只接受 reversible 动作；
 * - 重复提交同 write_key：返回响应回放，不再调 adapter、不再建工单。
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@dssaas/db';
import { canonicalHash, canonicalJson, computeWriteKey } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from '../services/audit.js';
import { ApprovalService } from './approval.js';
import {
  computeLevel,
  getActionMeta,
  isIrreversible,
  type ActionMeta,
  type Level,
} from './actions.js';
import type { ConfirmTokenStore } from './confirm.js';
import type { KillSwitchService } from './kill-switch.js';
import type { PlatformPreview, PlatformWritePort } from './platform-port.js';
import type { FailureClassification } from './workflow.js';
import { classifyFailure, computeBackoffMs } from './workflow.js';

export interface WriteGateContext {
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface WriteGateRequest {
  action: string;
  platform: 'pdd' | '1688';
  listing_id?: string;
  product_id?: string;
  payload: Record<string, unknown>;
  approval_id?: string;
  confirm_token?: string;
  mode?: 'dry_run' | 'canary' | 'full';
  expected_current_hash?: string;
  reason?: string;
}

export interface WriteGateResult {
  write_id: string;
  approval_id: string;
  level: Level;
  idempotent_replayed: boolean;
  result: 'success' | 'failed' | 'uncertain';
  platform_response: Record<string, unknown>;
  snapshot_ref: string;
  compensating_ticket_id: string | null;
  workflow_run_id: string;
  next_action: string | null;
  adapter: PlatformPreview | null;
}

export interface WriteGateDeps {
  prisma: PrismaClient;
  audit: AuditService;
  approvals: ApprovalService;
  killSwitch: KillSwitchService;
  confirmTokens: ConfirmTokenStore;
  platform: PlatformWritePort;
  now?: () => Date;
}

export function publishTargetPayload(input: {
  product_id: string;
  platform: 'pdd' | '1688';
  sku_ids: string[];
  media_plan?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    product_id: input.product_id,
    platform: input.platform,
    sku_ids: [...new Set(input.sku_ids)].sort(),
    media_plan: input.media_plan ?? {},
  };
}

export function genericTargetPayload(input: {
  action: string;
  platform: 'pdd' | '1688';
  listing_id: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    action: input.action,
    platform: input.platform,
    listing_id: input.listing_id,
    payload: input.payload,
  };
}

export function targetHashForRequest(req: WriteGateRequest): string {
  if (req.product_id && Array.isArray(req.payload.sku_ids)) {
    return canonicalHash(
      publishTargetPayload({
        product_id: req.product_id,
        platform: req.platform,
        sku_ids: (req.payload.sku_ids as unknown[]).map(String),
        media_plan: (req.payload.media_plan as Record<string, unknown> | undefined) ?? {},
      }),
    );
  }
  if (!req.listing_id) {
    throw new ApiError('validation_failed', '写请求必须提供 listing_id 或 product_id', {
      detail: { field: 'listing_id' },
    });
  }
  return canonicalHash(
    genericTargetPayload({
      action: req.action,
      platform: req.platform,
      listing_id: req.listing_id,
      payload: req.payload,
    }),
  );
}

class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();

  check(key: string, limit: number, windowMs: number, now: number): boolean {
    const windowStart = now - windowMs;
    const entries = (this.buckets.get(key) ?? []).filter((at) => at > windowStart);
    if (entries.length >= limit) {
      this.buckets.set(key, entries);
      return false;
    }
    entries.push(now);
    this.buckets.set(key, entries);
    return true;
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class WriteGate {
  private readonly limiter = new SlidingWindowLimiter();
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();
  private readonly now: () => Date;

  constructor(private readonly deps: WriteGateDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async resolveListing(req: WriteGateRequest, ctx: WriteGateContext) {
    if (req.listing_id) {
      const listing = await this.deps.prisma.listing.findFirst({
        where: { id: req.listing_id, orgId: 1n, archivedAt: null },
      });
      if (!listing) throw new ApiError('not_found', 'listing 不存在');
      return listing;
    }
    if (!req.product_id) throw new ApiError('validation_failed', '缺少 listing_id/product_id');
    const product = await this.deps.prisma.product.findFirst({
      where: { id: req.product_id, archivedAt: null },
      select: { id: true },
    });
    if (!product) throw new ApiError('not_found', '商品不存在');
    const existing = await this.deps.prisma.listing.findFirst({
      where: { productId: req.product_id, platform: req.platform, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;
    return this.deps.prisma.listing.create({
      data: {
        orgId: 1n,
        platform: req.platform,
        productId: req.product_id,
        status: 'draft',
        createdBy: ctx.userId,
      },
    });
  }

  private levelFor(meta: ActionMeta, req: WriteGateRequest, listing: { status: string; platformItemId: string | null }) {
    const payload = req.payload;
    const skuIds = Array.isArray(payload.sku_ids) ? payload.sku_ids : [];
    const affectedSkus = Number(payload.affected_skus ?? skuIds.length ?? 0);
    return {
      listingStatus: listing.status,
      activityHit: payload.activity_hit === true,
      touchesMainImage: payload.main_image_id !== undefined && payload.main_image_id !== null,
      touchesCategoryOrKeyAttr: payload.touches_category_or_key_attr === true,
      priceDeltaRatio: typeof payload.price_delta_ratio === 'number' ? payload.price_delta_ratio : 0,
      affectedSkus: Number.isFinite(affectedSkus) ? affectedSkus : 0,
      irreversibleFields: Array.isArray(payload.irreversible_fields)
        ? payload.irreversible_fields.map(String)
        : [],
      firstPublish: listing.status === 'draft' && listing.platformItemId === null,
      notOnline: listing.platformItemId === null,
    };
  }

  private async assertApproval(
    req: WriteGateRequest,
    meta: ActionMeta,
    level: Level,
    targetHash: string,
    listingId: string,
    ctx: WriteGateContext,
  ) {
    if (!req.approval_id) {
      throw new ApiError('approval_required', '平台写必须携带 approval_id', {
        detail: { action: req.action, level, target_hash: targetHash },
      });
    }
    const approval = await this.deps.prisma.approval.findFirst({
      where: { id: req.approval_id, orgId: 1n, archivedAt: null },
    });
    if (!approval) throw new ApiError('approval_required', 'approval_id 不存在');
    if (approval.action !== meta.approvalAction || approval.platform !== req.platform) {
      throw new ApiError('approval_stale', '审批动作/平台与本次写不一致', {
        detail: {
          expected_action: meta.approvalAction,
          actual_action: approval.action,
          expected_platform: req.platform,
          actual_platform: approval.platform,
        },
      });
    }
    if (approval.subjectType === 'listing' && approval.subjectId !== listingId) {
      throw new ApiError('approval_stale', '审批对象不是当前 listing');
    }
    if (!['approved', 'approved_with_edit', 'scheduled', 'executed'].includes(approval.status)) {
      throw new ApiError(
        approval.status === 'pending' ? 'approval_required' : 'approval_stale',
        approval.status === 'pending' ? '审批尚未通过' : `审批状态 ${approval.status} 不允许执行`,
        { detail: { status: approval.status } },
      );
    }
    if (approval.expiresAt.getTime() <= this.now().getTime()) {
      throw new ApiError('approval_stale', '审批已过期', {
        detail: { expires_at: approval.expiresAt.toISOString() },
      });
    }
    if (approval.scheduledAt && approval.scheduledAt.getTime() > this.now().getTime()) {
      throw new ApiError('conflict', '审批预约窗口未到', {
        detail: { scheduled_at: approval.scheduledAt.toISOString() },
      });
    }
    if (approval.targetHash !== targetHash) {
      throw new ApiError('approval_stale', '审批 target_hash 与当前内容不一致（内容已变）', {
        detail: { expected: approval.targetHash, actual: targetHash },
      });
    }
    if (approval.operationLevel !== level) {
      throw new ApiError('approval_stale', '审批级别与当前判定不一致', {
        detail: { approval_level: approval.operationLevel, computed_level: level },
      });
    }
    if (!approval.decidedBy) throw new ApiError('approval_required', '审批尚未决策');
    if (approval.decidedBy === approval.createdBy) {
      throw new ApiError('forbidden', '四眼原则：审批人不能是申请人');
    }
    if (approval.decidedBy === ctx.userId) {
      throw new ApiError('forbidden', '四眼原则：执行人不能是审批人');
    }
    if (level === 'C' && !req.confirm_token) {
      throw new ApiError('irreversible', 'C 级动作必须二次确认（缺 confirm_token）', {
        detail: { reason: 'confirm_token_required', approval_id: approval.id, target_hash: targetHash },
      });
    }
    return approval;
  }

  private async snapshot(listingId: string, fields: Record<string, unknown>, ctx: WriteGateContext) {
    const snapshotHash = canonicalHash(fields);
    try {
      return await this.deps.prisma.listingSnapshot.create({
        data: {
          orgId: 1n,
          listingId,
          snapshotHash,
          capturedAt: this.now(),
          source: 'pre_write',
          fields: fields as Prisma.InputJsonValue,
          createdBy: ctx.userId,
        },
      });
    } catch (error) {
      throw new ApiError('upstream_5xx', '写前快照失败，禁止写平台', {
        detail: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async checkIdempotency(input: {
    key: string;
    requestHash: string;
    ctx: WriteGateContext;
  }): Promise<{ state: 'new' | 'replay'; record?: { id: string; response: Record<string, unknown> } }> {
    const existing = await this.deps.prisma.idempotencyKey.findFirst({
      where: { orgId: 1n, scope: 'write', key: input.key, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) return { state: 'new' };
    if (existing.requestHash !== input.requestHash) {
      throw new ApiError('conflict', '同一幂等键对应不同请求内容', {
        detail: { key: input.key, reason: 'idempotency_conflict' },
      });
    }
    if (existing.status === 'succeeded') {
      return {
        state: 'replay',
        record: { id: existing.id, response: jsonObject(existing.responseSnapshot) },
      };
    }
    if (existing.status === 'in_flight') {
      throw new ApiError('conflict', '同一写请求正在执行（in_flight），拒绝并发重复', {
        detail: { key: input.key, retry_after: 2 },
      });
    }
    // failed：允许同一请求重试，重置为 in_flight。
    await this.deps.prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: { status: 'in_flight', expiresAt: new Date(this.now().getTime() + 24 * 3600 * 1000) },
    });
    return { state: 'new' };
  }

  private acquireLock(listingId: string, owner: string): () => void {
    const key = `listing:${listingId}`;
    const now = this.now().getTime();
    const current = this.locks.get(key);
    if (current && current.expiresAt > now && current.owner !== owner) {
      throw new ApiError('conflict', '同一 listing 有并发写，稍后重试', {
        detail: { listing_id: listingId, retry_after: 2 },
      });
    }
    this.locks.set(key, { owner, expiresAt: now + 60_000 });
    return () => {
      const held = this.locks.get(key);
      if (held?.owner === owner) this.locks.delete(key);
    };
  }

  private async run(
    req: WriteGateRequest,
    ctx: WriteGateContext,
  ): Promise<WriteGateResult> {
    if (ctx.role === 'viewer') throw new ApiError('forbidden', 'viewer 不能执行平台写');
    const meta = getActionMeta(req.action);
    if (!meta.allowsSnapshotRestore && req.action === 'listing.restore_snapshot') {
      throw new ApiError('irreversible', '该动作不允许快照恢复');
    }
    const listing = await this.resolveListing(req, ctx);
    const levelDecision = this.levelFor(meta, req, listing);
    const level = computeLevel(meta.code, levelDecision).level;
    const targetHash = targetHashForRequest({ ...req, listing_id: listing.id, product_id: listing.productId });
    const mode = req.mode ?? 'dry_run';

    // S1.5 廉价预检（S5 再权威回源）
    await this.deps.killSwitch.assertNotBlocked({
      platform: req.platform,
      taskType: meta.taskType,
    });

    // S2 approval
    const approval = await this.assertApproval(req, meta, level, targetHash, listing.id, ctx);

    // C 级二次确认：在快照/幂等之前一次性消费，保证 token 复用必失败（不是 replay 放行）。
    if (level === 'C') {
      this.deps.confirmTokens.consume({
        token: req.confirm_token!,
        approvalId: approval.id,
        userId: ctx.userId,
        action: meta.code,
        targetHash,
      });
    }

    // S3 快照（失败即停）
    const snapshotFields = {
      listing_id: listing.id,
      platform: listing.platform,
      status: listing.status,
      platform_state: listing.platformState,
      platform_item_id: listing.platformItemId,
      title: listing.title,
      main_image_id: listing.mainImageId,
      price_tiers: listing.priceTiers,
      sku_bindings: listing.skuBindings,
      published_snapshot: listing.publishedSnapshot,
      captured_at: this.now().toISOString(),
      capture_source: 'local_mirror',
      approval_id: approval.id,
      target_hash: targetHash,
    };
    const snapshot = await this.snapshot(listing.id, snapshotFields, ctx);

    // S4 幂等
    const writeKey = req.expected_current_hash
      ? computeWriteKey({
          platform: req.platform,
          action: meta.code,
          payload: { target_hash: targetHash, expected_current_hash: req.expected_current_hash, mode },
        })
      : computeWriteKey({
          platform: req.platform,
          action: meta.code,
          payload: { target_hash: targetHash, mode },
        });
    const requestHash = canonicalHash({
      action: meta.code,
      approval_id: approval.id,
      target_hash: targetHash,
      mode,
    });
    const idempotency = await this.checkIdempotency({ key: writeKey, requestHash, ctx });
    if (idempotency.state === 'replay') {
      const response = idempotency.record!.response as unknown as WriteGateResult;
      return {
        ...response,
        idempotent_replayed: true,
        platform_response: {
          ...(response.platform_response ?? {}),
          idempotent_replayed: true,
          replayed_from: idempotency.record!.id,
        },
      };
    }
    await this.deps.prisma.idempotencyKey.create({
      data: {
        orgId: 1n,
        scope: 'write',
        key: writeKey,
        requestHash,
        status: 'in_flight',
        responseSnapshot: {},
        expiresAt: new Date(this.now().getTime() + 24 * 3600 * 1000),
        createdBy: ctx.userId,
      },
    });

    // S5 kill switch 权威检 + 限流 + 并发锁
    await this.deps.killSwitch.assertNotBlocked({ platform: req.platform, taskType: meta.taskType });
    if (!this.limiter.check(`${req.platform}:${meta.taskType}`, 120, 60_000, this.now().getTime())) {
      await this.deps.prisma.idempotencyKey.updateMany({
        where: { scope: 'write', key: writeKey, status: 'in_flight' },
        data: { status: 'failed' },
      });
      throw new ApiError('rate_limited', '写入门限流：超过 120 次/分钟');
    }
    const release = this.acquireLock(listing.id, ctx.requestId);
    let workflowRunId: string | null = null;
    try {
      // S6 创建 workflow run 并执行 adapter（M4 dry-run）
      const run = await this.deps.prisma.workflowRun.create({
        data: {
          orgId: 1n,
          type: meta.workflowType,
          state: 'pending',
          stage: 'write',
          subjectType: 'listing',
          subjectId: listing.id,
          idempotencyKey: writeKey,
          attempt: 0,
          maxAttempts: 5,
          payload: {
            action: meta.code,
            platform: req.platform,
            listing_id: listing.id,
            approval_id: approval.id,
            target_hash: targetHash,
            mode,
          } as Prisma.InputJsonValue,
          requestId: ctx.requestId,
          createdBy: ctx.userId,
        },
      });
      workflowRunId = run.id;
      await this.deps.prisma.workflowRun.update({
        where: { id: run.id },
        data: { state: 'running', startedAt: this.now() },
      });

      let preview: PlatformPreview;
      try {
        preview = await this.deps.platform.preview({
          platform: req.platform,
          action: meta.code,
          payload: {
            ...req.payload,
            listing_id: listing.id,
            approval_id: approval.id,
            target_hash: targetHash,
          },
          requestId: ctx.requestId,
          idempotencyKey: writeKey,
        });
      } catch (error) {
        const failure = classifyFailure({
          code: (error as { code?: string }).code,
          httpStatus: (error as { status?: number }).status,
          message: error instanceof Error ? error.message : String(error),
        });
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          failure,
        });
      }

      const writeId = randomUUID();
      const ticketId = randomUUID();
      const responsePayload: Record<string, unknown> = {
        write_id: writeId,
        approval_id: approval.id,
        level,
        idempotent_replayed: false,
        result: 'success',
        platform_response: {
          status: 'dry_run',
          adapter: preview.adapter,
          interface_key: preview.interfaceKey,
          blocked: preview.blocked,
          payload_hash: preview.payloadHash,
          request_preview: preview.requestPreview,
          warnings: preview.warnings,
          todo_ids: preview.todoIds,
          contract_unverified: true,
        },
        snapshot_ref: snapshot.id,
        compensating_ticket_id: isIrreversible(meta) ? ticketId : null,
        workflow_run_id: workflowRunId,
        next_action: null,
        adapter: preview,
      };

      await this.deps.prisma.$transaction(async (tx) => {
        await tx.listingSnapshot.update({
          where: { id: snapshot.id },
          data: { version: { increment: 1 } },
        });
        await tx.listingWriteLog.create({
          data: {
            id: writeId,
            orgId: 1n,
            listingId: listing.id,
            approvalId: approval.id,
            workflowRunId: workflowRunId!,
            level,
            action: meta.approvalAction,
            payloadHash: canonicalHash(req.payload),
            idempotencyKey: writeKey,
            restoredFromSnapshot: false,
            platformResponse: responsePayload.platform_response as Prisma.InputJsonValue,
            occurredAt: this.now(),
            createdBy: ctx.userId,
          },
        });
        if (isIrreversible(meta)) {
          await tx.compensatingTicket.create({
            data: {
              id: ticketId,
              orgId: 1n,
              source: 'irreversible_action',
              relatedApprovalId: approval.id,
              relatedListingId: listing.id,
              platform: req.platform,
              actionTaken: `${meta.code} (${level})`.slice(0, 500),
              status: 'open',
              severity: level === 'C' ? 'high' : 'medium',
              dueAt: new Date(
                this.now().getTime() + (level === 'C' ? 30 * 60 * 1000 : 2 * 3600 * 1000),
              ),
              impact: {
                dry_run: mode === 'dry_run',
                target_hash: targetHash,
                level,
                sku_ids: Array.isArray(req.payload.sku_ids) ? req.payload.sku_ids : [],
                audit_pending: false,
              } as Prisma.InputJsonValue,
              createdBy: ctx.userId,
            },
          });
        }
        await tx.listing.update({
          where: { id: listing.id },
          data: {
            approvalId: approval.id,
            workflowRunId: workflowRunId!,
            ...(mode === 'full'
              ? {
                  status: meta.taskType === 'publish' && req.action !== 'listing.offline' ? 'published' : listing.status,
                  publishedAt: this.now(),
                  lastSyncedAt: this.now(),
                }
              : {}),
          },
        });
        if (level !== 'C' || mode === 'full') {
          await tx.approval.update({
            where: { id: approval.id },
            data: { status: 'executed', executedAt: this.now() },
          });
        }
        await tx.idempotencyKey.updateMany({
          where: { scope: 'write', key: writeKey, status: 'in_flight' },
          data: {
            status: 'succeeded',
            responseSnapshot: responsePayload as Prisma.InputJsonValue,
          },
        });
        await tx.workflowRun.update({
          where: { id: workflowRunId! },
          data: {
            state: 'succeeded',
            stage: 'done',
            finishedAt: this.now(),
            result: {
              write_id: writeId,
              level,
              result: 'success',
              adapter: preview.adapter,
              dry_run: true,
            } as Prisma.InputJsonValue,
          },
        });
      });

      // S8 审计（不可逆动作标记 + 工单 id 在 meta；audit_log 无 ticket 列）
      await this.deps.audit.record({
        action: 'listing.write',
        actorType: 'user',
        actorId: ctx.userId,
        requestId: ctx.requestId,
        resourceType: 'listing',
        resourceId: listing.id,
        before: { status: listing.status, platform_state: listing.platformState },
        after: {
          write_id: writeId,
          level,
          operation_level: level,
          result: 'success',
          adapter: preview.adapter,
          interface_key: preview.interfaceKey,
          dry_run: true,
        },
        irreversible: isIrreversible(meta),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        meta: {
          actor_role: ctx.role,
          approval_id: approval.id,
          target_hash: targetHash,
          snapshot_ref: snapshot.id,
          ticket_id: isIrreversible(meta) ? ticketId : null,
          mode,
          workflow_run_id: workflowRunId,
        },
      });

      return responsePayload as unknown as WriteGateResult;
    } catch (error) {
      const failure: FailureClassification =
        (error as { failure?: FailureClassification }).failure ??
        classifyFailure({
          code: (error as { code?: string }).code,
          httpStatus: (error as { status?: number }).status,
          message: error instanceof Error ? error.message : String(error),
        });
      await this.deps.prisma.idempotencyKey.updateMany({
        where: { scope: 'write', key: writeKey, status: 'in_flight' },
        data: { status: 'failed' },
      });
      if (workflowRunId) {
        await this.deps.prisma.workflowRun.update({
          where: { id: workflowRunId },
          data: {
            state: failure.nextState,
            stage: failure.failureClass,
            errorClass: failure.dbErrorClass,
            errorCode: (error as { code?: string }).code ?? 'unknown',
            errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
            finishedAt: failure.nextState === 'failed_retryable' ? null : this.now(),
            nextRunAt:
              failure.failureClass === 'retryable'
                ? new Date(this.now().getTime() + computeBackoffMs(1))
                : null,
            result: {
              failure_class: failure.failureClass,
              next_action: failure.nextAction,
            } as Prisma.InputJsonValue,
          },
        });
        if (failure.nextState === 'failed_permanent') {
          await this.deps.prisma.workflowDeadLetter.create({
            data: {
              orgId: 1n,
              workflowRunId,
              reason: `${failure.failureClass}:${(error as { code?: string }).code ?? 'unknown'}`,
              payload: {
                action: meta.code,
                platform: req.platform,
                listing_id: listing.id,
                approval_id: approval.id,
                target_hash: targetHash,
                write_key: writeKey,
                error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
              } as Prisma.InputJsonValue,
              replayable:
                (failure.failureClass === 'retryable' || failure.failureClass === 'uncertain') &&
                level !== 'C' &&
                !isIrreversible(meta),
              createdBy: ctx.userId,
            },
          });
        }
      }
      throw error;
    } finally {
      release();
    }
  }

  async execute(req: WriteGateRequest, ctx: WriteGateContext): Promise<WriteGateResult> {
    return this.run(req, ctx);
  }
}
