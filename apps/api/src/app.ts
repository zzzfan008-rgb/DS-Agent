/**
 * Fastify 应用装配（t2 API 骨架）。
 *
 * 装配顺序（也是钩子执行顺序）：
 *   cookie → request context → auth gate → idempotency → 路由 → onSend 安全头
 *   → onResponse（通用审计 → 指标）→ errorHandler。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { getPrisma, disconnectPrisma, type PrismaClient } from '@dssaas/db';
import type { AppConfig } from './config.js';
import { normalizeRequestId } from './lib/ids.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import { registerAuthGate } from './plugins/auth.js';
import { MemoryIdempotencyStore, registerIdempotency } from './plugins/idempotency.js';
import { AuditService } from './services/audit.js';
import { AuthService } from './services/identity.js';
import { LoginRateLimiter } from './services/login-rate-limit.js';
import { MetricsRegistry } from './services/metrics.js';
import { createRegistryService } from './services/registry.js';
import { MemorySessionStore } from './services/sessions.js';
import { MapTotpSecretResolver, TotpService, parseTotpSecrets } from './lib/totp.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerMetricsRoutes } from './routes/metrics.js';
import { registerAgentRoutes } from './agent/routes.js';
import { TypertBridgeClient } from './agent/bridge-client.js';
import { AgentRunManager } from './agent/run-manager.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerModelRoutes } from './routes/models.js';
import { registerRouteConfigRoutes } from './routes/route-config.js';
import { registerUsageRoutes } from './routes/usage.js';
import { registerProductRoutes } from './routes/products.js';
import { registerContentRoutes } from './routes/content.js';
import { registerJudgmentRoutes } from './routes/judgments.js';
import './types.js';

export interface BuildAppOptions {
  prisma?: PrismaClient;
  /** 测试可注入固定时钟（会话/幂等 TTL）。 */
  now?: () => number;
  /** buildApp 关闭时是否断开全局 Prisma 单例；测试多 app 时可设 false。 */
  disconnectOnClose?: boolean;
}

function isMutating(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const prisma = options.prisma ?? getPrisma();
  const now = options.now ?? (() => Date.now());
  const metricsRegistry = new MetricsRegistry();
  const sessions = new MemorySessionStore({
    idleSeconds: config.sessionIdleSeconds,
    adminIdleSeconds: config.sessionAdminIdleSeconds,
    absoluteSeconds: config.sessionAbsoluteSeconds,
    now,
  });
  const idempotencyStore = new MemoryIdempotencyStore(24 * 3600 * 1000, now);
  const totp = new TotpService(
    new MapTotpSecretResolver(parseTotpSecrets(config.totpSecretsJson)),
    config.totpIssuer,
    now,
  );
  const audit = new AuditService(prisma, metricsRegistry);
  const registry = createRegistryService({ prisma, audit, config });
  const bridgeLog: { warn: (obj: unknown, msg?: string) => void } = {
    warn: (obj: unknown, msg?: string): void => {
      app.log.warn(obj, msg);
    },
  };
  const agentBridge = new TypertBridgeClient(config, { log: bridgeLog });
  const agentRuns = new AgentRunManager({
    config,
    bridge: agentBridge,
    audit,
    metrics: metricsRegistry,
    log: {
      warn: (obj, msg) => app.log.warn(obj, msg),
      error: (obj, msg) => app.log.error(obj, msg),
    },
  });
  const limiter = new LoginRateLimiter(
    config.loginRateMax,
    config.loginRateWindowMs,
    now,
  );

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
    },
    genReqId: (rawRequest) => normalizeRequestId(rawRequest.headers['x-request-id']),
    trustProxy: false,
  });

  app.decorate('config', config);
  app.decorate('prisma', prisma);
  app.decorate('sessions', sessions);
  app.decorate('metricsRegistry', metricsRegistry);
  app.decorate('idempotencyStore', idempotencyStore);
  app.decorate('audit', audit);
  app.decorate('registry', registry);
  app.decorate('agentBridge', agentBridge);
  app.decorate('agentRuns', agentRuns);
  app.decorate(
    'authService',
    new AuthService({
      prisma,
      sessions,
      audit,
      totp,
      limiter,
      config,
      metrics: metricsRegistry,
      logError: (error, context) => app.log.error({ err: error, context }, 'auth background failure'),
    }),
  );

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // 1) 请求上下文：request_id、时间、安全头。
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = request.id;
    request.startedAt = now();
    request.auth = null;
    request.session = null;
    request.auditLogged = false;
    reply.header('X-Request-Id', request.id);
    reply.header('X-Contract-Version', config.contractVersion);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // 2) 认证 / 角色 / CSRF。
  registerAuthGate(app);

  // 3) Idempotency-Key（在认证之后，能拿到 org_id）。
  registerIdempotency(app, idempotencyStore);

  // 4) 响应发送时的额外头。
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/auth')) {
      reply.header('Cache-Control', 'no-store');
    }
    reply.header('X-Request-Id', request.requestId);
    return payload;
  });

  // 5) 通用写审计：路由未显式审计时兜底；不阻断响应，失败只记日志。
  app.addHook('onResponse', async (request, reply) => {
    if (!isMutating(request.method) || request.auditLogged) return;
    if (request.routeOptions.config?.audit === false) return;
    if (!request.url.startsWith('/api/')) return;
    if (reply.statusCode >= 500) return;
    try {
      await audit.record({
        action: `api.${request.method.toLowerCase()}`,
        actorType: request.auth ? 'user' : 'system',
        actorId: request.auth?.userId ?? null,
        requestId: request.requestId,
        resourceType: 'route',
        resourceId: null,
        before: {},
        after: { status_code: reply.statusCode },
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        meta: {
          actor_role: request.auth?.role ?? null,
          method: request.method,
          path: request.url.split('?')[0],
        },
      });
    } catch (error) {
      request.log.error({ err: error }, 'generic write audit failed');
    }
  });

  // 6) HTTP 指标。
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? request.url.split('?')[0] ?? 'unknown';
    metricsRegistry.inc('dssaas_http_requests_total', 'HTTP 请求数', {
      method: request.method,
      route,
      status: String(reply.statusCode),
    });
    metricsRegistry.observe(
      'dssaas_http_request_duration_ms',
      'HTTP 请求耗时（毫秒）',
      { method: request.method, route },
      Math.max(0, now() - request.startedAt),
    );
  });

  registerErrorHandler(app);

  registerHealthRoutes(app);
  registerMetricsRoutes(app);
  registerAuthRoutes(app);
  registerAuditRoutes(app);
  registerProviderRoutes(app);
  registerModelRoutes(app);
  registerRouteConfigRoutes(app);
  registerUsageRoutes(app);
  registerProductRoutes(app);
  registerContentRoutes(app);
  registerJudgmentRoutes(app);
  registerAgentRoutes(app);

  app.addHook('onClose', async () => {
    agentRuns.close();
    sessions.clear();
    idempotencyStore.clear();
    if (options.disconnectOnClose !== false) {
      await disconnectPrisma();
    }
  });

  return app;
}
