/**
 * 平台账号路由（t54）—— docs/12 §3.10「平台连接」页的 5 个端点。
 *
 * 权限：列表 viewer 可读；新建/修改/测试/归档仅 admin。
 * 安全：所有写操作进审计（脱敏后值）；响应只含引用名与脱敏 app_key，绝无实值。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import { PlatformAccountService } from '../services/platform-accounts.js';

const PlatformParams = z.object({ platform: z.enum(['pdd', '1688']) });
const IdParams = z.object({ id: z.string().uuid() });

const AccountQuery = z.object({ platform: z.enum(['pdd', '1688']).optional() });

const RefSchema = z.string().min(1).max(128);

const AccountCreate = z.object({
  platform: z.enum(['pdd', '1688']),
  shop_id: z.string().min(1).max(128).nullable().optional(),
  shop_name: z.string().max(200).nullable().optional(),
  app_key: z.string().min(1).max(128),
  app_secret_ref: RefSchema,
  access_token_ref: RefSchema.nullable().optional(),
  refresh_token_ref: RefSchema.nullable().optional(),
  token_expires_at: z.string().nullable().optional(),
  contract_version: z.number().int().min(1).max(99).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const AccountPatch = z.object({
  shop_name: z.string().max(200).nullable().optional(),
  app_key: z.string().min(1).max(128).optional(),
  app_secret_ref: RefSchema.optional(),
  access_token_ref: RefSchema.nullable().optional(),
  refresh_token_ref: RefSchema.nullable().optional(),
  token_expires_at: z.string().nullable().optional(),
  status: z.enum(['active', 'disabled', 'expired']).optional(),
  contract_version: z.number().int().min(1).max(99).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

/** 与 providers.ts 同款 If-Match 解析（版本号必须是 ≥1 的整数）。 */
function parseIfMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const version = Number(value);
  if (!value || !Number.isInteger(version) || version < 1) {
    throw new ApiError('validation_failed', 'PATCH 需要 If-Match: <version>', {
      detail: { field: 'If-Match' },
    });
  }
  return version;
}

export function registerPlatformAccountRoutes(app: FastifyInstance): void {
  const service = new PlatformAccountService({
    prisma: app.prisma,
    audit: app.audit,
    // 平台接口尚未核验（docs/02 §4 TODO 全开）→ 测试连通必须诚实返回 interfaces_unverified。
    interfacesVerified: false,
  });

  app.get('/api/platform-accounts', { config: { minRole: 'viewer' } }, async (request) => {
    const query = AccountQuery.parse(request.query ?? {});
    return ok(request, await service.list(query.platform));
  });

  app.get('/api/platform-accounts/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = IdParams.parse(request.params);
    return ok(request, await service.get(params.id));
  });

  app.post('/api/platform-accounts', { config: { minRole: 'admin' } }, async (request, reply) => {
    const body = AccountCreate.parse(request.body ?? {});
    const result = await service.create(body, serviceContext(request));
    request.auditLogged = true;
    reply.code(201);
    return ok(request, result);
  });

  app.patch('/api/platform-accounts/:id', { config: { minRole: 'admin' } }, async (request) => {
    const params = IdParams.parse(request.params);
    const body = AccountPatch.parse(request.body ?? {});
    const expectedVersion = parseIfMatch(request);
    const result = await service.patch(params.id, expectedVersion, body, serviceContext(request));
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post('/api/platform-accounts/:id/test', { config: { minRole: 'admin' } }, async (request) => {
    const params = IdParams.parse(request.params);
    const result = await service.testConnectivity(params.id, serviceContext(request));
    request.auditLogged = true;
    return ok(request, result);
  });

  app.post('/api/platform-accounts/:id/archive', { config: { minRole: 'admin' } }, async (request) => {
    const params = IdParams.parse(request.params);
    const result = await service.archive(params.id, serviceContext(request));
    request.auditLogged = true;
    return ok(request, result);
  });
}

export { PlatformParams };
