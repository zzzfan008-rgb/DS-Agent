/** 上架/写入门路由（docs/12 §3.6）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canonicalHash } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { assertReversible, computeLevel, getActionMeta } from '../write-gate/actions.js';
import { getWriteGateServices } from '../write-gate/services.js';

/** C 级执行时机建议：低峰窗口（Asia/Shanghai 02:00–06:00），避开活动/客服高峰。 */
function cTimingAdvice(now: Date = new Date()) {
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const year = cn.getUTCFullYear();
  const month = cn.getUTCMonth();
  const day = cn.getUTCDate();
  let startUtc = Date.UTC(year, month, day, 2, 0, 0) - 8 * 3600 * 1000;
  if (startUtc <= now.getTime()) startUtc += 24 * 3600 * 1000;
  return {
    level: 'C',
    timezone: 'Asia/Shanghai',
    suggested_window: {
      start: new Date(startUtc).toISOString(),
      end: new Date(startUtc + 4 * 3600 * 1000).toISOString(),
    },
    avoid: ['activity_period', 'customer_service_peak', 'traffic_peak'],
    note: 'C 级不可回滚：建议低峰窗口执行，执行前复核平台现值与活动状态；执行后立即核对并启动止损预案。',
  };
}

const PublishBody = z.object({
  product_id: z.string().uuid(),
  platform: z.enum(['pdd', '1688']),
  sku_ids: z.array(z.string().uuid()).max(200).default([]),
  approval_id: z.string().uuid().optional(),
  mode: z.enum(['dry_run', 'canary', 'full']).default('dry_run'),
  media_plan: z.record(z.string(), z.unknown()).optional(),
  scheduled_at: z.string().nullable().optional(),
});

const GenericWriteBody = z.object({
  action: z.string().min(1),
  platform: z.enum(['pdd', '1688']),
  listing_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  approval_id: z.string().uuid().optional(),
  confirm_token: z.string().optional(),
  mode: z.enum(['dry_run', 'canary', 'full']).default('dry_run'),
  expected_current_hash: z.string().length(64).optional(),
});

const RollbackBody = z
  .object({
    platform: z.enum(['pdd', '1688']),
    listing_id: z.string().uuid(),
    write_id: z.string().uuid(),
    expected_current_hash: z.string().length(64),
    reason: z.string().min(10).max(1000),
  })
  .strict();

const ConfirmBody = z.object({
  action: z.string().min(1),
  target_hash: z.string().length(64),
});

const StopLossBody = z.object({
  platform: z.enum(['pdd', '1688']),
  listing_id: z.string().uuid(),
  action: z.enum(['offline', 'exit_activity', 'update_stock', 'compensate_message', 'create_ticket']),
  reason: z.string().min(3).max(1000),
  approval_id: z.string().uuid().optional(),
  confirm_token: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const BatchBody = z.object({
  platform: z.enum(['pdd', '1688']),
  action: z.enum(['offline', 'price', 'stock', 'publish']),
  items: z.array(z.object({ listing_id: z.string().uuid(), fields: z.record(z.string(), z.unknown()).optional() })).min(1).max(50),
  approval_id: z.string().uuid(),
  mode: z.enum(['dry_run', 'full']).default('dry_run'),
});

export function registerListingRoutes(app: FastifyInstance): void {
  const services = getWriteGateServices(app);

  app.get('/api/listings', { config: { minRole: 'viewer' } }, async (request) => {
    const query = z
      .object({
        platform: z.enum(['pdd', '1688']).optional(),
        status: z.string().min(1).optional(),
        product_id: z.string().uuid().optional(),
        cursor: z.string().min(1).optional(),
        limit: z.string().optional(),
      })
      .parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const rows = await app.prisma.listing.findMany({
      where: {
        orgId: 1n,
        archivedAt: null,
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.product_id ? { productId: query.product_id } : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    return ok(
      request,
      {
        items: page.map((row) => ({
          id: row.id,
          platform: row.platform,
          product_id: row.productId,
          status: row.status,
          platform_state: row.platformState,
          platform_item_id: row.platformItemId,
          price_cents: null,
          main_image_id: row.mainImageId,
          last_write_at: row.lastSyncedAt?.toISOString() ?? null,
          pending_run_id: row.workflowRunId,
        })),
      },
      { next_cursor: rows.length > limit ? page[page.length - 1]!.id : null },
    );
  });

  app.get('/api/listings/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const include = z
      .object({ include: z.string().optional() })
      .parse(request.query ?? {});
    const listing = await app.prisma.listing.findFirst({
      where: { id: params.id, orgId: 1n, archivedAt: null },
    });
    if (!listing) throw new ApiError('not_found', 'listing 不存在');
    const wants = new Set((include.include ?? '').split(',').map((item) => item.trim()).filter(Boolean));
    const [writes, snapshots, approvals] = await Promise.all([
      wants.has('writes')
        ? app.prisma.listingWriteLog.findMany({
            where: { listingId: listing.id, archivedAt: null },
            orderBy: { occurredAt: 'desc' },
            take: 50,
          })
        : Promise.resolve([]),
      wants.has('snapshot')
        ? app.prisma.listingSnapshot.findMany({
            where: { listingId: listing.id, archivedAt: null },
            orderBy: { capturedAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
      wants.has('approvals')
        ? app.prisma.approval.findMany({
            where: { subjectType: 'listing', subjectId: listing.id, archivedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 20,
          })
        : Promise.resolve([]),
    ]);
    return ok(request, {
      listing: {
        id: listing.id,
        platform: listing.platform,
        product_id: listing.productId,
        status: listing.status,
        platform_state: listing.platformState,
        platform_item_id: listing.platformItemId,
        title: listing.title,
        main_image_id: listing.mainImageId,
        published_snapshot: listing.publishedSnapshot,
        approval_id: listing.approvalId,
        workflow_run_id: listing.workflowRunId,
        version: listing.version,
      },
      write_log: writes,
      snapshots: snapshots.map((row) => ({
        id: row.id,
        snapshot_hash: row.snapshotHash,
        captured_at: row.capturedAt.toISOString(),
        source: row.source,
      })),
      approvals: approvals.map((row) => ({
        id: row.id,
        action: row.action,
        level: row.operationLevel,
        status: row.status,
        target_hash: row.targetHash,
      })),
    });
  });

  app.post('/api/listings/publish', { config: { minRole: 'operator' } }, async (request) => {
    const body = PublishBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const product = await app.prisma.product.findFirst({
      where: { id: body.product_id, archivedAt: null },
      select: { name: true },
    });
    if (!product) throw new ApiError('not_found', '商品不存在');
    const result = await services.gate.execute(
      {
        action: 'listing.create',
        platform: body.platform,
        product_id: body.product_id,
        approval_id: body.approval_id,
        mode: body.mode,
        payload: {
          sku_ids: body.sku_ids,
          media_plan: body.media_plan ?? {},
          title: product.name,
        },
      },
      context,
    );
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post('/api/listings/write', { config: { minRole: 'operator' } }, async (request) => {
    const body = GenericWriteBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const result = await services.gate.execute(
      {
        action: body.action,
        platform: body.platform,
        ...(body.listing_id === undefined ? {} : { listing_id: body.listing_id }),
        ...(body.product_id === undefined ? {} : { product_id: body.product_id }),
        payload: body.payload,
        ...(body.approval_id === undefined ? {} : { approval_id: body.approval_id }),
        ...(body.confirm_token === undefined ? {} : { confirm_token: body.confirm_token }),
        mode: body.mode,
        ...(body.expected_current_hash === undefined
          ? {}
          : { expected_current_hash: body.expected_current_hash }),
      },
      context,
    );
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post('/api/listings/rollback', { config: { minRole: 'operator' } }, async (request) => {
    const body = RollbackBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const write = await app.prisma.listingWriteLog.findFirst({
      where: { id: body.write_id, listingId: body.listing_id, orgId: 1n, archivedAt: null },
    });
    if (!write) throw new ApiError('not_found', '写记录不存在');
    if (write.level !== 'A') {
      await app.audit.record({
        action: 'listing.rollback_rejected',
        actorType: 'user',
        actorId: context.userId,
        requestId: context.requestId,
        resourceType: 'listing',
        resourceId: body.listing_id,
        after: {
          write_id: write.id,
          action: write.action,
          level: write.level,
          operation_level: write.level,
          reason: body.reason,
        },
        irreversible: true,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { actor_role: context.role, guard: 'pseudo_rollback_forbidden', level: write.level },
      });
      request.auditLogged = true;
      throw new ApiError('irreversible', `写记录级别 ${write.level} 不可回滚，只能止损/建补偿工单`, {
        detail: { next_action: 'create_compensation', write_id: write.id, level: write.level },
      });
    }
    try {
      assertReversible(write.action);
    } catch (error) {
      await app.audit.record({
        action: 'listing.rollback_rejected',
        actorType: 'user',
        actorId: context.userId,
        requestId: context.requestId,
        resourceType: 'listing',
        resourceId: body.listing_id,
        after: {
          write_id: write.id,
          action: write.action,
          level: write.level,
          operation_level: write.level,
          reason: body.reason,
        },
        irreversible: true,
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { actor_role: context.role, guard: 'pseudo_rollback_forbidden', level: write.level },
      });
      request.auditLogged = true;
      throw error;
    }
    // A 级覆盖写回：本任务只开放“验证入口”，真写入仍需走 restore_snapshot 的完整 S1–S9。
    const currentHash = canonicalHash({
      listing_id: body.listing_id,
      expected_current_hash: body.expected_current_hash,
    });
    if (!currentHash) throw new ApiError('conflict', 'A 级回滚校验失败');
    throw new ApiError('conflict', 'A 级回滚需走 restore_snapshot 审批链路（M4 暂未开放写回）', {
      detail: { write_id: write.id, expected_current_hash: body.expected_current_hash },
    });
  });

  app.post('/api/listings/:id/confirm-token', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ConfirmBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const meta = getActionMeta(body.action);
    // 绑定本 listing 最近一条已批准、target_hash 匹配的 C 级审批。
    const approval = await app.prisma.approval.findFirst({
      where: {
        orgId: 1n,
        subjectType: 'listing',
        subjectId: params.id,
        action: meta.approvalAction,
        targetHash: body.target_hash,
        operationLevel: 'C',
        status: { in: ['approved', 'approved_with_edit', 'scheduled'] },
        archivedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) throw new ApiError('conflict', '没有匹配的已批准 C 级审批');
    if (approval.decidedBy === context.userId) {
      throw new ApiError('forbidden', '四眼原则：执行人不能是审批人');
    }
    const token = services.confirmTokens.issue({
      approvalId: approval.id,
      userId: context.userId,
      action: meta.code,
      targetHash: body.target_hash,
    });
    request.auditLogged = true;
    return ok(request, {
      confirm_token: token.token,
      expires_at: token.expiresAt.toISOString(),
      level: approval.operationLevel,
      approval_id: approval.id,
      timing_advice: cTimingAdvice(),
    });
  });

  app.post('/api/listings/stop-loss', { config: { minRole: 'operator' } }, async (request) => {
    const body = StopLossBody.parse(request.body ?? {});
    const context = serviceContext(request);
    if (body.action === 'create_ticket') {
      const ticket = await app.prisma.compensatingTicket.create({
        data: {
          orgId: 1n,
          source: 'manual',
          relatedListingId: body.listing_id,
          platform: body.platform,
          actionTaken: `manual stop-loss: ${body.reason}`.slice(0, 500),
          status: 'open',
          severity: 'high',
          impact: { reason: body.reason },
          createdBy: context.userId,
        },
      });
      await app.audit.record({
        action: 'ticket.create',
        actorType: 'user',
        actorId: context.userId,
        requestId: context.requestId,
        resourceType: 'compensating_ticket',
        resourceId: ticket.id,
        after: { reason: body.reason, listing_id: body.listing_id, platform: body.platform },
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { actor_role: context.role },
      });
      request.auditLogged = true;
      return ok(request, {
        ticket_id: ticket.id,
        run_id: null,
        platform_confirmed: false,
        next_action: 'assign_and_mitigate',
      });
    }
    const actionMap = {
      offline: 'listing.offline',
      update_stock: 'listing.update_stock',
      compensate_message: 'message.send',
      exit_activity: 'listing.stop_loss',
    } as const;
    const result = await services.gate.execute(
      {
        action: actionMap[body.action],
        platform: body.platform,
        listing_id: body.listing_id,
        payload: {
          reason: body.reason,
          ...(body.payload ?? {}),
        },
        ...(body.approval_id === undefined ? {} : { approval_id: body.approval_id }),
        ...(body.confirm_token === undefined ? {} : { confirm_token: body.confirm_token }),
        mode: 'dry_run',
      },
      context,
    );
    request.auditLogged = true;
    return ok(request, {
      ticket_id: result.compensating_ticket_id,
      run_id: result.workflow_run_id,
      platform_confirmed: false,
      next_action: result.next_action ?? 'verify_stop_loss',
      write: result,
    });
  });

  app.post('/api/listings/batch', { config: { minRole: 'operator' } }, async (request) => {
    const body = BatchBody.parse(request.body ?? {});
    const actionCode =
      body.action === 'offline'
        ? 'listing.batch_offline'
        : body.action === 'price'
          ? 'listing.batch_price'
          : body.action === 'stock'
            ? 'listing.update_stock'
            : 'listing.create';
    const levels = body.items.map((item) =>
      computeLevel(actionCode, {
        listingStatus: item.fields?.listing_status ? String(item.fields.listing_status) : null,
        affectedSkus: 1,
      }).level,
    );
    const unique = [...new Set(levels)];
    if (unique.length > 1) {
      throw new ApiError('validation_failed', '批量项目级别不一致，禁止混批，请拆单', {
        detail: { levels },
      });
    }
    const level = unique[0]!;
    if (level === 'C' && body.items.length > 10) {
      throw new ApiError('irreversible', 'C 级批量最多 10 项，且需逐项确认', {
        detail: { count: body.items.length },
      });
    }
    if (level === 'C' && body.mode !== 'dry_run') {
      throw new ApiError('irreversible', 'C 级批量执行需逐项 confirm_token，M4 暂只开放 dry_run', {
        detail: { next_action: 'split_batch' },
      });
    }
    const batchId = body.approval_id;
    return ok(request, {
      batch_id: batchId,
      accepted: body.items.map((item) => item.listing_id),
      rejected: [],
      run_ids: [],
      level,
      mode: body.mode,
      executed: false,
      note: 'M4 批量只做级别/混批校验与 dry-run 计划；逐项写待 M5',
    });
  });
}
