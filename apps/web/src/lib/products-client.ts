'use client';

import { getEnvelope, getJson, mutateJson } from './m3-api';
import type {
  ImportResult,
  ProductCreateInput,
  ProductDetail,
  ProductListItem,
  ProductListData,
  ProductStatus,
} from './m3-types';

export interface ProductListQuery {
  q?: string;
  category_code?: string;
  status?: ProductStatus | '';
  cursor?: string | null;
  limit?: number;
}

export interface ProductListResult {
  items: ProductListItem[];
  nextCursor: string | null;
}

export async function fetchProductList(query: ProductListQuery): Promise<ProductListResult> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.category_code?.trim()) params.set('category_code', query.category_code.trim());
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  params.set('limit', String(query.limit ?? 20));
  const envelope = await getEnvelope<ProductListData>(`/api/products?${params.toString()}`);
  const next = envelope.meta.next_cursor;
  return {
    items: Array.isArray(envelope.data.items) ? envelope.data.items : [],
    nextCursor: typeof next === 'string' && next.length > 0 ? next : null,
  };
}

export async function fetchProduct(id: string): Promise<ProductDetail> {
  return getJson<ProductDetail>(`/api/products/${encodeURIComponent(id)}`);
}

export async function createProduct(input: ProductCreateInput): Promise<{ id: string }> {
  const result = await mutateJson<{ id: string }>('/api/products', { body: input });
  if (!result.ok) throw result;
  return result.data;
}

export async function importProductCsv(
  file: File,
  options: { dryRun: boolean; platformScope: 'pdd' | '1688' | 'both' },
): Promise<ImportResult> {
  const form = new FormData();
  form.set('file', file, file.name);
  form.set('dry_run', options.dryRun ? 'true' : 'false');
  form.set('platform_scope', options.platformScope);
  const result = await mutateJson<ImportResult>('/api/products/import', { body: form });
  if (!result.ok) throw result;
  return result.data;
}
