/** 模型网关的类型与词表（docs/07 §2–§7）。 */
export const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;
export type Purpose = (typeof PURPOSES)[number];

export const CAPABILITIES = ['text', 'image', 'video', 'embedding', 'rerank'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PROVIDER_KINDS = ['text', 'image', 'video', 'embedding'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type Role = 'viewer' | 'operator' | 'admin';
export type ProviderStatus = 'configuring' | 'active' | 'degraded' | 'disabled';
export type ModelStatus = 'draft' | 'testing' | 'published' | 'suspended' | 'archived';
export type RouteStatus = 'draft' | 'active' | 'paused' | 'retired';
export type Connectivity = 'unknown' | 'ok' | 'failed';

export interface PriceBook {
  text?: { input_per_1k_cents?: number; output_per_1k_cents?: number };
  image?: { per_image_cents?: number; per_megapixel_cents?: number };
  video?: { per_second_cents?: number };
  embed?: { per_1k_tokens_cents?: number };
}

export interface ProviderRow {
  id: string;
  orgId: number;
  name: string;
  kind: ProviderKind;
  vendor: string;
  baseUrl: string | null;
  credentialRef: string;
  authScheme: string;
  timeoutMs: number;
  maxConcurrency: number;
  rateLimit: Record<string, number | undefined>;
  status: ProviderStatus;
  connectivity: Connectivity;
  lastCheckAt: Date | null;
  lastCheckLatencyMs: number | null;
  lastErrorCode: string | null;
  balanceCents: number | null;
  region: string | null;
  extra: Record<string, unknown>;
  version: number;
}

export interface ModelRow {
  id: string;
  orgId: number;
  providerId: string;
  name: string;
  externalModelId: string;
  displayName: string;
  capability: Capability;
  purposeSupport: Purpose[];
  paramsSchema: Record<string, unknown>;
  defaultParams: Record<string, unknown>;
  price: PriceBook;
  priceVersion: number;
  rateLimit: Record<string, number | undefined>;
  contextTokens: number | null;
  maxOutputTokens: number | null;
  embedDim: number | null;
  status: ModelStatus;
  publishedAt: Date | null;
  publishedBy: string | null;
  sunsetAt: Date | null;
  version: number;
}

export interface RouteRow {
  id: string;
  orgId: number;
  scopeType: 'org' | 'role' | 'user';
  scopeRoleId: string | null;
  scopeUserId: string | null;
  purpose: Purpose;
  modelId: string;
  fallbackIds: string[];
  priority: number;
  rpm: number | null;
  tpm: number | null;
  concurrency: number | null;
  dailyCalls: number | null;
  dailyCostCents: number | null;
  monthlyCostCents: number | null;
  status: RouteStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  label: string | null;
  version: number;
  updatedAt: Date;
}

export interface CredentialRefRow {
  id: string;
  name: string;
  status: 'active' | 'rotating' | 'revoked';
}

export interface Principal {
  orgId: number;
  userId: string;
  roles: Role[];
  roleIds: string[];
}

export interface VisibilityResult {
  visible: boolean;
  code?:
    | 'provider_unavailable'
    | 'model_not_published'
    | 'no_route'
    | 'role_forbidden'
    | 'model_purpose_mismatch';
}

export interface UsageEstimate {
  tokensIn?: number;
  tokensOut?: number;
  images?: number;
  pixels?: number;
  seconds?: number;
}

export interface UsageActual {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  imageCount?: number;
  imagePixels?: number;
  videoSeconds?: number;
  tokensSource?: 'provider_usage' | 'estimated';
}

export interface QuotaLimits {
  rpm?: number;
  tpm?: number;
  concurrency?: number;
  dailyCalls?: number;
  dailyCostCents?: number;
  monthlyCostCents?: number;
}

export interface RouteDecision {
  routeId: string;
  modelId: string;
  providerId: string;
  model: ModelRow;
  provider: ProviderRow;
  params: Record<string, unknown>;
  degraded: boolean;
  fallbackFrom?: string;
  reason: 'primary' | 'fallback' | 'quota_fallback';
}

export interface CallLogInput {
  orgId: number;
  requestId: string;
  purpose: Purpose;
  providerId: string;
  modelId: string;
  routeId: string | null;
  fallbackFromModelId: string | null;
  actorType: 'user' | 'agent' | 'worker' | 'system';
  actorId: string | null;
  subjectType: string;
  subjectId: string | null;
  promptVersion: string | null;
  usage: UsageActual;
  latencyMs: number;
  status: 'succeeded' | 'failed' | 'timeout' | 'quota_rejected' | 'schema_invalid' | 'cancelled';
  errorCode: string | null;
  costCents: number;
  priceSnapshot: PriceBook;
  startedAt: Date;
  finishedAt: Date | null;
}

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === 'string' && (PURPOSES as readonly string[]).includes(value);
}
