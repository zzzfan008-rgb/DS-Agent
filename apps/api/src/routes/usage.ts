/** 用量与成本：GET /usage（docs/07 §12.1；数据源 model_call_log，不落新表）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok } from '../lib/response.js';
import { ApiError } from '../lib/errors.js';
import { principalFromRequest } from '../lib/principal.js';

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间必须是 ISO8601')
  .transform((value) => new Date(value));

const UsageQuery = z.object({
  from: isoDate,
  to: isoDate,
  group_by: z.enum(['model', 'purpose', 'day']).default('model'),
});

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get('/api/usage', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const query = UsageQuery.parse(request.query ?? {});
    if (query.to < query.from) {
      throw new ApiError('validation_failed', 'to 必须晚于 from', { detail: { field: 'to' } });
    }

    const rows = await app.prisma.modelCallLog.findMany({
      where: {
        orgId: BigInt(principal.orgId),
        startedAt: { gte: query.from, lte: query.to },
      },
      select: {
        purpose: true,
        modelId: true,
        costCents: true,
        inputTokens: true,
        outputTokens: true,
        imageCount: true,
        videoSeconds: true,
        startedAt: true,
      },
    });

    const groups = new Map<
      string,
      {
        key: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        images: number;
        video_seconds: number;
        cost_cents: number;
      }
    >();
    for (const row of rows) {
      const key =
        query.group_by === 'model'
          ? row.modelId
          : query.group_by === 'purpose'
            ? row.purpose
            : row.startedAt.toISOString().slice(0, 10);
      const group = groups.get(key) ?? {
        key,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        images: 0,
        video_seconds: 0,
        cost_cents: 0,
      };
      group.calls += 1;
      group.input_tokens += row.inputTokens;
      group.output_tokens += row.outputTokens;
      group.images += row.imageCount;
      group.video_seconds += Number(row.videoSeconds);
      group.cost_cents += row.costCents;
      groups.set(key, group);
    }

    const items = [...groups.values()]
      .map((group) => ({
        ...group,
        video_seconds: Math.round(group.video_seconds * 1000) / 1000,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return ok(request, {
      items,
      total_cents: items.reduce((sum, item) => sum + item.cost_cents, 0),
      group_by: query.group_by,
      from: query.from.toISOString(),
      to: query.to.toISOString(),
    });
  });
}
