/** kill switch 与补偿工单（docs/11 §8–§9、docs/12 §3.12）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { getWriteGateServices } from '../write-gate/services.js';

const KillSwitchCreate = z.object({
  scope_type: z.enum(['global', 'platform', 'category', 'task_type']),
  scope_key: z.string().min(1).max(64),
  action: z.enum(['block_writes', 'block_replies', 'block_media', 'block_model', 'readonly']),
  mode: z.enum(['block', 'drain']).default('block'),
  reason: z.string().min(3).max(500),
  expires_at: z.string().nullable().optional(),
  drill: z.boolean().optional(),
});

const DisableBody = z.object({ reason: z.string().min(3).max(500), confirm: z.boolean() });

const TicketResolve = z.object({
  resolution: z.string().min(10).max(2000),
  verified_by: z.string().uuid().optional(),
  evidence_refs: z.array(z.string().min(1)).max(20).optional(),
});

export function registerGovernanceRoutes(app: FastifyInstance): void {
  const { killSwitch } = getWriteGateServices(app);

  app.get('/api/kill-switch', { config: { minRole: 'viewer' } }, async (request) => {
    const rows = await killSwitch.list();
    return ok(request, {
      items: rows.map((row) => ({
        id: row.id,
        scope_type: row.scopeType,
        scope_key: row.scopeKey,
        action: row.action,
        mode: row.mode,
        enabled: row.enabled,
        reason: row.reason,
        enabled_at: row.enabledAt.toISOString(),
        expires_at: row.expiresAt?.toISOString() ?? null,
        drill: row.drill,
      })),
    });
  });

  app.post('/api/kill-switch', { config: { minRole: 'admin' } }, async (request, reply) => {
    const body = KillSwitchCreate.parse(request.body ?? {});
    const context = serviceContext(request);
    const row = await killSwitch.create(
      {
        scopeType: body.scope_type,
        scopeKey: body.scope_key,
        action: body.action,
        mode: body.mode,
        reason: body.reason,
        expiresAt: body.expires_at ?? null,
        drill: body.drill ?? false,
      },
      context,
    );
    request.auditLogged = true;
    reply.code(201);
    return ok(request, {
      id: row.id,
      scope_type: row.scopeType,
      scope_key: row.scopeKey,
      mode: row.mode,
      enabled: row.enabled,
    });
  });

  app.post('/api/kill-switch/:id/disable', { config: { minRole: 'admin' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = DisableBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const row = await killSwitch.disable(params.id, body, context);
    request.auditLogged = true;
    return ok(request, { id: row.id, enabled: row.enabled, disabled_at: row.disabledAt?.toISOString() ?? null });
  });

  app.get('/api/compensating-tickets', { config: { minRole: 'viewer' } }, async (request) => {
    const query = z
      .object({
        status: z.string().optional(),
        level: z.string().optional(),
        platform: z.enum(['pdd', '1688']).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.string().optional(),
      })
      .parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const rows = await app.prisma.compensatingTicket.findMany({
      where: {
        orgId: 1n,
        archivedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.platform ? { platform: query.platform } : {}),
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
          source: row.source,
          related_approval_id: row.relatedApprovalId,
          related_listing_id: row.relatedListingId,
          platform: row.platform,
          action_taken: row.actionTaken,
          status: row.status,
          severity: row.severity,
          owner_user_id: row.ownerUserId,
          due_at: row.dueAt?.toISOString() ?? null,
          impact: row.impact,
          created_at: row.createdAt.toISOString(),
          resolved_at: row.resolvedAt?.toISOString() ?? null,
        })),
      },
      { next_cursor: rows.length > limit ? page[page.length - 1]!.id : null },
    );
  });

  app.post('/api/compensating-tickets/:id/claim', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = serviceContext(request);
    const ticket = await app.prisma.compensatingTicket.findFirst({ where: { id: params.id, archivedAt: null } });
    if (!ticket) throw new ApiError('not_found', '工单不存在');
    if (!['open', 'escalated'].includes(ticket.status)) {
      throw new ApiError('conflict', '工单当前状态不可认领', { detail: { status: ticket.status } });
    }
    const updated = await app.prisma.compensatingTicket.update({
      where: { id: params.id },
      data: { status: 'in_progress', ownerUserId: context.userId },
    });
    await app.audit.record({
      action: 'ticket.claim',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'compensating_ticket',
      resourceId: params.id,
      before: { status: ticket.status },
      after: { status: updated.status },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role },
    });
    request.auditLogged = true;
    return ok(request, { id: updated.id, status: updated.status, owner_user_id: updated.ownerUserId });
  });

  app.post('/api/compensating-tickets/:id/resolve', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = TicketResolve.parse(request.body ?? {});
    const context = serviceContext(request);
    const ticket = await app.prisma.compensatingTicket.findFirst({ where: { id: params.id, archivedAt: null } });
    if (!ticket) throw new ApiError('not_found', '工单不存在');
    if (['resolved', 'wontfix'].includes(ticket.status)) {
      throw new ApiError('conflict', '工单已关闭', { detail: { status: ticket.status } });
    }
    if ((ticket.impact as Record<string, unknown>)?.dry_run === true && context.role !== 'admin') {
      throw new ApiError('forbidden', 'dry-run 工单关闭需要 admin 复核');
    }
    const updated = await app.prisma.compensatingTicket.update({
      where: { id: params.id },
      data: {
        status: 'resolved',
        resolution: body.resolution,
        resolvedAt: new Date(),
        ownerUserId: ticket.ownerUserId ?? context.userId,
        impact: {
          ...(ticket.impact as Record<string, unknown>),
          verified_by: body.verified_by ?? context.userId,
          evidence_refs: body.evidence_refs ?? [],
        },
      },
    });
    await app.audit.record({
      action: 'ticket.resolve',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'compensating_ticket',
      resourceId: params.id,
      before: { status: ticket.status },
      after: { status: updated.status, resolution: body.resolution },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role },
    });
    request.auditLogged = true;
    return ok(request, { id: updated.id, status: updated.status, resolved_at: updated.resolvedAt?.toISOString() ?? null });
  });

  app.post('/api/compensating-tickets/:id/waive', { config: { minRole: 'admin' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().min(10).max(2000) }).parse(request.body ?? {});
    const context = serviceContext(request);
    const ticket = await app.prisma.compensatingTicket.findFirst({ where: { id: params.id, archivedAt: null } });
    if (!ticket) throw new ApiError('not_found', '工单不存在');
    const updated = await app.prisma.compensatingTicket.update({
      where: { id: params.id },
      data: {
        status: 'wontfix',
        resolution: `WAIVED: ${body.reason}`,
        resolvedAt: new Date(),
      },
    });
    await app.audit.record({
      action: 'ticket.waive',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'compensating_ticket',
      resourceId: params.id,
      after: { status: updated.status, reason: body.reason },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role },
    });
    request.auditLogged = true;
    return ok(request, { id: updated.id, status: updated.status });
  });
}
