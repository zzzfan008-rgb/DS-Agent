/** Route 管理：路由矩阵与发布守卫（docs/12 §3.2、docs/07 §3.4/§5）。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CAPABILITY_PURPOSE, type Capability } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { principalFromRequest } from '../lib/principal.js';

const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;

const Quota = z.object({
  rpm: z.number().int().min(0).optional(),
  tpm: z.number().int().min(0).optional(),
  concurrency: z.number().int().min(0).optional(),
  daily_calls: z.number().int().min(0).optional(),
  daily_cost_cents: z.number().int().min(0).optional(),
  monthly_cost_cents: z.number().int().min(0).optional(),
});

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), '时间必须是 ISO8601')
  .transform((value) => new Date(value));

const RouteCreate = z.object({
  scope_type: z.enum(['org', 'role', 'user']),
  scope_role_id: z.string().uuid().optional(),
  scope_user_id: z.string().uuid().optional(),
  purpose: z.enum(PURPOSES),
  model_id: z.string().uuid(),
  fallback_ids: z.array(z.string().uuid()).max(3).default([]),
  priority: z.number().int().min(1).max(999).default(100),
  quota: Quota.optional(),
  status: z.enum(['draft', 'active']).default('draft'),
  effective_from: isoDate.optional(),
  effective_to: isoDate.optional(),
  label: z.string().max(100).optional(),
});

const RoutePatch = z.object({
  model_id: z.string().uuid().optional(),
  fallback_ids: z.array(z.string().uuid()).max(3).optional(),
  priority: z.number().int().min(1).max(999).optional(),
  quota: Quota.optional(),
  status: z.enum(['draft', 'active', 'paused', 'retired']).optional(),
  effective_from: isoDate.nullable().optional(),
  effective_to: isoDate.nullable().optional(),
  label: z.string().max(100).nullable().optional(),
});

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

function assertScope(body: {
  scope_type: 'org' | 'role' | 'user';
  scope_role_id?: string | undefined;
  scope_user_id?: string | undefined;
}): void {
  const valid =
    (body.scope_type === 'org' && !body.scope_role_id && !body.scope_user_id) ||
    (body.scope_type === 'role' && body.scope_role_id && !body.scope_user_id) ||
    (body.scope_type === 'user' && body.scope_user_id && !body.scope_role_id);
  if (!valid) {
    throw new ApiError('validation_failed', 'scope_type 与 scope_role_id/scope_user_id 不匹配', {
      detail: { field: 'scope' },
    });
  }
}

function quotaData(quota: z.infer<typeof Quota> | undefined): Record<string, number | null> {
  if (!quota) return {};
  return {
    rpm: quota.rpm ?? null,
    tpm: quota.tpm ?? null,
    concurrency: quota.concurrency ?? null,
    dailyCalls: quota.daily_calls ?? null,
    dailyCostCents: quota.daily_cost_cents ?? null,
    monthlyCostCents: quota.monthly_cost_cents ?? null,
  };
}

async function assertModelsPublishable(
  app: FastifyInstance,
  orgId: number,
  modelIds: string[],
  purpose: (typeof PURPOSES)[number],
): Promise<void> {
  const models = await app.prisma.model.findMany({
    where: { orgId: BigInt(orgId), id: { in: modelIds }, archivedAt: null },
    select: {
      id: true,
      status: true,
      capability: true,
      purposeSupport: true,
    },
  });
  if (models.length !== new Set(modelIds).size) {
    throw new ApiError('model_not_published', 'Route 引用了不存在的模型', {
      detail: { model_ids: modelIds },
    });
  }
  const blockers: Array<{ model_id: string; reason: string }> = [];
  for (const model of models) {
    if (model.status !== 'published') blockers.push({ model_id: model.id, reason: 'not_published' });
    if (!CAPABILITY_PURPOSE[model.capability as Capability]?.has(purpose)) {
      blockers.push({ model_id: model.id, reason: 'capability_purpose_mismatch' });
    }
    if (!model.purposeSupport.includes(purpose)) {
      blockers.push({ model_id: model.id, reason: 'purpose_not_supported' });
    }
  }
  if (blockers.length > 0) {
    throw new ApiError('publish_blocked', 'Route 引用的模型未发布或用途不兼容', {
      detail: { blockers },
    });
  }
}

async function assertNoActiveConflict(
  app: FastifyInstance,
  input: {
    orgId: number;
    scopeType: 'org' | 'role' | 'user';
    scopeRoleId: string | null;
    scopeUserId: string | null;
    purpose: string;
    priority: number;
    excludeId?: string;
  },
): Promise<void> {
  const existing = await app.prisma.modelRoute.findFirst({
    where: {
      orgId: BigInt(input.orgId),
      status: 'active',
      archivedAt: null,
      purpose: input.purpose,
      priority: input.priority,
      scopeType: input.scopeType,
      ...(input.scopeType === 'role' ? { scopeRoleId: input.scopeRoleId } : {}),
      ...(input.scopeType === 'user' ? { scopeUserId: input.scopeUserId } : {}),
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError('conflict', '同一 scope/purpose/priority 已存在 active 路由', {
      detail: { conflicting_route_id: existing.id },
    });
  }
}

export function registerRouteConfigRoutes(app: FastifyInstance): void {
  app.get('/api/routes', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const query = z
      .object({
        purpose: z.enum(PURPOSES).optional(),
        scope_type: z.enum(['org', 'role', 'user']).optional(),
        status: z.enum(['draft', 'active', 'paused', 'retired']).optional(),
      })
      .parse(request.query ?? {});
    const routes = await app.prisma.modelRoute.findMany({
      where: {
        orgId: BigInt(principal.orgId),
        archivedAt: null,
        ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
        ...(query.scope_type === undefined ? {} : { scopeType: query.scope_type }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      orderBy: [{ purpose: 'asc' }, { priority: 'asc' }],
    });
    return ok(request, {
      items: routes.map((route) => ({
        id: route.id,
        scope_type: route.scopeType,
        scope_role_id: route.scopeRoleId,
        scope_user_id: route.scopeUserId,
        purpose: route.purpose,
        model_id: route.modelId,
        fallback_ids: route.fallbackIds,
        priority: route.priority,
        quota: {
          rpm: route.rpm,
          tpm: route.tpm,
          concurrency: route.concurrency,
          daily_calls: route.dailyCalls,
          daily_cost_cents: route.dailyCostCents,
          monthly_cost_cents: route.monthlyCostCents,
        },
        status: route.status,
        effective_from: route.effectiveFrom?.toISOString() ?? null,
        effective_to: route.effectiveTo?.toISOString() ?? null,
        label: route.label,
        version: route.version,
      })),
    });
  });

  app.post('/api/routes', { config: { minRole: 'admin' } }, async (request, reply) => {
    const principal = await principalFromRequest(app, request);
    const body = RouteCreate.parse(request.body ?? {});
    assertScope(body);
    if (body.fallback_ids.includes(body.model_id)) {
      throw new ApiError('validation_failed', 'model_id 不能出现在 fallback_ids', {
        detail: { field: 'fallback_ids' },
      });
    }
    if (body.scope_type === 'role' && body.scope_role_id) {
      const role = await app.prisma.role.findFirst({
        where: { id: body.scope_role_id, orgId: BigInt(principal.orgId), archivedAt: null },
        select: { id: true },
      });
      if (!role) throw new ApiError('validation_failed', 'scope_role_id 不存在', { detail: { field: 'scope_role_id' } });
    }
    if (body.scope_type === 'user' && body.scope_user_id) {
      const user = await app.prisma.user.findFirst({
        where: { id: body.scope_user_id, orgId: BigInt(principal.orgId), archivedAt: null },
        select: { id: true },
      });
      if (!user) throw new ApiError('validation_failed', 'scope_user_id 不存在', { detail: { field: 'scope_user_id' } });
    }
    const modelIds = [body.model_id, ...body.fallback_ids];
    // draft 路由允许先配置（引用模型发布状态在 publish 时由 assertModelsPublishable 把关）
    if (body.status === 'active') {
      await assertModelsPublishable(app, principal.orgId, modelIds, body.purpose);
      await assertNoActiveConflict(app, {
        orgId: principal.orgId,
        scopeType: body.scope_type,
        scopeRoleId: body.scope_role_id ?? null,
        scopeUserId: body.scope_user_id ?? null,
        purpose: body.purpose,
        priority: body.priority,
      });
    }

    let created;
    try {
      created = await app.prisma.modelRoute.create({
        data: {
          orgId: BigInt(principal.orgId),
          scopeType: body.scope_type,
          scopeRoleId: body.scope_role_id ?? null,
          scopeUserId: body.scope_user_id ?? null,
          purpose: body.purpose,
          modelId: body.model_id,
          fallbackIds: body.fallback_ids,
          priority: body.priority,
          ...quotaData(body.quota),
          status: body.status,
          effectiveFrom: body.effective_from ?? null,
          effectiveTo: body.effective_to ?? null,
          label: body.label ?? null,
          createdBy: principal.userId,
        },
        select: { id: true, version: true, status: true },
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        throw new ApiError('conflict', '同一 scope/purpose/priority 已存在 active 路由');
      }
      throw error;
    }

    await app.audit.record({
      action: body.status === 'active' ? 'route.publish' : 'route.create',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model_route',
      resourceId: created.id,
      after: { ...body },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    reply.code(201);
    return ok(request, {
      id: created.id,
      version: created.version,
      status: created.status,
      effective_from: body.effective_from?.toISOString() ?? null,
      effective_to: body.effective_to?.toISOString() ?? null,
    });
  });

  app.patch('/api/routes/:id', { config: { minRole: 'admin' } }, async (request) => {
    const principal = await principalFromRequest(app, request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = RoutePatch.parse(request.body ?? {});
    const expectedVersion = parseIfMatch(request);

    const before = await app.prisma.modelRoute.findFirst({
      where: { id: params.id, archivedAt: null },
    });
    if (!before) throw new ApiError('not_found', 'Route 不存在');
    if (before.version !== expectedVersion) {
      throw new ApiError('conflict', '版本冲突，请刷新后重试', {
        detail: { expected: expectedVersion, actual: before.version },
      });
    }

    const nextModelId = body.model_id ?? before.modelId;
    const nextFallbacks = body.fallback_ids ?? before.fallbackIds;
    if (nextFallbacks.includes(nextModelId)) {
      throw new ApiError('validation_failed', 'model_id 不能出现在 fallback_ids', {
        detail: { field: 'fallback_ids' },
      });
    }
    const nextStatus = body.status ?? before.status;
    if (nextStatus === 'active') {
      await assertModelsPublishable(
        app,
        principal.orgId,
        [nextModelId, ...nextFallbacks],
        before.purpose as (typeof PURPOSES)[number],
      );
      await assertNoActiveConflict(app, {
        orgId: principal.orgId,
        scopeType: before.scopeType as 'org' | 'role' | 'user',
        scopeRoleId: before.scopeRoleId,
        scopeUserId: before.scopeUserId,
        purpose: before.purpose,
        priority: body.priority ?? before.priority,
        excludeId: before.id,
      });
    }

    const result = await app.prisma.modelRoute.updateMany({
      where: { id: params.id, version: expectedVersion },
      data: {
        ...(body.model_id === undefined ? {} : { modelId: body.model_id }),
        ...(body.fallback_ids === undefined ? {} : { fallbackIds: body.fallback_ids }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...quotaData(body.quota),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.effective_from === undefined ? {} : { effectiveFrom: body.effective_from }),
        ...(body.effective_to === undefined ? {} : { effectiveTo: body.effective_to }),
        ...(body.label === undefined ? {} : { label: body.label }),
      },
    });
    if (result.count === 0) throw new ApiError('conflict', '版本冲突，请刷新后重试');

    const after = await app.prisma.modelRoute.findUniqueOrThrow({ where: { id: params.id } });
    await app.audit.record({
      action: body.status === 'active' && before.status !== 'active' ? 'route.publish' : 'route.update',
      actorType: 'user',
      actorId: principal.userId,
      requestId: request.requestId,
      resourceType: 'model_route',
      resourceId: params.id,
      before: {
        model_id: before.modelId,
        fallback_ids: before.fallbackIds,
        priority: before.priority,
        status: before.status,
      },
      after: {
        model_id: after.modelId,
        fallback_ids: after.fallbackIds,
        priority: after.priority,
        status: after.status,
        quota: {
          rpm: after.rpm,
          tpm: after.tpm,
          concurrency: after.concurrency,
          daily_calls: after.dailyCalls,
          daily_cost_cents: after.dailyCostCents,
          monthly_cost_cents: after.monthlyCostCents,
        },
      },
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: { actor_role: request.auth?.role ?? null },
    });
    request.auditLogged = true;
    return ok(request, { id: after.id, version: after.version, status: after.status });
  });
}
