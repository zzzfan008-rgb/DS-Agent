/** 健康检查：GET /health（公开，内网；docs/12 §3.11、docs/16 §7）。 */
import type { FastifyInstance } from 'fastify';
import { bundleDescriptor } from '../agent/bundle.js';
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

    // DSH Host 探针：带缓存（默认 2s），Host 挂时只影响 dsh_host 字段，不影响读路径。
    const host = await app.agentBridge.health();
    const bundle = bundleDescriptor();
    const agentStats = app.agentRuns.stats();
    const checks = {
      db: dbOk ? 'ok' : 'down',
      // M1 未接 Redis/MinIO：显式标 not_configured，不伪装成 ok。
      redis: 'not_configured',
      minio: 'not_configured',
      dsh_host: host.status === 'ok' ? 'ok' : 'down',
      dsh_host_detail: {
        bridge_url: app.config.dshBridgeUrl,
        token_source: app.agentBridge.tokenSource,
        version: host.version,
        preset: host.preset,
        manifest_hash: host.manifest_hash,
        local_manifest_hash: bundle.manifestHash,
        manifest_match:
          host.manifest_hash !== null && bundle.verified
            ? host.manifest_hash === bundle.manifestHash
            : null,
        mcp_tools: host.mcp_tools,
        latency_ms: host.latency_ms,
        error: host.error,
      },
      agent: {
        active: agentStats.active,
        queued: agentStats.queued,
        runs_retained: agentStats.runs,
        max_concurrency: app.config.agentMaxConcurrency,
        queue_limit: app.config.agentQueueLimit,
      },
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
