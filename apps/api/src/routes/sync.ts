/**
 * 同步端点 —— docs/12 §3.9（`POST /sync/:platform`、`GET /sync/status`）。
 *
 * `sync_reader=recorded` 时用录制样本验证"游标推进 + 断点续跑"；
 * `sync_reader=adapter` 时真实 reader 未核验，返回 `publish_blocked`（409）并给 TODO 列表。
 * 真实落库的资源（`dry_run=false`）：
 * - t43 `orders` → `orders` + `order_items`，幂等 `(platform, platform_order_id)`；
 * - t49 `after_sale` → `after_sale`，幂等 `(platform, platform_after_sale_id)`；
 *   本地缺订单时无法落库（`order_id` NOT NULL + FK RESTRICT），计入 `stats.pending` 并保留给对账报出。
 * 其余资源（products/messages/stock）仍只推进游标（`dry_run=true`）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { PrismaSyncCursorStore } from '../sync/cursor-store.js';
import { createSyncReaders } from '../sync/readers.js';
import { PrismaOrderSink } from '../sync/order-sink.js';
import { PrismaAfterSaleSink } from '../sync/after-sale-sink.js';
import { SyncService } from '../sync/service.js';
import { SYNC_RESOURCES } from '../sync/types.js';

const PlatformParams = z.object({ platform: z.enum(['pdd', '1688']) });
const SyncBody = z
  .object({
    resource: z.enum(SYNC_RESOURCES),
    since: z.string().min(1).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
const StatusQuery = z.object({ platform: z.enum(['pdd', '1688']).optional() });

export function registerSyncRoutes(app: FastifyInstance): void {
  const store = new PrismaSyncCursorStore(app.prisma);
  const readers = createSyncReaders(app.config.syncReader);
  const service = new SyncService({
    store,
    readers,
    // t43：orders 真实落库（orders + order_items）；t49：after_sale 真实落库。
    sinks: {
      orders: new PrismaOrderSink(app.prisma),
      after_sale: new PrismaAfterSaleSink(app.prisma),
    },
  });

  app.post('/api/sync/:platform', { config: { minRole: 'operator' } }, async (request, reply) => {
    const { platform } = PlatformParams.parse(request.params);
    const body = SyncBody.parse(request.body ?? {});
    const context = serviceContext(request);
    const result = await service.run(platform, body.resource, {
      since: body.since ?? null,
      cursor: body.cursor ?? null,
      owner: `api:${context.userId}`,
    });
    await app.audit.record({
      action: 'sync.run',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'platform',
      resourceId: null,
      before: {},
      after: {
        sync_id: result.sync_id,
        platform,
        resource: body.resource,
        source: result.source,
        pages: result.pages,
        pulled: result.stats.pulled,
        created: result.stats.created,
        updated: result.stats.updated,
        skipped: result.stats.skipped,
        pending: result.stats.pending ?? 0,
        pending_reasons: result.stats.pending_reasons ?? {},
        cursor: result.cursor,
        resumed_from: result.resumed_from,
      },
      meta: { platform, resource: body.resource, reader: app.config.syncReader, dry_run: result.dry_run },
    });
    request.auditLogged = true;
    reply.code(202);
    return ok(request, {
      sync_id: result.sync_id,
      started_at: result.started_at,
      accepted: true,
      platform: result.platform,
      resource: result.resource,
      dry_run: result.dry_run,
      source: result.source,
      pages: result.pages,
      stats: result.stats,
      resumed_from: result.resumed_from,
      cursor: result.cursor,
      finished_at: result.finished_at,
    });
  });

  app.get('/api/sync/status', { config: { minRole: 'viewer' } }, async (request) => {
    const query = StatusQuery.parse(request.query ?? {});
    const status = await service.status(query.platform, app.config.syncStaleSeconds);
    return ok(request, status);
  });
}
