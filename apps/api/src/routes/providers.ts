/** Provider 管理：CRUD + 连通性测试（docs/12 §3.2、docs/07 §3.2/§9.1）。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@dssaas/db';
import { credentialMask } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import { throwGatewayError } from '../lib/gateway-errors.js';
import { ok } from '../lib/response.js';
import { principalFromRequest } from '../lib/principal.js';

const RateLimit = z.object({
  rpm: z.number().int().min(0).optional(),
  tpm: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(0).optional(),
  daily_calls: z.number().int().min(0).optional(),
});

const ProviderCreate = z.object({
  kind: z.enum(['text', 'image', 'video', 'embedding']),
  name: z.string().regex(/^[a-z][a-z0-9_]{2,39}$/, 'name 形如 volc_image_prod'),
  base_url: z.string().url().startsWith('https://').optional(),
  credential_ref: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/),
  vendor: z.enum(['deepseek', 'volcengine', 'aliyun', 'openai_compatible', 'other']).default('other'),
  auth_scheme: z.enum(['bearer', 'header', 'query', 'ak_sk', 'none']).default('bearer'),
  region: z.string().max(64).optional(),
  timeout_ms: z.number().int().min(1000).max(600000).default(60000),
  max_concurrency: z.number().int().min(1).max(256).default(8),
  rate_limit: RateLimit.default({}),
  extra: z.record(z.string(), z.unknown()).default({}),
});

const ProviderPatch = z.object({
  base_url: z.string().url().startsWith('https://').nullable().optional(),
  credential_ref: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/).optional(),
  timeout_ms: z.number().int().min(1000).max(600000).optional(),
  max_concurrency: z.number().int().min(1).max(256).optional(),
  rate_limit: RateLimit.optional(),
  region: z.string().max(64).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

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

async function ensureCredentialMetadata(
  app: FastifyInstance,
  orgId: number,
  name: string,
): Promise<void> {
  const existing = await app.prisma.credentialRef.findFirst({
    where: { orgId: BigInt(orgId), name, archivedAt: null },
    select: { id: true },
  });
  if (existing) return;
  try {
    await app.prisma.credentialRef.create({
      data: { orgId: BigInt(orgId), name, purpose: 'provider', status: 'active' },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

export function registerProviderRoutes(app: FastifyInstance): void {
  app.get('/api/providers', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const providers = await app.registry.repo.listProviders(principal.orgId);
    return ok(request, {
      items: providers.map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        base_url: provider.baseUrl,
        credential_ref_masked: credentialMask(provider.credentialRef),
        region: provider.region,
        status: provider.status,
        connectivity: {
          ok: provider.connectivity === 'ok',
          latency_ms: provider.lastCheckLatencyMs,
          checked_at: provider.lastCheckAt?.toISOString() ?? null,
        },
        balance_cents: provider.balanceCents,
        version: provider.version,
      })),
    });
  });

  app.post('/api/providers', { config: { minRole: 'admin' } }, async (request, reply) => {
    const principal = await principalFromRequest(app, request);
    const body = ProviderCreate.parse(request.body ?? {});
    await ensureCredentialMetadata(app, principal.orgId, body.credential_ref);

    let created;
    try {
      created = await app.prisma.provider.create({
        data: {
          orgId: BigInt(principal.orgId),
          name: body.name,
          kind: body.kind,
          vendor: body.vendor,
          baseUrl: body.base_url ?? null,
          credentialRef: body.credential_ref,
          authScheme: body.auth_scheme,
          timeoutMs: body.timeout_ms,
          maxConcurrency: body.max_concurrency,
          rateLimit: body.rate_limit as Prisma.InputJsonValue,
          region: body.region ?? null,
          extra: body.extra as Prisma.InputJsonValue,
          status: 'configuring',
          connectivity: 'unknown',
          createdBy: principal.userId,
        },
        select: { id: true, status: true, connectivity: true, version: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'Provider 名称已存在', { detail: { name: body.name } });
      }
      throw error;
    }

    await app.audit.record({
      action: 'provider.create',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'provider',
      resourceId: created.id,
      after: { ...body, credential_ref: credentialMask(body.credential_ref) },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    reply.code(201);
    return ok(request, {
      id: created.id,
      status: created.status,
      connectivity: created.connectivity,
      version: created.version,
    });
  });

  app.patch('/api/providers/:id', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ProviderPatch.parse(request.body ?? {});
    const expectedVersion = parseIfMatch(request);

    const before = await app.prisma.provider.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!before) throw new ApiError('not_found', 'Provider 不存在');
    if (before.version !== expectedVersion) {
      throw new ApiError('conflict', '版本冲突，请刷新后重试', {
        detail: { expected: expectedVersion, actual: before.version },
      });
    }

    if (body.credential_ref) {
      await ensureCredentialMetadata(app, principal.orgId, body.credential_ref);
    }

    const result = await app.prisma.provider.updateMany({
      where: { id: params.id, version: expectedVersion },
      data: {
        ...(body.base_url === undefined ? {} : { baseUrl: body.base_url }),
        ...(body.credential_ref === undefined ? {} : { credentialRef: body.credential_ref }),
        ...(body.timeout_ms === undefined ? {} : { timeoutMs: body.timeout_ms }),
        ...(body.max_concurrency === undefined ? {} : { maxConcurrency: body.max_concurrency }),
        ...(body.rate_limit === undefined
          ? {}
          : { rateLimit: body.rate_limit as Prisma.InputJsonValue }),
        ...(body.region === undefined ? {} : { region: body.region }),
        ...(body.status === undefined ? {} : { status: body.status }),
      },
    });
    if (result.count === 0) throw new ApiError('conflict', '版本冲突，请刷新后重试');

    if (body.status === 'disabled') {
      await app.prisma.model.updateMany({
        where: { providerId: params.id, status: 'published', archivedAt: null },
        data: { status: 'suspended' },
      });
    }

    const after = await app.prisma.provider.findUniqueOrThrow({ where: { id: params.id } });
    await app.audit.record({
      action: 'provider.update',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'provider',
      resourceId: params.id,
      before: {
        base_url: before.baseUrl,
        credential_ref: credentialMask(before.credentialRef),
        timeout_ms: before.timeoutMs,
        max_concurrency: before.maxConcurrency,
        rate_limit: before.rateLimit,
        status: before.status,
      },
      after: {
        base_url: after.baseUrl,
        credential_ref: credentialMask(after.credentialRef),
        timeout_ms: after.timeoutMs,
        max_concurrency: after.maxConcurrency,
        rate_limit: after.rateLimit,
        status: after.status,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, { id: after.id, version: after.version, status: after.status });
  });

  app.post('/api/providers/:id/test', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    let probe;
    try {
      probe = await app.registry.gateway.probeProvider(params.id);
    } catch (error) {
      throwGatewayError(error);
    }
    const okTest = probe.ok;
    const nextStatus = okTest
      ? probe.provider.status === 'disabled'
        ? 'disabled'
        : 'active'
      : probe.provider.status === 'active'
        ? 'degraded'
        : probe.provider.status === 'disabled'
          ? 'disabled'
          : 'configuring';

    const before = {
      status: probe.provider.status,
      connectivity: probe.provider.connectivity,
      last_error_code: probe.provider.lastErrorCode,
    };
    await app.prisma.provider.update({
      where: { id: params.id },
      data: {
        status: nextStatus,
        connectivity: okTest ? 'ok' : 'failed',
        lastCheckAt: new Date(),
        lastCheckLatencyMs: probe.latencyMs,
        lastErrorCode: okTest ? null : (probe.errorCode ?? 'unknown'),
      },
    });
    await app.audit.record({
      action: 'provider.test',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'provider',
      resourceId: params.id,
      before,
      after: {
        ok: okTest,
        latency_ms: probe.latencyMs,
        status: nextStatus,
        connectivity: okTest ? 'ok' : 'failed',
        error_code: probe.errorCode ?? null,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, {
      ok: okTest,
      latency_ms: probe.latencyMs,
      models_probed: okTest ? 1 : 0,
      ...(okTest ? {} : { error: { code: probe.errorCode ?? 'unknown' } }),
    });
  });
}
