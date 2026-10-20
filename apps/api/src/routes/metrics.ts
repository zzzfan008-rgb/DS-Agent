/** Prometheus 指标：GET /metrics（admin 会话或 METRICS_TOKEN，docs/12 §3.11）。 */
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../lib/errors.js';

export function registerMetricsRoutes(app: FastifyInstance): void {
  app.get('/api/metrics', { config: { public: true, audit: false } }, async (request, reply) => {
    const authorization = request.headers.authorization;
    const bearer =
      typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : null;
    const tokenOk =
      app.config.metricsToken !== null && bearer !== null && bearer === app.config.metricsToken;
    const adminOk = request.auth?.role === 'admin';

    if (!adminOk && !tokenOk) {
      if (!request.auth) throw new ApiError('unauthorized', '未登录或会话已过期');
      throw new ApiError('forbidden', '需要 admin 或 metrics token');
    }

    app.metricsRegistry.set('dssaas_up', 'API 进程存活', {}, 1);
    app.metricsRegistry.set(
      'dssaas_process_uptime_seconds',
      'API 进程运行秒数',
      {},
      Math.round(process.uptime()),
    );
    app.metricsRegistry.set('dssaas_build_info', '构建信息', {
      version: app.config.version,
      commit: app.config.buildSha ?? 'unknown',
    });

    reply.type('text/plain; charset=utf-8');
    return app.metricsRegistry.render();
  });
}
