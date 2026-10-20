/**
 * Registry 数据访问（Prisma 显式查询；schema 不声明 relation，禁止 include）。
 *
 * 一次路由解析把 route / model / provider / credential 分批查全，避免 N+1；
 * 本层只做「行 → 领域对象」映射，不做业务判定（判定在 policy.ts）。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import type {
  CallLogInput,
  Capability,
  CredentialRefRow,
  ModelRow,
  ModelStatus,
  Principal,
  ProviderKind,
  ProviderRow,
  ProviderStatus,
  Purpose,
  RouteRow,
  RouteStatus,
} from './types.js';
import { isPurpose } from './types.js';

export interface ModelBundle {
  model: ModelRow;
  provider: ProviderRow;
  credential: CredentialRefRow | null;
}

export interface RouteBundle extends ModelBundle {
  route: RouteRow;
}

export interface ModelFilters {
  q?: string;
  capability?: Capability;
  status?: ModelStatus;
  providerId?: string;
}

export interface RegistryRepo {
  loadRouteBundles(
    orgId: number,
    purpose: Purpose,
    principal: Principal,
    now: Date,
  ): Promise<RouteBundle[]>;
  loadAllRouteBundles(orgId: number, now: Date): Promise<RouteBundle[]>;
  loadModelBundle(modelId: string): Promise<ModelBundle | null>;
  getProviderBundle(
    providerId: string,
  ): Promise<{ provider: ProviderRow; credential: CredentialRefRow | null } | null>;
  listModels(orgId: number, filters: ModelFilters): Promise<ModelRow[]>;
  listProviders(orgId: number): Promise<ProviderRow[]>;
  logCall(input: CallLogInput): Promise<string>;
  countCallsSince(routeId: string, since: Date): Promise<number>;
  sumCostSince(routeId: string, since: Date): Promise<number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRateLimit(value: unknown): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'number') out[key] = raw;
  }
  return out;
}

function mapProvider(row: {
  id: string;
  orgId: bigint;
  name: string;
  kind: string;
  vendor: string;
  baseUrl: string | null;
  credentialRef: string;
  authScheme: string;
  timeoutMs: number;
  maxConcurrency: number;
  rateLimit: unknown;
  status: string;
  connectivity: string;
  lastCheckAt: Date | null;
  lastCheckLatencyMs: number | null;
  lastErrorCode: string | null;
  balanceCents: number | null;
  region: string | null;
  extra: unknown;
  version: number;
}): ProviderRow {
  return {
    id: row.id,
    orgId: Number(row.orgId),
    name: row.name,
    kind: row.kind as ProviderKind,
    vendor: row.vendor,
    baseUrl: row.baseUrl,
    credentialRef: row.credentialRef,
    authScheme: row.authScheme,
    timeoutMs: row.timeoutMs,
    maxConcurrency: row.maxConcurrency,
    rateLimit: asRateLimit(row.rateLimit),
    status: row.status as ProviderStatus,
    connectivity: row.connectivity as ProviderRow['connectivity'],
    lastCheckAt: row.lastCheckAt,
    lastCheckLatencyMs: row.lastCheckLatencyMs,
    lastErrorCode: row.lastErrorCode,
    balanceCents: row.balanceCents,
    region: row.region,
    extra: asRecord(row.extra),
    version: row.version,
  };
}

function mapModel(row: {
  id: string;
  orgId: bigint;
  providerId: string;
  name: string;
  externalModelId: string;
  displayName: string;
  capability: string;
  purposeSupport: string[];
  paramsSchema: unknown;
  defaultParams: unknown;
  price: unknown;
  priceVersion: number;
  rateLimit: unknown;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  embedDim: number | null;
  status: string;
  publishedAt: Date | null;
  publishedBy: string | null;
  sunsetAt: Date | null;
  version: number;
}): ModelRow {
  return {
    id: row.id,
    orgId: Number(row.orgId),
    providerId: row.providerId,
    name: row.name,
    externalModelId: row.externalModelId,
    displayName: row.displayName,
    capability: row.capability as Capability,
    purposeSupport: row.purposeSupport.filter(isPurpose),
    paramsSchema: asRecord(row.paramsSchema),
    defaultParams: asRecord(row.defaultParams),
    price: asRecord(row.price) as ModelRow['price'],
    priceVersion: row.priceVersion,
    rateLimit: asRateLimit(row.rateLimit),
    contextTokens: row.contextTokens,
    maxOutputTokens: row.maxOutputTokens,
    embedDim: row.embedDim,
    status: row.status as ModelStatus,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
    sunsetAt: row.sunsetAt,
    version: row.version,
  };
}

function mapRoute(row: {
  id: string;
  orgId: bigint;
  scopeType: string;
  scopeRoleId: string | null;
  scopeUserId: string | null;
  purpose: string;
  modelId: string;
  fallbackIds: string[];
  priority: number;
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
  dailyCalls: number | null;
  dailyCostCents: number | null;
  monthlyCostCents: number | null;
  status: string;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  label: string | null;
  version: number;
  updatedAt: Date;
}): RouteRow {
  return {
    id: row.id,
    orgId: Number(row.orgId),
    scopeType: row.scopeType as RouteRow['scopeType'],
    scopeRoleId: row.scopeRoleId,
    scopeUserId: row.scopeUserId,
    purpose: row.purpose as Purpose,
    modelId: row.modelId,
    fallbackIds: row.fallbackIds,
    priority: row.priority,
    rpm: row.rpm,
    tpm: row.tpm,
    concurrency: row.concurrency,
    dailyCalls: row.dailyCalls,
    dailyCostCents: row.dailyCostCents,
    monthlyCostCents: row.monthlyCostCents,
    status: row.status as RouteStatus,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    label: row.label,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

function mapCredential(row: { id: string; name: string; status: string }): CredentialRefRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status as CredentialRefRow['status'],
  };
}

export class PrismaRegistryRepo implements RegistryRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async loadRouteBundles(
    orgId: number,
    purpose: Purpose,
    principal: Principal,
    now: Date,
  ): Promise<RouteBundle[]> {
    const scopeOr: Prisma.ModelRouteWhereInput[] = [
      { scopeType: 'org' },
      { scopeType: 'user', scopeUserId: principal.userId },
    ];
    if (principal.roleIds.length > 0) {
      scopeOr.push({ scopeType: 'role', scopeRoleId: { in: principal.roleIds } });
    }
    const routes = await this.prisma.modelRoute.findMany({
      where: {
        orgId: BigInt(orgId),
        purpose,
        status: 'active',
        archivedAt: null,
        OR: scopeOr,
      },
    });
    const inWindow = routes.filter((route) => {
      if (route.effectiveFrom && route.effectiveFrom > now) return false;
      if (route.effectiveTo && now >= route.effectiveTo) return false;
      return true;
    });
    if (inWindow.length === 0) return [];

    const bundles = await this.hydrateRoutes(inWindow);
    return bundles.sort((a, b) => compareRouteRows(a.route, b.route));
  }

  async loadAllRouteBundles(orgId: number, now: Date): Promise<RouteBundle[]> {
    const routes = await this.prisma.modelRoute.findMany({
      where: { orgId: BigInt(orgId), status: 'active', archivedAt: null },
    });
    const inWindow = routes.filter((route) => {
      if (route.effectiveFrom && route.effectiveFrom > now) return false;
      if (route.effectiveTo && now >= route.effectiveTo) return false;
      return true;
    });
    if (inWindow.length === 0) return [];
    return (await this.hydrateRoutes(inWindow)).sort((a, b) => compareRouteRows(a.route, b.route));
  }

  private async hydrateRoutes(
    routes: Array<Parameters<typeof mapRoute>[0]>,
  ): Promise<RouteBundle[]> {
    const modelIds = new Set<string>();
    for (const route of routes) {
      modelIds.add(route.modelId);
      for (const fallback of route.fallbackIds) modelIds.add(fallback);
    }
    const models = await this.prisma.model.findMany({
      where: { id: { in: [...modelIds] }, archivedAt: null },
    });
    const modelMap = new Map(models.map((row) => [row.id, mapModel(row)]));
    const providerIds = [...new Set(models.map((row) => row.providerId))];
    const providers = await this.prisma.provider.findMany({
      where: { id: { in: providerIds }, archivedAt: null },
    });
    const providerMap = new Map(providers.map((row) => [row.id, mapProvider(row)]));
    const credentialNames = [...new Set(providers.map((row) => row.credentialRef))];
    const credentials = await this.prisma.credentialRef.findMany({
      where: { name: { in: credentialNames }, archivedAt: null },
      select: { id: true, name: true, status: true },
    });
    const credentialMap = new Map(credentials.map((row) => [row.name, mapCredential(row)]));

    const out: RouteBundle[] = [];
    for (const row of routes) {
      const route = mapRoute(row);
      const model = modelMap.get(route.modelId);
      if (!model) continue;
      const provider = providerMap.get(model.providerId);
      if (!provider) continue;
      out.push({
        route,
        model,
        provider,
        credential: credentialMap.get(provider.credentialRef) ?? null,
      });
    }
    return out;
  }

  async loadModelBundle(modelId: string): Promise<ModelBundle | null> {
    const modelRow = await this.prisma.model.findFirst({
      where: { id: modelId, archivedAt: null },
    });
    if (!modelRow) return null;
    const providerRow = await this.prisma.provider.findFirst({
      where: { id: modelRow.providerId, archivedAt: null },
    });
    if (!providerRow) return null;
    const credential = await this.prisma.credentialRef.findFirst({
      where: { name: providerRow.credentialRef, archivedAt: null },
      select: { id: true, name: true, status: true },
    });
    return {
      model: mapModel(modelRow),
      provider: mapProvider(providerRow),
      credential: credential ? mapCredential(credential) : null,
    };
  }

  async getProviderBundle(
    providerId: string,
  ): Promise<{ provider: ProviderRow; credential: CredentialRefRow | null } | null> {
    const row = await this.prisma.provider.findFirst({
      where: { id: providerId, archivedAt: null },
    });
    if (!row) return null;
    const credential = await this.prisma.credentialRef.findFirst({
      where: { name: row.credentialRef, archivedAt: null },
      select: { id: true, name: true, status: true },
    });
    return {
      provider: mapProvider(row),
      credential: credential ? mapCredential(credential) : null,
    };
  }

  async listModels(orgId: number, filters: ModelFilters): Promise<ModelRow[]> {
    const where: Prisma.ModelWhereInput = { orgId: BigInt(orgId), archivedAt: null };
    if (filters.capability) where.capability = filters.capability;
    if (filters.status) where.status = filters.status;
    if (filters.providerId) where.providerId = filters.providerId;
    if (filters.q) {
      where.OR = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { displayName: { contains: filters.q, mode: 'insensitive' } },
        { externalModelId: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.model.findMany({ where, orderBy: { name: 'asc' } });
    return rows.map(mapModel);
  }

  async listProviders(orgId: number): Promise<ProviderRow[]> {
    const rows = await this.prisma.provider.findMany({
      where: { orgId: BigInt(orgId), archivedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(mapProvider);
  }

  async logCall(input: CallLogInput): Promise<string> {
    const usage = input.usage;
    const created = await this.prisma.modelCallLog.create({
      data: {
        orgId: BigInt(input.orgId),
        requestId: input.requestId,
        purpose: input.purpose,
        providerId: input.providerId,
        modelId: input.modelId,
        routeId: input.routeId,
        fallbackFromModelId: input.fallbackFromModelId,
        actorType: input.actorType,
        actorId: input.actorId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        promptVersion: input.promptVersion,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        imageCount: usage.imageCount ?? 0,
        imagePixels:
          usage.imagePixels === undefined ? null : BigInt(Math.trunc(usage.imagePixels)),
        videoSeconds: usage.videoSeconds ?? 0,
        latencyMs: input.latencyMs,
        status: input.status,
        errorCode: input.errorCode,
        costCents: input.costCents,
        priceSnapshot: input.priceSnapshot as unknown as Prisma.InputJsonValue,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
      },
      select: { id: true },
    });
    return created.id;
  }

  async countCallsSince(routeId: string, since: Date): Promise<number> {
    return this.prisma.modelCallLog.count({
      where: {
        routeId,
        startedAt: { gte: since },
        status: { not: 'quota_rejected' },
      },
    });
  }

  async sumCostSince(routeId: string, since: Date): Promise<number> {
    const aggregate = await this.prisma.modelCallLog.aggregate({
      where: {
        routeId,
        startedAt: { gte: since },
        status: { not: 'quota_rejected' },
      },
      _sum: { costCents: true },
    });
    return aggregate._sum.costCents ?? 0;
  }
}

function compareRouteRows(a: RouteRow, b: RouteRow): number {
  const rankA = a.scopeType === 'user' ? 0 : a.scopeType === 'role' ? 1 : 2;
  const rankB = b.scopeType === 'user' ? 0 : b.scopeType === 'role' ? 1 : 2;
  if (rankA !== rankB) return rankA - rankB;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}
