/**
 * 模型网关（docs/07 核心）：可见性 → 路由 → 熔断 → 配额 → 调用 → 计量/记账 → 降级。
 *
 * 调用方只传 purpose；永远不直接指定 model_id（docs/07 §0）。
 * 本类只依赖 RegistryRepo / adapter / quota / breaker 接口，便于单测与替换。
 */
import type { AdapterFactory, AdapterInvokeRequest, AdapterResponse } from './adapters.js';
import { AdapterError } from './adapters.js';
import type { AuditSink } from './audit.js';
import { CircuitBreaker } from './breaker.js';
import type { CredentialResolver } from './credentials.js';
import { computeCostCents, estimateCostCents } from './metering.js';
import { validateAgainstSchema, validateModelParams } from './params.js';
import { checkVisibility, minLimits, quotaLimitsOfRoute, roleAllowsPurpose } from './policy.js';
import type { QuotaService } from './quota.js';
import type {
  CallLogInput,
  CredentialRefRow,
  ModelRow,
  Principal,
  Purpose,
  RouteRow,
  UsageActual,
  UsageEstimate,
} from './types.js';

export type GatewayErrorCode =
  | 'no_route'
  | 'route_exhausted'
  | 'quota_exceeded'
  | 'provider_unavailable'
  | 'model_not_published'
  | 'role_forbidden'
  | 'model_purpose_mismatch'
  | 'invalid_request'
  | 'schema_invalid';

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'GatewayError';
  }
}

export interface RegistryRepoLike {
  loadRouteBundles(
    orgId: number,
    purpose: Purpose,
    principal: Principal,
    now: Date,
  ): Promise<
    Array<{
      route: RouteRow;
      model: ModelRow;
      provider: Parameters<AdapterFactory>[0];
      credential: CredentialRefRow | null;
    }>
  >;
  loadAllRouteBundles(
    orgId: number,
    now: Date,
  ): Promise<
    Array<{
      route: RouteRow;
      model: ModelRow;
      provider: Parameters<AdapterFactory>[0];
      credential: CredentialRefRow | null;
    }>
  >;
  loadModelBundle(modelId: string): Promise<{
    model: ModelRow;
    provider: Parameters<AdapterFactory>[0];
    credential: CredentialRefRow | null;
  } | null>;
  getProviderBundle(providerId: string): Promise<{
    provider: Parameters<AdapterFactory>[0];
    credential: CredentialRefRow | null;
  } | null>;
  listModels(
    orgId: number,
    filters: { q?: string; capability?: ModelRow['capability']; status?: ModelRow['status']; providerId?: string },
  ): Promise<ModelRow[]>;
  logCall(input: CallLogInput): Promise<string>;
}

export interface InvokeInput {
  principal: Principal;
  purpose: Purpose;
  requestId: string;
  actorType: 'user' | 'agent' | 'worker' | 'system';
  actorId: string | null;
  subjectType?: string;
  subjectId?: string | null;
  promptVersion?: string | null;
  params?: Record<string, unknown>;
  estimate: UsageEstimate;
}

export interface InvokeResult {
  decision: {
    routeId: string;
    modelId: string;
    providerId: string;
    degraded: boolean;
    fallbackFrom?: string;
    reason: 'primary' | 'fallback' | 'quota_fallback';
  };
  response: AdapterResponse;
  usage: UsageActual;
  costCents: number;
  latencyMs: number;
  callLogId: string;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
  callLogId?: string;
  response?: AdapterResponse;
}

export interface VisibleModel {
  model: ModelRow;
  route: RouteRow | null;
  visible: boolean;
  reason?: string;
}

export interface GatewayDeps {
  repo: RegistryRepoLike;
  adapterFactory: AdapterFactory;
  quota: QuotaService;
  breaker: CircuitBreaker;
  credentials: CredentialResolver;
  audit?: AuditSink;
  now?: () => Date;
}

function mergeParams(
  defaults: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...defaults, ...(overrides ?? {}) };
}

function asErrorCode(error: unknown): { code: string; retryable: boolean; timeout: boolean } {
  if (error instanceof AdapterError) {
    return { code: error.code, retryable: error.retryable, timeout: error.code === 'timeout' };
  }
  return { code: 'upstream_error', retryable: true, timeout: false };
}

function mapVisibilityCode(code: string): GatewayErrorCode {
  switch (code) {
    case 'provider_unavailable':
      return 'provider_unavailable';
    case 'model_not_published':
      return 'model_not_published';
    case 'role_forbidden':
      return 'role_forbidden';
    case 'model_purpose_mismatch':
      return 'model_purpose_mismatch';
    default:
      return 'no_route';
  }
}

export class ModelGateway {
  constructor(private readonly deps: GatewayDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** 前台可见模型：四条判定；admin 可要求带不可见原因。 */
  async listModels(
    principal: Principal,
    options: {
      purpose?: Purpose;
      q?: string;
      capability?: ModelRow['capability'];
      status?: ModelRow['status'];
      providerId?: string;
      includeInvisible?: boolean;
    } = {},
  ): Promise<VisibleModel[]> {
    const now = this.now();
    const bundles = options.purpose
      ? await this.deps.repo.loadRouteBundles(principal.orgId, options.purpose, principal, now)
      : await this.deps.repo.loadAllRouteBundles(principal.orgId, now);

    const byModel = new Map<string, VisibleModel>();
    const consider = (bundle: (typeof bundles)[number]): void => {
      const existing = byModel.get(bundle.model.id);
      const visibility = checkVisibility({
        provider: bundle.provider,
        credential: bundle.credential,
        model: bundle.model,
        route: bundle.route,
        principal,
        now,
      });
      const candidate: VisibleModel = {
        model: bundle.model,
        route: bundle.route,
        visible: visibility.visible,
        ...(visibility.code ? { reason: visibility.code } : {}),
      };
      if (!existing || (!existing.visible && candidate.visible)) {
        byModel.set(bundle.model.id, candidate);
      }
    };
    for (const bundle of bundles) consider(bundle);

    if (options.includeInvisible) {
      const models = await this.deps.repo.listModels(principal.orgId, {
        ...(options.q === undefined ? {} : { q: options.q }),
        ...(options.capability === undefined ? {} : { capability: options.capability }),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
      });
      for (const model of models) {
        if (!byModel.has(model.id)) {
          byModel.set(model.id, { model, route: null, visible: false, reason: 'no_route' });
        }
      }
    }

    let result = [...byModel.values()];
    if (!options.includeInvisible) result = result.filter((item) => item.visible);
    if (options.q) {
      const q = options.q.toLowerCase();
      result = result.filter(
        (item) =>
          item.model.name.toLowerCase().includes(q) ||
          item.model.displayName.toLowerCase().includes(q) ||
          item.model.externalModelId.toLowerCase().includes(q),
      );
    }
    if (options.capability) result = result.filter((item) => item.model.capability === options.capability);
    if (options.status) result = result.filter((item) => item.model.status === options.status);
    if (options.providerId) result = result.filter((item) => item.model.providerId === options.providerId);
    return result.sort((a, b) => a.model.name.localeCompare(b.model.name));
  }

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const now = this.now();
    if (!roleAllowsPurpose(input.principal.roles, input.purpose)) {
      throw new GatewayError('role_forbidden', { purpose: input.purpose });
    }

    const routes = await this.deps.repo.loadRouteBundles(
      input.principal.orgId,
      input.purpose,
      input.principal,
      now,
    );
    if (routes.length === 0) throw new GatewayError('no_route', { purpose: input.purpose });

    let lastError: GatewayErrorCode = 'route_exhausted';
    let quotaFailedOnAny = false;

    for (const bundle of routes) {
      const routeVisibility = checkVisibility({
        provider: bundle.provider,
        credential: bundle.credential,
        model: bundle.model,
        route: bundle.route,
        principal: input.principal,
        now,
      });
      if (!routeVisibility.visible) {
        lastError = mapVisibilityCode(routeVisibility.code ?? 'no_route');
        continue;
      }

      const candidateIds = [bundle.model.id, ...bundle.route.fallbackIds];
      const maxCandidates =
        input.purpose === 'embed' ? 1 : input.purpose === 'judge' ? 2 : 4;
      let primaryEstimate: number | null = null;
      let primaryQuotaFailed = false;

      for (let idx = 0; idx < candidateIds.length && idx < maxCandidates; idx += 1) {
        const modelId = candidateIds[idx]!;
        const modelBundle =
          idx === 0
            ? { model: bundle.model, provider: bundle.provider, credential: bundle.credential }
            : await this.deps.repo.loadModelBundle(modelId);
        if (!modelBundle) continue;

        const candidateVisibility = checkVisibility({
          provider: modelBundle.provider,
          credential: modelBundle.credential,
          model: modelBundle.model,
          route: bundle.route,
          principal: input.principal,
          now,
        });
        if (!candidateVisibility.visible) {
          lastError = mapVisibilityCode(candidateVisibility.code ?? 'no_route');
          continue;
        }

        const breakerKey = `${modelBundle.model.id}:${modelBundle.model.version}`;
        if (this.deps.breaker.isOpen(breakerKey)) {
          lastError = 'route_exhausted';
          continue;
        }

        const estimatedCost = estimateCostCents(
          modelBundle.model.price,
          modelBundle.model.capability,
          input.estimate,
        );
        if (idx === 0) primaryEstimate = estimatedCost;
        // 配额降级只允许到「不更贵」的候选（docs/07 §6.1）
        if (
          idx > 0 &&
          primaryQuotaFailed &&
          primaryEstimate !== null &&
          estimatedCost > primaryEstimate
        ) {
          continue;
        }

        const limits = minLimits(
          quotaLimitsOfRoute(bundle.route),
          modelBundle.model.rateLimit,
          modelBundle.provider.rateLimit,
        );
        const reservation = await this.deps.quota.reserve({
          routeId: bundle.route.id,
          limits,
          tokensEstimated: (input.estimate.tokensIn ?? 0) + (input.estimate.tokensOut ?? 0),
          costEstimatedCents: estimatedCost,
          now,
        });
        if (!reservation.ok) {
          if (idx === 0) primaryQuotaFailed = true;
          quotaFailedOnAny = true;
          lastError = 'quota_exceeded';
          continue;
        }

        const params = mergeParams(modelBundle.model.defaultParams, input.params);
        const schemaCheck = validateAgainstSchema(
          modelBundle.model.paramsSchema,
          params,
          `${modelBundle.model.id}:${modelBundle.model.version}`,
        );
        if (!schemaCheck.ok) {
          reservation.release();
          throw new GatewayError('invalid_request', { errors: schemaCheck.errors });
        }

        const adapter = this.deps.adapterFactory(modelBundle.provider);
        const credential = this.deps.credentials.resolve(modelBundle.provider.credentialRef);
        const startedAt = new Date();
        const startedMs = Date.now();
        const adapterRequest: AdapterInvokeRequest = {
          purpose: input.purpose,
          model: modelBundle.model,
          provider: modelBundle.provider,
          params,
          credential,
          timeoutMs: modelBundle.provider.timeoutMs,
        };

        try {
          const response = await adapter.invoke(adapterRequest);
          const latencyMs = Math.max(0, Date.now() - startedMs);
          const usage: UsageActual = {
            ...response.usage,
            tokensSource: response.usage?.tokensSource ?? 'estimated',
          };
          const costCents = computeCostCents(modelBundle.model.price, modelBundle.model.capability, usage);
          const callLogId = await this.deps.repo.logCall({
            orgId: input.principal.orgId,
            requestId: input.requestId,
            purpose: input.purpose,
            providerId: modelBundle.provider.id,
            modelId: modelBundle.model.id,
            routeId: bundle.route.id,
            fallbackFromModelId: idx > 0 ? bundle.model.id : null,
            actorType: input.actorType,
            actorId: input.actorId,
            subjectType: input.subjectType ?? 'other',
            subjectId: input.subjectId ?? null,
            promptVersion: input.promptVersion ?? null,
            usage,
            latencyMs,
            status: 'succeeded',
            errorCode: null,
            costCents,
            priceSnapshot: modelBundle.model.price as unknown as Record<string, unknown>,
            startedAt,
            finishedAt: new Date(),
          });
          this.deps.breaker.recordSuccess(breakerKey);
          if (idx > 0) {
            await this.safeAudit({
              action: 'model.fallback',
              actorType: input.actorType,
              actorId: input.actorId,
              requestId: input.requestId,
              resourceType: 'model',
              resourceId: modelBundle.model.id,
              after: {
                route_id: bundle.route.id,
                from_model_id: bundle.model.id,
                to_model_id: modelBundle.model.id,
                purpose: input.purpose,
              },
            });
          }
          return {
            decision: {
              routeId: bundle.route.id,
              modelId: modelBundle.model.id,
              providerId: modelBundle.provider.id,
              degraded: idx > 0,
              ...(idx > 0 ? { fallbackFrom: bundle.model.id } : {}),
              reason: idx > 0 ? (primaryQuotaFailed ? 'quota_fallback' : 'fallback') : 'primary',
            },
            response,
            usage,
            costCents,
            latencyMs,
            callLogId,
          };
        } catch (error) {
          const classified = asErrorCode(error);
          const latencyMs = Math.max(0, Date.now() - startedMs);
          await this.deps.repo.logCall({
            orgId: input.principal.orgId,
            requestId: input.requestId,
            purpose: input.purpose,
            providerId: modelBundle.provider.id,
            modelId: modelBundle.model.id,
            routeId: bundle.route.id,
            fallbackFromModelId: idx > 0 ? bundle.model.id : null,
            actorType: input.actorType,
            actorId: input.actorId,
            subjectType: input.subjectType ?? 'other',
            subjectId: input.subjectId ?? null,
            promptVersion: input.promptVersion ?? null,
            usage: { tokensSource: 'estimated' },
            latencyMs,
            status: classified.timeout ? 'timeout' : 'failed',
            errorCode: classified.code,
            costCents: 0,
            priceSnapshot: modelBundle.model.price as unknown as Record<string, unknown>,
            startedAt,
            finishedAt: new Date(),
          });
          this.deps.breaker.recordFailure(
            breakerKey,
            classified.timeout ? 'timeout' : 'error',
          );

          if (!classified.retryable) {
            throw new GatewayError(
              classified.code === 'provider_unavailable' || classified.code === 'model_not_found'
                ? 'provider_unavailable'
                : 'invalid_request',
              { model_id: modelBundle.model.id, error_code: classified.code },
            );
          }
          lastError =
            classified.code === 'rate_limited' || classified.code === 'upstream_5xx'
              ? 'route_exhausted'
              : lastError;
          continue;
        } finally {
          reservation.release();
        }
      }
    }

    throw new GatewayError(quotaFailedOnAny ? 'quota_exceeded' : lastError, {
      purpose: input.purpose,
    });
  }

  /** 连通性测试（不写库；API 层更新 provider 状态并审计）。 */
  async probeProvider(providerId: string): Promise<{
    provider: Parameters<AdapterFactory>[0];
    credential: CredentialRefRow | null;
    ok: boolean;
    latencyMs: number;
    errorCode?: string;
  }> {
    const bundle = await this.deps.repo.getProviderBundle(providerId);
    if (!bundle) throw new GatewayError('provider_unavailable', { provider_id: providerId });
    const adapter = this.deps.adapterFactory(bundle.provider);
    const credential = this.deps.credentials.resolve(bundle.provider.credentialRef);
    const result = await adapter.test(bundle.provider, credential);
    return {
      provider: bundle.provider,
      credential: bundle.credential,
      ok: result.ok,
      latencyMs: result.latencyMs,
      ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    };
  }

  /** 模型最小真实调用（允许 draft/testing；写 model_call_log，route_id 为空，费用 0）。 */
  async probeModel(
    modelId: string,
    context: {
      requestId: string;
      actorType: 'user' | 'agent' | 'worker' | 'system';
      actorId: string | null;
    },
  ): Promise<TestResult> {
    const bundle = await this.deps.repo.loadModelBundle(modelId);
    if (!bundle) throw new GatewayError('model_not_published', { model_id: modelId });
    const paramsCheck = validateModelParams(bundle.model);
    if (!paramsCheck.ok) {
      throw new GatewayError('invalid_request', { errors: paramsCheck.errors });
    }
    const adapter = this.deps.adapterFactory(bundle.provider);
    const credential = this.deps.credentials.resolve(bundle.provider.credentialRef);
    const startedAt = new Date();
    const startedMs = Date.now();
    try {
      const response = await adapter.invoke({
        purpose: bundle.model.purposeSupport[0] ?? 'copy',
        model: bundle.model,
        provider: bundle.provider,
        params: bundle.model.defaultParams,
        credential,
        timeoutMs: bundle.provider.timeoutMs,
      });
      const latencyMs = Math.max(0, Date.now() - startedMs);
      const callLogId = await this.deps.repo.logCall({
        orgId: bundle.model.orgId,
        requestId: context.requestId,
        purpose: bundle.model.purposeSupport[0] ?? 'copy',
        providerId: bundle.provider.id,
        modelId: bundle.model.id,
        routeId: null,
        fallbackFromModelId: null,
        actorType: context.actorType,
        actorId: context.actorId,
        subjectType: 'other',
        subjectId: null,
        promptVersion: 'model_test',
        usage: { ...response.usage, tokensSource: response.usage?.tokensSource ?? 'estimated' },
        latencyMs,
        status: 'succeeded',
        errorCode: null,
        costCents: 0,
        priceSnapshot: bundle.model.price as unknown as Record<string, unknown>,
        startedAt,
        finishedAt: new Date(),
      });
      return { ok: true, latencyMs, callLogId, response };
    } catch (error) {
      const classified = asErrorCode(error);
      const latencyMs = Math.max(0, Date.now() - startedMs);
      const callLogId = await this.deps.repo.logCall({
        orgId: bundle.model.orgId,
        requestId: context.requestId,
        purpose: bundle.model.purposeSupport[0] ?? 'copy',
        providerId: bundle.provider.id,
        modelId: bundle.model.id,
        routeId: null,
        fallbackFromModelId: null,
        actorType: context.actorType,
        actorId: context.actorId,
        subjectType: 'other',
        subjectId: null,
        promptVersion: 'model_test',
        usage: { tokensSource: 'estimated' },
        latencyMs,
        status: classified.timeout ? 'timeout' : 'failed',
        errorCode: classified.code,
        costCents: 0,
        priceSnapshot: bundle.model.price as unknown as Record<string, unknown>,
        startedAt,
        finishedAt: new Date(),
      });
      return { ok: false, latencyMs, errorCode: classified.code, callLogId };
    }
  }

  private async safeAudit(input: Parameters<AuditSink['record']>[0]): Promise<void> {
    try {
      await this.deps.audit?.record(input);
    } catch {
      // 降级审计失败不阻断已成功的调用；API 层另有通用写审计兜底。
    }
  }
}
