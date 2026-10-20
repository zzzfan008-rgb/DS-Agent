/** 健康检查：GET /health（公开，内网；docs/12 §3.11）。 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/response.js';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', { config: { public: true, audit: false } }, async (request, reply) => {
    let dbOk = true;
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const checks = {
      db: dbOk ? 'ok' : 'down',
      // M1 未接 Redis/MinIO/DSH Host：显式标 not_configured，不伪装成 ok。
      redis: 'not_configured',
      minio: 'not_configured',
      dsh_host: 'not_configured',
      platforms: [] as Array<{ platform: string; status: string }>,
    };
    const status = dbOk ? 'ok' : 'down';
    if (!dbOk) reply.code(503);
    return ok(request, {
      status,
      checks,
      version: app.config.version,
      build: app.config.buildSha,
      uptime_s: Math.round(process.uptime()),
    });
  });
}
