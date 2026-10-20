'use client';

import { getEnvelope, getJson, mutateJson } from './m3-api';
import type {
  ModelItem,
  PriceBook,
  ProviderItem,
  RouteItem,
  UsageData,
} from './m3-types';

/* ------------------------------------------------------------------ */
/* Provider                                                             */
/* ------------------------------------------------------------------ */

export interface ProviderCreateInput {
  kind: 'text' | 'image' | 'video' | 'embedding';
  name: string;
  base_url?: string;
  credential_ref: string;
  vendor?: 'deepseek' | 'volcengine' | 'aliyun' | 'openai_compatible' | 'other';
  auth_scheme?: 'bearer' | 'header' | 'query' | 'ak_sk' | 'none';
  region?: string;
  timeout_ms?: number;
  max_concurrency?: number;
  rate_limit?: Record<string, number>;
}

export interface ProviderUpdateInput {
  base_url?: string | null;
  credential_ref?: string;
  region?: string | null;
  timeout_ms?: number;
  max_concurrency?: number;
  rate_limit?: Record<string, number>;
  status?: 'active' | 'disabled';
}

export async function fetchProviders(): Promise<ProviderItem[]> {
  const data = await getJson<{ items: ProviderItem[] }>('/api/providers');
  return Array.isArray(data.items) ? data.items : [];
}

export async function createProvider(
  input: ProviderCreateInput,
): Promise<{ id: string; status: string; version: number }> {
  const result = await mutateJson<{ id: string; status: string; version: number }>(
    '/api/providers',
    { body: input },
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function updateProvider(
  id: string,
  input: ProviderUpdateInput,
  version: number,
): Promise<{ id: string; version: number; status: string }> {
  const result = await mutateJson<{ id: string; version: number; status: string }>(
    `/api/providers/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input, headers: { 'if-match': String(version) } },
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function testProvider(
  id: string,
): Promise<{ ok: boolean; latency_ms: number; models_probed: number; error?: { code: string } }> {
  const result = await mutateJson<{
    ok: boolean;
    latency_ms: number;
    models_probed: number;
    error?: { code: string };
  }>(`/api/providers/${encodeURIComponent(id)}/test`, {});
  if (!result.ok) throw result;
  return result.data;
}

/* ------------------------------------------------------------------ */
/* Model                                                                */
/* ------------------------------------------------------------------ */

export interface ModelCreateInput {
  provider_id: string;
  external_model_id: string;
  display_name: string;
  capability: 'text' | 'image' | 'video' | 'embedding' | 'rerank';
  purpose_support?: string[];
  params_schema: Record<string, unknown>;
  default_params: Record<string, unknown>;
  price: PriceBook;
  rate_limit?: Record<string, number>;
  context_tokens?: number;
  max_output_tokens?: number;
  embed_dim?: number;
  docs_url?: string;
  notes?: string;
}

export interface ModelUpdateInput {
  display_name?: string;
  params_schema?: Record<string, unknown>;
  default_params?: Record<string, unknown>;
  price?: PriceBook;
  rate_limit?: Record<string, number>;
  notes?: string | null;
  docs_url?: string | null;
}

export interface ModelQuery {
  purpose?: string;
  capability?: string;
  status?: string;
  provider_id?: string;
  q?: string;
  limit?: number;
}

export async function fetchModels(query: ModelQuery = {}): Promise<ModelItem[]> {
  const params = new URLSearchParams();
  if (query.purpose) params.set('purpose', query.purpose);
  if (query.capability) params.set('capability', query.capability);
  if (query.status) params.set('status', query.status);
  if (query.provider_id) params.set('provider_id', query.provider_id);
  if (query.q) params.set('q', query.q);
  params.set('limit', String(query.limit ?? 100));
  const data = await getJson<{ items: ModelItem[] }>(`/api/models?${params.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function createModel(
  input: ModelCreateInput,
): Promise<{ id: string; status: string; version: number }> {
  const result = await mutateJson<{ id: string; status: string; version: number }>(
    '/api/models',
    { body: input },
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function updateModel(
  id: string,
  input: ModelUpdateInput,
  version: number,
): Promise<{ id: string; version: number; status: string; price_version: number }> {
  const result = await mutateJson<{
    id: string;
    version: number;
    status: string;
    price_version: number;
  }>(`/api/models/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    headers: { 'if-match': String(version) },
  });
  if (!result.ok) throw result;
  return result.data;
}

export async function testModel(
  id: string,
): Promise<{ ok: boolean; latency_ms: number; error?: { code: string } }> {
  const result = await mutateJson<{ ok: boolean; latency_ms: number; error?: { code: string } }>(
    `/api/models/${encodeURIComponent(id)}/test`,
    {},
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function publishModel(
  id: string,
): Promise<{ id: string; status: string; published_at: string | null }> {
  const result = await mutateJson<{ id: string; status: string; published_at: string | null }>(
    `/api/models/${encodeURIComponent(id)}/publish`,
    {},
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function suspendModel(id: string): Promise<{ id: string; status: string }> {
  const result = await mutateJson<{ id: string; status: string }>(
    `/api/models/${encodeURIComponent(id)}/suspend`,
    {},
  );
  if (!result.ok) throw result;
  return result.data;
}

/* ------------------------------------------------------------------ */
/* Route                                                                */
/* ------------------------------------------------------------------ */

export interface RouteCreateInput {
  scope_type: 'org' | 'role' | 'user';
  scope_role_id?: string;
  scope_user_id?: string;
  purpose: 'copy' | 'judge' | 'image' | 'video' | 'embed' | 'rerank';
  model_id: string;
  fallback_ids: string[];
  priority: number;
  quota?: {
    rpm?: number;
    tpm?: number;
    concurrency?: number;
    daily_calls?: number;
    daily_cost_cents?: number;
    monthly_cost_cents?: number;
  };
  status: 'draft' | 'active';
  effective_from?: string;
  effective_to?: string;
  label?: string;
}

export interface RouteUpdateInput {
  model_id?: string;
  fallback_ids?: string[];
  priority?: number;
  quota?: RouteCreateInput['quota'];
  status?: 'draft' | 'active' | 'paused' | 'retired';
  effective_from?: string | null;
  effective_to?: string | null;
  label?: string | null;
}

export async function fetchRoutes(query: { purpose?: string; status?: string } = {}): Promise<RouteItem[]> {
  const params = new URLSearchParams();
  if (query.purpose) params.set('purpose', query.purpose);
  if (query.status) params.set('status', query.status);
  const data = await getJson<{ items: RouteItem[] }>(`/api/routes?${params.toString()}`);
  return Array.isArray(data.items) ? data.items : [];
}

export async function createRoute(
  input: RouteCreateInput,
): Promise<{ id: string; version: number; status: string }> {
  const result = await mutateJson<{ id: string; version: number; status: string }>(
    '/api/routes',
    { body: input },
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function updateRoute(
  id: string,
  input: RouteUpdateInput,
  version: number,
): Promise<{ id: string; version: number; status: string }> {
  const result = await mutateJson<{ id: string; version: number; status: string }>(
    `/api/routes/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input, headers: { 'if-match': String(version) } },
  );
  if (!result.ok) throw result;
  return result.data;
}

/* ------------------------------------------------------------------ */
/* Usage                                                                */
/* ------------------------------------------------------------------ */

export async function fetchUsage(
  from: string,
  to: string,
  groupBy: 'model' | 'purpose' | 'day',
): Promise<UsageData> {
  const params = new URLSearchParams({ from, to, group_by: groupBy });
  return getJson<UsageData>(`/api/usage?${params.toString()}`);
}
