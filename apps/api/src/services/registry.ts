/**
 * 模型网关装配：把 registry 的纯模块接到 Prisma、审计与配置上。
 * 一个 API 进程一份（配额/熔断为进程内状态；多实例替换 Redis 后共享）。
 */
import {
  CircuitBreaker,
  MapCredentialResolver,
  ModelGateway,
  PrismaRegistryRepo,
  QuotaService,
  createAdapterFactory,
  parseCredentialMap,
  type AdapterFactory,
  type AuditSink,
} from '@dssaas/registry';
import type { PrismaClient } from '@dssaas/db';
import type { AppConfig } from '../config.js';
import type { AuditService } from './audit.js';

export interface RegistryService {
  repo: PrismaRegistryRepo;
  gateway: ModelGateway;
  quota: QuotaService;
  breaker: CircuitBreaker;
  adapterFactory: AdapterFactory;
  credentials: MapCredentialResolver;
}

export interface CreateRegistryOptions {
  prisma: PrismaClient;
  audit: AuditService;
  config: AppConfig;
  adapterFactory?: AdapterFactory;
}

export function createRegistryService(options: CreateRegistryOptions): RegistryService {
  const repo = new PrismaRegistryRepo(options.prisma);
  const quota = new QuotaService(repo);
  const breaker = new CircuitBreaker();
  const credentials = new MapCredentialResolver(parseCredentialMap(options.config.modelCredentialsJson));
  const auditSink: AuditSink = {
    record: async (input) =>
      options.audit.record({
        action: input.action,
        actorType: input.actorType,
        actorId: input.actorId,
        requestId: input.requestId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        before: input.before,
        after: input.after,
        irreversible: input.irreversible,
        meta: input.meta,
        ip: input.ip,
        userAgent: input.userAgent,
      }),
  };
  const adapterFactory = options.adapterFactory ?? createAdapterFactory();
  const gateway = new ModelGateway({
    repo,
    adapterFactory,
    quota,
    breaker,
    credentials,
    audit: auditSink,
  });
  return { repo, gateway, quota, breaker, adapterFactory, credentials };
}
