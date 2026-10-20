/**
 * 可见性四条判定 + 角色 × 用途矩阵（docs/07 §4）。
 * 纯函数，不读写数据库；调用方负责把行数据查全。
 */
import type {
  Capability,
  CredentialRefRow,
  ModelRow,
  Principal,
  ProviderRow,
  Purpose,
  QuotaLimits,
  Role,
  RouteRow,
  VisibilityResult,
} from './types.js';
import { validateModelParams } from './params.js';

const ROLE_PURPOSE: Record<Role, ReadonlySet<Purpose>> = {
  viewer: new Set([]),
  operator: new Set(['copy', 'judge', 'image', 'video']),
  admin: new Set(['copy', 'judge', 'image', 'video', 'embed', 'rerank']),
};

export const CAPABILITY_PURPOSE: Record<Capability, ReadonlySet<Purpose>> = {
  text: new Set(['copy', 'judge', 'rerank']),
  image: new Set(['image']),
  video: new Set(['video']),
  embedding: new Set(['embed']),
  rerank: new Set(['rerank']),
};

export interface VisibilityContext {
  provider: ProviderRow;
  credential: CredentialRefRow | null;
  model: ModelRow;
  route: RouteRow;
  principal: Principal;
  now: Date;
}

export function roleAllowsPurpose(roles: Role[], purpose: Purpose): boolean {
  return roles.some((role) => ROLE_PURPOSE[role].has(purpose));
}

/** 角色可用的 purpose 集合（admin 继承 operator 并多 embed/rerank）。 */
export function allowedPurposes(roles: Role[]): Purpose[] {
  const out = new Set<Purpose>();
  for (const role of roles) {
    for (const purpose of ROLE_PURPOSE[role]) out.add(purpose);
  }
  return [...out];
}

export function scopeRank(route: RouteRow): number {
  return route.scopeType === 'user' ? 0 : route.scopeType === 'role' ? 1 : 2;
}

export function routeInWindow(route: RouteRow, now: Date): boolean {
  if (route.effectiveFrom && route.effectiveFrom > now) return false;
  if (route.effectiveTo && now >= route.effectiveTo) return false;
  return true;
}

export function scopeMatches(route: RouteRow, principal: Principal): boolean {
  if (route.scopeType === 'org') return true;
  if (route.scopeType === 'user') return route.scopeUserId === principal.userId;
  return route.scopeRoleId !== null && principal.roleIds.includes(route.scopeRoleId);
}

/** docs/07 §4.1 的 checkVisibility：四条规则 + capability/purpose 一致性。 */
export function checkVisibility(ctx: VisibilityContext): VisibilityResult {
  const { provider, credential, model, route, principal, now } = ctx;

  // R1 凭据可用且连通
  if (!provider.credentialRef) return { visible: false, code: 'provider_unavailable' };
  if (!credential || credential.status !== 'active') {
    return { visible: false, code: 'provider_unavailable' };
  }
  if (provider.status !== 'active' || provider.connectivity !== 'ok') {
    return { visible: false, code: 'provider_unavailable' };
  }

  // R2 模型已发布且参数合法
  if (model.status !== 'published') return { visible: false, code: 'model_not_published' };
  if (!model.publishedAt || model.publishedAt > now) {
    return { visible: false, code: 'model_not_published' };
  }
  if (!validateModelParams(model).ok) return { visible: false, code: 'model_not_published' };

  // R3 路由命中 scope 且生效窗口覆盖当前时刻
  if (route.status !== 'active' || !routeInWindow(route, now) || !scopeMatches(route, principal)) {
    return { visible: false, code: 'no_route' };
  }

  // R4 角色 × 用途
  if (!roleAllowsPurpose(principal.roles, route.purpose)) {
    return { visible: false, code: 'role_forbidden' };
  }

  // 附加一致性：capability 与 purpose 兼容，且 model 声明了该 purpose
  if (!CAPABILITY_PURPOSE[model.capability].has(route.purpose)) {
    return { visible: false, code: 'model_purpose_mismatch' };
  }
  if (!model.purposeSupport.includes(route.purpose)) {
    return { visible: false, code: 'model_purpose_mismatch' };
  }

  return { visible: true };
}

/** 路由排序：scope 精度 > priority 升序 > updated_at 降序（docs/07 §5.2）。 */
export function compareRoutes(a: RouteRow, b: RouteRow): number {
  const rank = scopeRank(a) - scopeRank(b);
  if (rank !== 0) return rank;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

export function quotaLimitsOfRoute(route: RouteRow): {
  rpm?: number;
  tpm?: number;
  concurrency?: number;
  dailyCalls?: number;
  dailyCostCents?: number;
  monthlyCostCents?: number;
} {
  return {
    ...(route.rpm === null ? {} : { rpm: route.rpm }),
    ...(route.tpm === null ? {} : { tpm: route.tpm }),
    ...(route.concurrency === null ? {} : { concurrency: route.concurrency }),
    ...(route.dailyCalls === null ? {} : { dailyCalls: route.dailyCalls }),
    ...(route.dailyCostCents === null ? {} : { dailyCostCents: route.dailyCostCents }),
    ...(route.monthlyCostCents === null ? {} : { monthlyCostCents: route.monthlyCostCents }),
  };
}

/** 三层配额取严：定义的键取最小值，未定义的键不限制。兼容 camelCase 与 snake_case 键。 */
export function minLimits(...layers: Array<Record<string, number | undefined>>): QuotaLimits {
  const definitions: Array<[keyof QuotaLimits, string[]]> = [
    ['rpm', ['rpm']],
    ['tpm', ['tpm']],
    ['concurrency', ['concurrency']],
    ['dailyCalls', ['dailyCalls', 'daily_calls']],
    ['dailyCostCents', ['dailyCostCents', 'daily_cost_cents']],
    ['monthlyCostCents', ['monthlyCostCents', 'monthly_cost_cents']],
  ];
  const out: QuotaLimits = {};
  for (const [target, aliases] of definitions) {
    const values = layers
      .flatMap((layer) => aliases.map((key) => layer[key]))
      .filter((value): value is number => typeof value === 'number');
    if (values.length > 0) out[target] = Math.min(...values);
  }
  return out;
}
