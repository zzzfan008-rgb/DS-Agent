/** 工作流运维路由：run 查询、死信、重放（docs/11 §4.5、docs/12 §3.8）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getActionMeta } from '../write-gate/actions.js';
import { validateReplayPreconditions, type FailureClass, type WorkflowState } from '../write-gate/workflow.js';
import { getWriteGateServices } from '../write-gate/services.js';

const ReplayBody = z.object({
  reason: z.string().min(10).max(2000),
  reconciled: z.boolean(),
  reconcile_note: z.string().min(1).max(2000),
  repair_hints_closed: z.boolean().optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance): void {
  const { killSwitch } = getWriteGateServices(app);

  app.get('/api/workflow/runs', { config: { minRole: 'viewer' } }, async (request) => {
    const query = z
      .object({
        state: z.string().optional(),
        type: z.string().optional(),
        subject_id: z.string().uuid().optional(),
        cursor: z.string().min(1).optional(),
        limit: z.string().optional(),
      })
      .parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const rows = await app.prisma.workflowRun.findMany({
      where: {
        orgId: 1n,
        archivedAt: null,
        ...(query.state ? { state: query.state } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.subject_id ? { subjectId: query.subject_id } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return ok(
      request,
      {
        items: page.map((row) => ({
          id: row.id,
          type: row.type,
          state: row.state,
          stage: row.stage,
          subject_type: row.subjectType,
          subject_id: row.subjectId,
          attempt: row.attempt,
          max_attempts: row.maxAttempts,
          error_class: row.errorClass,
          error_code: row.errorCode,
          parent_run_id: row.parentRunId,
          created_at: row.createdAt.toISOString(),
          finished_at: row.finishedAt?.toISOString() ?? null,
        })),
      },
      { next_cursor: rows.length > limit ? page[page.length - 1]!.id : null },
    );
  });

  app.get('/api/workflow/runs/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await app.prisma.workflowRun.findFirst({
      where: { id: params.id, orgId: 1n, archivedAt: null },
    });
    if (!row) throw new ApiError('not_found', 'workflow run 不存在');
    return ok(request, row);
  });

  app.get('/api/workflow/dead-letters', { config: { minRole: 'admin' } }, async (request) => {
    const query = z.object({ cursor: z.string().min(1).optional(), limit: z.string().optional() }).parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const rows = await app.prisma.workflowDeadLetter.findMany({
      where: { orgId: 1n, archivedAt: null, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return ok(
      request,
      { items: page },
      { next_cursor: rows.length > limit ? page[page.length - 1]!.id : null },
    );
  });

  app.post('/api/workflow/runs/:id/replay', { config: { minRole: 'admin' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ReplayBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const run = await app.prisma.workflowRun.findFirst({
      where: { id: params.id, orgId: 1n, archivedAt: null },
    });
    if (!run) throw new ApiError('not_found', 'workflow run 不存在');
    const deadLetter = await app.prisma.workflowDeadLetter.findFirst({
      where: { workflowRunId: run.id, orgId: 1n, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!deadLetter) throw new ApiError('conflict', '该 run 没有死信，不能重放');
    const payload = (run.payload ?? {}) as Record<string, unknown>;
    const approvalId = typeof payload.approval_id === 'string' ? payload.approval_id : null;
    const approval = approvalId
      ? await app.prisma.approval.findFirst({ where: { id: approvalId, archivedAt: null } })
      : null;
    const actionCode = typeof payload.action === 'string' ? payload.action : null;
    const meta = actionCode ? getActionMeta(actionCode) : null;
    const currentTargetHash = typeof payload.target_hash === 'string' ? payload.target_hash : null;

    const killHit = meta
      ? await killSwitch.check({
          platform: (payload.platform as 'pdd' | '1688') ?? 'pdd',
          taskType: meta.taskType,
        })
      : null;
    const idempotency = await app.prisma.idempotencyKey.findFirst({
      where: { orgId: 1n, scope: 'write', key: run.idempotencyKey, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const result = (run.result ?? {}) as Record<string, unknown>;
    const validation = validateReplayPreconditions({
      runState: run.state as WorkflowState,
      failureClass: (result.failure_class as FailureClass | undefined) ?? (run.errorClass as FailureClass | undefined) ?? null,
      repairHintsClosed: body.repair_hints_closed ?? false,
      killSwitchBlocked: killHit !== null,
      approvalStatus: approval?.status ?? null,
      approvalExpiresAt: approval?.expiresAt ?? null,
      approvalTargetHash: approval?.targetHash ?? null,
      currentTargetHash,
      reconciled: body.reconciled,
      reconcileNote: body.reconcile_note ?? null,
      idempotencyStatus: idempotency?.status ?? null,
      actorRole: context.role,
      replayReason: body.reason,
      level: approval?.operationLevel ?? null,
      irreversibleSideEffect: approval?.operationLevel === 'C',
      alreadyReplayed: deadLetter.replayedAt !== null,
    });
    if (!validation.ok) {
      throw new ApiError('conflict', '重放前置条件不满足', {
        detail: { issues: validation.issues },
      });
    }
    const newIdempotencyKey = sha256Hex(`${run.idempotencyKey}|replay|${randomUUID()}`);
    const newRun = await app.prisma.workflowRun.create({
      data: {
        orgId: 1n,
        type: run.type,
        state: 'pending',
        stage: run.stage,
        subjectType: run.subjectType,
        subjectId: run.subjectId,
        idempotencyKey: newIdempotencyKey,
        attempt: 0,
        maxAttempts: run.maxAttempts,
        parentRunId: run.id,
        payload: { ...payload, replay_of: run.id, replay_reason: body.reason } as never,
        requestId: context.requestId,
        createdBy: context.userId,
      },
    });
    await app.prisma.workflowDeadLetter.update({
      where: { id: deadLetter.id },
      data: { replayedAt: new Date(), createdBy: context.userId },
    });
    await app.audit.record({
      action: 'workflow.replay',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'workflow_run',
      resourceId: run.id,
      before: { state: run.state },
      after: { new_run_id: newRun.id, reason: body.reason, reconcile_note: body.reconcile_note },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, dead_letter_id: deadLetter.id },
    });
    request.auditLogged = true;
    return ok(request, {
      old_run_id: run.id,
      new_run_id: newRun.id,
      state: newRun.state,
      attempt_seq: 0,
    });
  });
}
