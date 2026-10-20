/** Fastify 类型增强：request/instance 上的装饰器与路由 config。 */
import type { PrismaClient } from '@dssaas/db';
import type { Role } from '@dssaas/core';
import type { FastifyContextConfig } from 'fastify';
import type { AppConfig } from './config.js';
import type { AuthContext, AuthService } from './services/identity.js';
import type { AuditService } from './services/audit.js';
import type { MetricsRegistry } from './services/metrics.js';
import type { RegistryService } from './services/registry.js';
import type { SessionRecord, SessionStore } from './services/sessions.js';
import type { MemoryIdempotencyStore } from './plugins/idempotency.js';
import type { TypertBridgeClient } from './agent/bridge-client.js';
import type { AgentRunManager } from './agent/run-manager.js';
import type { KnowledgeService } from './knowledge/service.js';

export interface IdempotencyRequestContext {
  key: string;
  headerValue: string;
  payloadHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 贯穿 api/worker/平台/模型的请求 ID（X-Request-Id）。 */
    requestId: string;
    /** 已认证上下文；未登录为 null。 */
    auth: AuthContext | null;
    /** 完整会话记录（用于 CSRF 校验/登出）；未登录为 null。 */
    session: SessionRecord | null;
    /** 本次写请求是否已显式写审计（避免通用钩子重复写）。 */
    auditLogged: boolean;
    /** 请求开始时间（ms），用于延迟指标。 */
    startedAt: number;
    /** 幂等中间件上下文。 */
    idempotency?: IdempotencyRequestContext;
  }

  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
    sessions: SessionStore;
    authService: AuthService;
    audit: AuditService;
    registry: RegistryService;
    knowledge: KnowledgeService;
    agentBridge: TypertBridgeClient;
    agentRuns: AgentRunManager;
    metricsRegistry: MetricsRegistry;
    idempotencyStore: MemoryIdempotencyStore;
  }

  interface FastifyContextConfig {
    /** 公开路由：不要求登录（/health、/auth/login、/metrics 自校验）。 */
    public?: boolean;
    /** 最低角色要求，缺省 viewer。 */
    minRole?: Role;
    /** false = 该写路由豁免 Idempotency-Key（仅 auth/健康检查等）。 */
    idempotency?: boolean;
    /** false = 不进入通用写审计钩子（路由内已显式审计）。 */
    audit?: boolean;
  }
}
