/** Model 管理：CRUD + 测试 + 发布/停用/归档（docs/12 §3.2、docs/07 §3.3/§4/§9）。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '@dssaas/db';
import {
  CAPABILITY_PURPOSE,
  validateAgainstSchema,
  validateModelParams,
  validateParamsSchema,
  validatePriceBook,
  type Capability,
  type Purpose,
} from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import { throwGatewayError } from '../lib/gateway-errors.js';
import { parseLimit } from '../lib/cursor.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { principalFromRequest } from '../lib/principal.js';

const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;
const CAPABILITIES = ['text', 'image', 'video', 'embedding', 'rerank'] as const;

const RateLimit = z.object({
  rpm: z.number().int().min(0).optional(),
  tpm: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(0).optional(),
  daily_calls: z.number().int().min(0).optional(),
});

const ModelCreate = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional(),
  provider_id: z.string().uuid(),
  external_model_id: z.string().min(1).max(128),
  display_name: z.string().min(1).max(200),
  capability: z.enum(CAPABILITIES),
  purpose_support: z.array(z.enum(PURPOSES)).optional(),
  params_schema: z.record(z.string(), z.unknown()),
  default_params: z.record(z.string(), z.unknown()).default({}),
  price: z.record(z.string(), z.unknown()),
  rate_limit: RateLimit.optional(),
  context_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  embed_dim: z.number().int().min(1).max(8192).optional(),
  docs_url: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
});

const ModelPatch = z.object({
  display_name: z.string().min(1).max(200).optional(),
  params_schema: z.record(z.string(), z.unknown()).optional(),
  default_params: z.record(z.string(), z.unknown()).optional(),
  price: z.record(z.string(), z.unknown()).optional(),
  rate_limit: RateLimit.optional(),
  notes: z.string().max(2000).nullable().optional(),
  docs_url: z.string().url().nullable().optional(),
});

const ModelQuery = z.object({
  purpose: z.enum(PURPOSES).optional(),
  capability: z.enum(CAPABILITIES).optional(),
  status: z.enum(['draft', 'testing', 'published', 'suspended', 'archived']).optional(),
  provider_id: z.string().uuid().optional(),
  q: z.string().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
});

const CursorShape = z.object({ name: z.string().min(1) });

const DEFAULT_PURPOSES: Record<Capability, Purpose[]> = {
  text: ['copy', 'judge'],
  image: ['image'],
  video: ['video'],
  embedding: ['embed'],
  rerank: ['rerank'],
};

const KIND_FOR_CAPABILITY: Record<Capability, string> = {
  text: 'text',
  rerank: 'text',
  image: 'image',
  video: 'video',
  embedding: 'embedding',
};

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

function sanitizeName(externalModelId: string): string {
  const cleaned = externalModelId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '');
  const withPrefix = /^[a-z0-9]/.test(cleaned) ? cleaned : `m.${cleaned}`;
  return withPrefix.slice(0, 64).padEnd(2, '0');
}

function validateCapabilityPurposes(capability: Capability, purposes: Purpose[]): void {
  const allowed = CAPABILITY_PURPOSE[capability];
  const invalid = purposes.filter((purpose) => !allowed.has(purpose));
  if (invalid.length > 0) {
    throw new ApiError('validation_failed', `capability=${capability} 不支持 purpose: ${invalid.join(',')}`, {
      detail: { field: 'purpose_support', invalid },
    });
  }
}

export function registerModelRoutes(app: FastifyInstance): void {
  app.get('/api/models', { config: { minRole: 'viewer' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const query = ModelQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const includeInvisible = request.auth?.role === 'admin';
    const cursor = query.cursor
      ? decodeCursor(query.cursor, CursorShape)
      : null;

    const models = await app.registry.gateway.listModels(principal, {
      ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.capability === undefined ? {} : { capability: query.capability }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.provider_id === undefined ? {} : { providerId: query.provider_id }),
      includeInvisible,
    });

    const afterCursor = cursor ? models.filter((item) => item.model.name > cursor.name) : models;
    const page = afterCursor.slice(0, limit);
    const nextCursor =
      afterCursor.length > limit
        ? encodeCursor({ name: page[page.length - 1]!.model.name })
        : null;

    return ok(
      request,
      {
        items: page.map((item) => ({
          id: item.model.id,
          provider_id: item.model.providerId,
          external_model_id: item.model.externalModelId,
          display_name: item.model.displayName,
          capability: item.model.capability,
          status: item.model.status,
          price: item.model.price,
          price_version: item.model.priceVersion,
          version: item.model.version,
          rate_limit: item.model.rateLimit,
          published_at: item.model.publishedAt?.toISOString() ?? null,
          visible: item.visible,
          ...(item.visible ? {} : { visible_reason: item.reason ?? 'no_route' }),
        })),
      },
      { next_cursor: nextCursor },
    );
  });

  app.post('/api/models', { config: { minRole: 'admin' } }, async (request, reply) => {
    const principal = await principalFromRequest(app, request);
    const body = ModelCreate.parse(request.body ?? {});
    const provider = await app.prisma.provider.findFirst({
      where: { id: body.provider_id, archivedAt: null },
    });
    if (!provider) throw new ApiError('not_found', 'Provider 不存在');
    if (provider.kind !== KIND_FOR_CAPABILITY[body.capability]) {
      throw new ApiError('validation_failed', 'capability 与 provider.kind 不兼容', {
        detail: { capability: body.capability, provider_kind: provider.kind },
      });
    }

    const purposes = body.purpose_support ?? DEFAULT_PURPOSES[body.capability];
    if (purposes.length === 0) {
      throw new ApiError('validation_failed', 'purpose_support 不能为空', {
        detail: { field: 'purpose_support' },
      });
    }
    validateCapabilityPurposes(body.capability, purposes);

    const schemaCheck = validateParamsSchema(body.params_schema);
    if (!schemaCheck.ok) {
      throw new ApiError('validation_failed', 'params_schema 非法', {
        detail: { errors: schemaCheck.errors },
      });
    }
    const defaultsCheck = validateAgainstSchema(body.params_schema, body.default_params);
    if (!defaultsCheck.ok) {
      throw new ApiError('validation_failed', 'default_params 不符合 params_schema', {
        detail: { errors: defaultsCheck.errors },
      });
    }
    const priceCheck = validatePriceBook(body.price, body.capability);
    if (!priceCheck.ok) {
      throw new ApiError('validation_failed', 'price 结构非法', {
        detail: { errors: priceCheck.errors },
      });
    }
    if ((body.capability === 'text' || body.capability === 'rerank') && !body.context_tokens) {
      throw new ApiError('validation_failed', 'text/rerank 模型必须提供 context_tokens', {
        detail: { field: 'context_tokens' },
      });
    }
    if (body.capability === 'embedding' && !body.embed_dim) {
      throw new ApiError('validation_failed', 'embedding 模型必须提供 embed_dim', {
        detail: { field: 'embed_dim' },
      });
    }

    const name = body.name ?? sanitizeName(body.external_model_id);
    let created;
    try {
      created = await app.prisma.model.create({
        data: {
          orgId: provider.orgId,
          providerId: provider.id,
          name,
          externalModelId: body.external_model_id,
          displayName: body.display_name,
          capability: body.capability,
          purposeSupport: purposes,
          paramsSchema: body.params_schema as Prisma.InputJsonValue,
          defaultParams: body.default_params as Prisma.InputJsonValue,
          price: body.price as Prisma.InputJsonValue,
          rateLimit: (body.rate_limit ?? {}) as Prisma.InputJsonValue,
          contextTokens: body.context_tokens ?? null,
          maxOutputTokens: body.max_output_tokens ?? null,
          embedDim: body.embed_dim ?? null,
          status: 'draft',
          docsUrl: body.docs_url ?? null,
          notes: body.notes ?? null,
          createdBy: principal.userId,
        },
        select: { id: true, name: true, status: true, version: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', 'model.name 或 (provider, external_model_id) 已存在', {
          detail: { name },
        });
      }
      throw error;
    }

    await app.audit.record({
      action: 'model.create',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: created.id,
      after: {
        name: created.name,
        provider_id: provider.id,
        external_model_id: body.external_model_id,
        capability: body.capability,
        purpose_support: purposes,
        price: body.price,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    reply.code(201);
    return ok(request, { id: created.id, status: created.status, version: created.version });
  });

  app.patch('/api/models/:id', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = ModelPatch.parse(request.body ?? {});
    const expectedVersion = parseIfMatch(request);

    const before = await app.prisma.model.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!before) throw new ApiError('not_found', 'Model 不存在');
    if (before.version !== expectedVersion) {
      throw new ApiError('conflict', '版本冲突，请刷新后重试', {
        detail: { expected: expectedVersion, actual: before.version },
      });
    }

    const capability = before.capability as Capability;
    if (body.params_schema || body.default_params) {
      const schema = (body.params_schema ?? before.paramsSchema) as Record<string, unknown>;
      const defaults = (body.default_params ?? before.defaultParams) as Record<string, unknown>;
      const schemaCheck = validateParamsSchema(schema);
      if (!schemaCheck.ok) {
        throw new ApiError('validation_failed', 'params_schema 非法', {
          detail: { errors: schemaCheck.errors },
        });
      }
      const defaultsCheck = validateAgainstSchema(schema, defaults);
      if (!defaultsCheck.ok) {
        throw new ApiError('validation_failed', 'default_params 不符合 params_schema', {
          detail: { errors: defaultsCheck.errors },
        });
      }
    }
    if (body.price) {
      const priceCheck = validatePriceBook(body.price, capability);
      if (!priceCheck.ok) {
        throw new ApiError('validation_failed', 'price 结构非法', {
          detail: { errors: priceCheck.errors },
        });
      }
    }

    const priceChanged =
      body.price !== undefined &&
      JSON.stringify(body.price) !== JSON.stringify(before.price);
    const result = await app.prisma.model.updateMany({
      where: { id: params.id, version: expectedVersion },
      data: {
        ...(body.display_name === undefined ? {} : { displayName: body.display_name }),
        ...(body.params_schema === undefined
          ? {}
          : { paramsSchema: body.params_schema as Prisma.InputJsonValue }),
        ...(body.default_params === undefined
          ? {}
          : { defaultParams: body.default_params as Prisma.InputJsonValue }),
        ...(body.price === undefined
          ? {}
          : {
              price: body.price as Prisma.InputJsonValue,
              priceVersion: before.priceVersion + 1,
            }),
        ...(body.rate_limit === undefined
          ? {}
          : { rateLimit: body.rate_limit as Prisma.InputJsonValue }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.docs_url === undefined ? {} : { docsUrl: body.docs_url }),
      },
    });
    if (result.count === 0) throw new ApiError('conflict', '版本冲突，请刷新后重试');

    const after = await app.prisma.model.findUniqueOrThrow({ where: { id: params.id } });
    await app.audit.record({
      action: priceChanged ? 'model.price_change' : 'model.update',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: params.id,
      before: {
        display_name: before.displayName,
        price: before.price,
        price_version: before.priceVersion,
        params_schema: before.paramsSchema,
      },
      after: {
        display_name: after.displayName,
        price: after.price,
        price_version: after.priceVersion,
        params_schema: after.paramsSchema,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null, price_changed: priceChanged },
    });
    request.auditLogged = true;
    return ok(request, {
      id: after.id,
      version: after.version,
      status: after.status,
      price_version: after.priceVersion,
    });
  });

  app.post('/api/models/:id/test', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await app.prisma.model.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!model) throw new ApiError('not_found', 'Model 不存在');

    let probe;
    try {
      probe = await app.registry.gateway.probeModel(params.id, {
        requestId: request.requestId,
        actorType: 'user',
        actorId: principal.userId,
      });
    } catch (error) {
      throwGatewayError(error);
    }

    const nextStatus = probe.ok
      ? model.status === 'draft' || model.status === 'testing'
        ? 'testing'
        : model.status
      : model.status === 'testing'
        ? 'draft'
        : model.status;
    await app.prisma.model.update({ where: { id: params.id }, data: { status: nextStatus } });
    await app.audit.record({
      action: 'model.test',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: params.id,
      after: {
        ok: probe.ok,
        latency_ms: probe.latencyMs,
        error_code: probe.errorCode ?? null,
        call_log_id: probe.callLogId ?? null,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, {
      ok: probe.ok,
      latency_ms: probe.latencyMs,
      ...(probe.errorCode === undefined ? {} : { error: { code: probe.errorCode } }),
    });
  });

  app.post('/api/models/:id/publish', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const model = await app.prisma.model.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!model) throw new ApiError('not_found', 'Model 不存在');
    if (!['draft', 'testing', 'suspended'].includes(model.status)) {
      throw new ApiError('publish_blocked', '当前状态不可发布', {
        detail: { status: model.status },
      });
    }

    const provider = await app.prisma.provider.findFirst({
      where: { id: model.providerId, archivedAt: null },
    });
    if (!provider) throw new ApiError('publish_blocked', 'Provider 不存在');
    const credential = await app.prisma.credentialRef.findFirst({
      where: {
        orgId: provider.orgId,
        name: provider.credentialRef,
        archivedAt: null,
      },
      select: { status: true },
    });

    const capability = model.capability as Capability;
    const purposes = model.purposeSupport.filter((value): value is Purpose =>
      (PURPOSES as readonly string[]).includes(value),
    );
    const priceCheck = validatePriceBook(model.price, capability);
    const paramsCheck = validateModelParams({
      id: model.id,
      version: model.version,
      paramsSchema: model.paramsSchema as Record<string, unknown>,
      defaultParams: model.defaultParams as Record<string, unknown>,
    });
    const recentTests = await app.prisma.auditLog.findMany({
      where: {
        action: 'model.test',
        resourceType: 'model',
        resourceId: model.id,
        occurredAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
      orderBy: { seq: 'desc' },
      take: 5,
      select: { after: true },
    });
    const recentTestOk = recentTests.some(
      (row) => (row.after as { ok?: boolean } | null)?.ok === true,
    );

    const missing: string[] = [];
    if (model.status === 'archived') missing.push('model.archived');
    if (purposes.length === 0) missing.push('purpose_support.empty');
    if (provider.status !== 'active') missing.push('provider.status');
    if (provider.connectivity !== 'ok') missing.push('provider.connectivity');
    if (!credential || credential.status !== 'active') missing.push('credential_ref.status');
    if (!paramsCheck.ok) missing.push(...paramsCheck.errors.map((error) => `params:${error}`));
    if (!priceCheck.ok) missing.push(...priceCheck.errors.map((error) => `price:${error}`));
    if (!recentTestOk) missing.push('model.test_recent_success');
    if (purposes.some((purpose) => !CAPABILITY_PURPOSE[capability].has(purpose))) {
      missing.push('capability_purpose_mismatch');
    }
    if (capability === 'embedding' && !model.embedDim) missing.push('embed_dim');
    if ((capability === 'text' || capability === 'rerank') && !model.contextTokens) {
      missing.push('context_tokens');
    }
    if (missing.length > 0) {
      throw new ApiError('publish_blocked', '发布守卫未通过', { detail: { missing } });
    }

    await app.prisma.model.updateMany({
      where: { id: model.id, version: model.version },
      data: {
        status: 'published',
        publishedAt: new Date(),
        publishedBy: principal.userId,
      },
    });
    const after = await app.prisma.model.findUniqueOrThrow({ where: { id: model.id } });
    await app.audit.record({
      action: 'model.publish',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: model.id,
      before: { status: model.status },
      after: {
        status: 'published',
        published_at: after.publishedAt?.toISOString() ?? null,
        price_version: after.priceVersion,
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, {
      id: after.id,
      status: after.status,
      published_at: after.publishedAt?.toISOString() ?? null,
    });
  });

  app.post('/api/models/:id/suspend', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const before = await app.prisma.model.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!before) throw new ApiError('not_found', 'Model 不存在');
    if (!['published', 'suspended'].includes(before.status)) {
      throw new ApiError('conflict', '当前状态不可停用', { detail: { status: before.status } });
    }
    await app.prisma.model.update({ where: { id: params.id }, data: { status: 'suspended' } });
    await app.audit.record({
      action: 'model.suspend',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: params.id,
      before: { status: before.status },
      after: { status: 'suspended' },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, { id: params.id, status: 'suspended' });
  });

  app.post('/api/models/:id/archive', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const before = await app.prisma.model.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!before) throw new ApiError('not_found', 'Model 不存在');
    const activeRoutes = await app.prisma.modelRoute.findMany({
      where: {
        orgId: before.orgId,
        status: 'active',
        archivedAt: null,
        OR: [{ modelId: params.id }, { fallbackIds: { has: params.id } }],
      },
      select: { id: true },
    });
    if (activeRoutes.length > 0) {
      throw new ApiError('conflict', 'Model 仍被 active 路由引用，禁止归档', {
        detail: { route_ids: activeRoutes.map((route) => route.id) },
      });
    }
    await app.prisma.model.update({ where: { id: params.id }, data: { status: 'archived' } });
    await app.audit.record({
      action: 'model.archive',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model',
      resourceId: params.id,
      before: { status: before.status },
      after: { status: 'archived' },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, { id: params.id, status: 'archived' });
  });
}
