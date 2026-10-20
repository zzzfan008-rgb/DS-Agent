/** 审计查询：GET /audit（仅 admin，docs/12 §3.11、docs/14 §6.4）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间必须是 ISO8601')
  .transform((value) => new Date(value));

const AuditQuery = z.object({
  actor: z.string().min(1).optional(),
  action: z
    .string()
    .regex(/^[a-z_]+\.[a-z_]+$/, 'action 形如 auth.login')
    .optional(),
  resource_type: z.string().min(1).max(64).optional(),
  resource_id: z.string().uuid().optional(),
  irreversible: z.enum(['true', 'false']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
  with_total: z.enum(['0', '1']).optional(),
});

const CursorShape = z.object({ seq: z.string().regex(/^\d+$/) });

export function registerAuditRoutes(app: FastifyInstance): void {
  app.get('/api/audit', { config: { minRole: 'admin' } }, async (request, reply) => {
    const query = AuditQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);

    let actorId: string | undefined;
    if (query.actor) {
      const isUuid = z.string().uuid().safeParse(query.actor).success;
      if (isUuid) {
        actorId = query.actor;
      } else {
        const user = await app.prisma.user.findFirst({
          where: { email: { equals: query.actor, mode: 'insensitive' }, archivedAt: null },
          select: { id: true },
        });
        if (!user) {
          return ok(request, { items: [] }, { next_cursor: null });
        }
        actorId = user.id;
      }
    }

    const cursorSeq = query.cursor
      ? BigInt(decodeCursor(query.cursor, CursorShape).seq)
      : undefined;

    const result = await app.audit.list({
      ...(actorId === undefined ? {} : { actorId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.resource_type === undefined ? {} : { resourceType: query.resource_type }),
      ...(query.resource_id === undefined ? {} : { resourceId: query.resource_id }),
      ...(query.irreversible === undefined
        ? {}
        : { irreversible: query.irreversible === 'true' }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(cursorSeq === undefined ? {} : { cursorSeq }),
      limit,
      withTotal: query.with_total === '1',
    });

    const nextCursor =
      result.nextCursorSeq === null ? null : encodeCursor({ seq: result.nextCursorSeq });
    if (result.total !== undefined) {
      reply.header('X-Total-Count', String(result.total));
    }
    return ok(request, { items: result.items }, { next_cursor: nextCursor });
  });
}
