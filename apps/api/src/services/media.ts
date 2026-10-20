/**
 * t39（F-E2E-03）：媒体主链路服务层。
 *
 * 职责：generate（幂等）/ job 列表与详情 / asset 列表与详情 / 人审 / 下载对象解析。
 * 与 M6 worker 的契约：generate 只落 media_job(status=queued, params.kind)，
 * worker 用 claimDueJobs + pipeline 接管；API 读同一张表与同一对象存储。
 */
import { createHash } from 'node:crypto';
import { Prisma, getPrisma } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import type { ServiceContext } from '../lib/service-context.js';

export const MEDIA_PURPOSES = ['image', 'video', 'render'] as const;
export const MEDIA_KINDS = ['scene', 'model', 'short_video', 'concept', 'size_chart'] as const;
export const ASSET_STATUSES = ['pending_review', 'approved', 'rejected', 'archived'] as const;

export interface GenerateParams {
  prompt?: string;
  negative_prompt?: string;
  size?: string;
  seed?: number;
  count?: number;
  size_chart?: Record<string, unknown>;
  pending_polls?: number;
  duration_seconds?: number;
}

export interface GenerateMediaInput {
  kind: (typeof MEDIA_KINDS)[number];
  purpose: (typeof MEDIA_PURPOSES)[number];
  sku_id?: string;
  reference_asset_id?: string;
  provider_id?: string;
  model_id?: string;
  params: GenerateParams;
  variant_policy?: { keys: string[] };
}

export interface JobSummary {
  id: string;
  kind: string;
  status: string;
  attempt: number;
  poll_count: number;
  poll_after: string | null;
  cost_reserved_cents: number;
  cost_actual_cents: number;
  last_error: { code: string; detail: string } | null;
  external_job_id: string | null;
  result_asset_id: string | null;
  provider_cancel_supported: boolean;
  created_at: string;
}

interface AssetVariant {
  key: string;
  bucket: string;
  objectKey: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** 稳定序列化：同样的请求体得到同样的 dedupe key（与 key 顺序无关）。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function paramsOf(job: { params: Prisma.JsonValue }): Record<string, unknown> {
  return job.params && typeof job.params === 'object' && !Array.isArray(job.params)
    ? (job.params as Record<string, unknown>)
    : {};
}

function jobKind(job: { params: Prisma.JsonValue }): string {
  const kind = paramsOf(job).kind;
  return typeof kind === 'string' ? kind : '';
}

function mapJob(job: {
  id: string;
  params: Prisma.JsonValue;
  status: string;
  attempt: number;
  pollCount: number;
  pollAfter: Date | null;
  estimatedCostCents: number;
  costCents: number;
  errorCode: string | null;
  errorClass: string | null;
  externalJobId: string | null;
  mediaAssetId: string | null;
  createdAt: Date;
}): JobSummary {
  return {
    id: job.id,
    kind: jobKind(job),
    status: job.status,
    attempt: job.attempt,
    poll_count: job.pollCount,
    poll_after: job.pollAfter?.toISOString() ?? null,
    cost_reserved_cents: job.estimatedCostCents,
    cost_actual_cents: job.costCents,
    last_error: job.errorCode
      ? { code: job.errorCode, detail: job.errorClass ?? '' }
      : null,
    external_job_id: job.externalJobId,
    result_asset_id: job.mediaAssetId,
    provider_cancel_supported: true,
    created_at: job.createdAt.toISOString(),
  };
}

async function resolveProviderModel(
  purpose: (typeof MEDIA_PURPOSES)[number],
  providerId?: string,
  modelId?: string,
): Promise<{ providerId: string; modelId: string }> {
  const prisma = getPrisma();
  if (providerId || modelId) {
    if (!providerId || !modelId) {
      throw new ApiError('validation_failed', 'provider_id 与 model_id 必须同时提供');
    }
    const provider = await prisma.provider.findUnique({ where: { id: providerId } });
    if (!provider || provider.archivedAt) throw new ApiError('not_found', 'provider 不存在');
    if (provider.status === 'disabled') throw new ApiError('validation_failed', 'provider 已停用');
    const model = await prisma.model.findUnique({ where: { id: modelId } });
    if (!model || model.archivedAt) throw new ApiError('not_found', 'model 不存在');
    if (model.providerId !== provider.id) {
      throw new ApiError('validation_failed', 'model 不属于该 provider');
    }
    if (model.status === 'suspended' || model.status === 'archived') {
      throw new ApiError('validation_failed', `model 状态不可用：${model.status}`);
    }
    return { providerId: provider.id, modelId: model.id };
  }

  // 未显式指定：选一个 active provider + published/testing 的匹配模型。
  const capability = purpose === 'video' ? 'video' : 'image';
  const provider = await prisma.provider.findFirst({
    where: { status: 'active', archivedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!provider) throw new ApiError('validation_failed', '没有可用的 provider，请显式传 provider_id/model_id');
  const model = await prisma.model.findFirst({
    where: {
      providerId: provider.id,
      capability,
      status: { in: ['published', 'testing'] },
      archivedAt: null,
    },
    orderBy: { createdAt: 'asc' },
  });
  if (!model) throw new ApiError('validation_failed', '没有可用的 model，请显式传 provider_id/model_id');
  return { providerId: provider.id, modelId: model.id };
}

function validateGenerate(input: GenerateMediaInput): void {
  if (input.purpose === 'render') {
    if (input.kind !== 'size_chart') {
      throw new ApiError('validation_failed', 'purpose=render 时 kind 必须为 size_chart');
    }
    if (!input.params.size_chart || typeof input.params.size_chart !== 'object' || Array.isArray(input.params.size_chart)) {
      throw new ApiError('validation_failed', 'purpose=render 需要 params.size_chart 对象');
    }
  } else if (input.kind === 'size_chart') {
    throw new ApiError('validation_failed', 'kind=size_chart 只能用于 purpose=render');
  }
  if (input.kind !== 'concept' && input.kind !== 'size_chart' && !input.sku_id) {
    throw new ApiError('validation_failed', `kind=${input.kind} 需要 sku_id`);
  }
}

/** 提交媒体任务；以请求内容的 sha256 做 10 分钟级去重（对应 docs/12 的 dedupe_key）。 */
export async function generateMediaJob(
  input: GenerateMediaInput,
  ctx: ServiceContext,
): Promise<{ job_id: string; status: string; deduped: boolean; poll_after: string | null; cost_reserved_cents: number }> {
  validateGenerate(input);
  const { providerId, modelId } = await resolveProviderModel(input.purpose, input.provider_id, input.model_id);
  const prisma = getPrisma();
  const orgId = 1n;

  const dedupeKey = sha256Hex(
    canonical({
      kind: input.kind,
      purpose: input.purpose,
      sku_id: input.sku_id ?? null,
      reference_asset_id: input.reference_asset_id ?? null,
      provider_id: providerId,
      model_id: modelId,
      params: input.params,
      variant_policy: input.variant_policy ?? null,
    }),
  );
  const existing = await prisma.mediaJob.findFirst({
    where: { orgId, idempotencyKey: dedupeKey, archivedAt: null },
  });
  if (existing) {
    return {
      job_id: existing.id,
      status: existing.status,
      deduped: true,
      poll_after: existing.pollAfter?.toISOString() ?? null,
      cost_reserved_cents: existing.estimatedCostCents,
    };
  }

  const count = input.params.count ?? 1;
  const estimated =
    input.purpose === 'image'
      ? count * 4
      : input.purpose === 'video'
        ? Math.ceil((input.params.duration_seconds ?? 5) * 10)
        : 0;
  const params = {
    ...input.params,
    kind: input.kind,
    source: input.kind === 'size_chart' ? 'shoot' : 'ai_generated',
    ...(input.sku_id ? { sku_id: input.sku_id } : {}),
    ...(input.reference_asset_id ? { reference_asset_id: input.reference_asset_id } : {}),
    ...(input.variant_policy ? { variant_policy: input.variant_policy } : {}),
  } as Prisma.InputJsonValue;

  try {
    const created = await prisma.mediaJob.create({
      data: {
        orgId,
        purpose: input.purpose,
        providerId,
        modelId,
        params,
        prompt: input.params.prompt ?? null,
        inputRef: { sku_id: input.sku_id ?? null, reference_asset_id: input.reference_asset_id ?? null },
        status: 'queued',
        idempotencyKey: dedupeKey,
        estimatedCostCents: estimated,
        subjectType: input.sku_id ? 'product_sku' : 'other',
        subjectId: input.sku_id ?? null,
        createdBy: ctx.userId,
      },
    });
    return {
      job_id: created.id,
      status: created.status,
      deduped: false,
      poll_after: created.pollAfter?.toISOString() ?? null,
      cost_reserved_cents: created.estimatedCostCents,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await prisma.mediaJob.findFirst({ where: { orgId, idempotencyKey: dedupeKey } });
      if (raced) {
        return {
          job_id: raced.id,
          status: raced.status,
          deduped: true,
          poll_after: raced.pollAfter?.toISOString() ?? null,
          cost_reserved_cents: raced.estimatedCostCents,
        };
      }
    }
    throw error;
  }
}

export interface ListJobsQuery {
  status?: string;
  kind?: string;
  sku_id?: string;
  created_by?: string;
  cursor?: string;
  limit?: number;
}

export async function listMediaJobs(query: ListJobsQuery): Promise<{ items: JobSummary[]; next_cursor: string | null }> {
  const prisma = getPrisma();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const where: Prisma.MediaJobWhereInput = { orgId: 1n, archivedAt: null };
  if (query.status) where.status = query.status;
  if (query.created_by) where.createdBy = query.created_by;
  if (query.kind) where.params = { path: ['kind'], equals: query.kind };
  if (query.sku_id) {
    where.AND = [
      {
        OR: [
          { subjectId: query.sku_id },
          { params: { path: ['sku_id'], equals: query.sku_id } },
        ],
      },
    ];
  }
  const rows = await prisma.mediaJob.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map(mapJob),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getMediaJob(
  id: string,
): Promise<JobSummary & { asset: ReturnType<typeof mapAssetSummary> | null }> {
  const prisma = getPrisma();
  const job = await prisma.mediaJob.findFirst({ where: { id, archivedAt: null } });
  if (!job) throw new ApiError('not_found', '媒体任务不存在');
  const asset = job.mediaAssetId
    ? await prisma.mediaAsset.findFirst({ where: { id: job.mediaAssetId, archivedAt: null } })
    : null;
  return { ...mapJob(job), asset: asset ? mapAssetSummary(asset) : null };
}

function variantsOf(asset: { variants: Prisma.JsonValue }): AssetVariant[] {
  if (!Array.isArray(asset.variants)) return [];
  return asset.variants.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const v = raw as Record<string, unknown>;
    if (typeof v.key !== 'string' || typeof v.objectKey !== 'string') return [];
    return [{
      key: v.key,
      bucket: typeof v.bucket === 'string' ? v.bucket : 'dssaas-media',
      objectKey: v.objectKey,
      mime: typeof v.mime === 'string' ? v.mime : 'application/octet-stream',
      width: typeof v.width === 'number' ? v.width : 0,
      height: typeof v.height === 'number' ? v.height : 0,
      bytes: typeof v.bytes === 'number' ? v.bytes : 0,
    }];
  });
}

function thumbUrl(id: string): string {
  return `/api/media/assets/${id}/download?variant=thumb_320`;
}

function mapAssetSummary(asset: {
  id: string;
  kind: string;
  source: string;
  aigcLabeled: boolean;
  width: number | null;
  height: number | null;
  status: string;
  costCents: number;
  createdAt: Date;
  mime: string;
  bytes: bigint;
}): {
  id: string;
  kind: string;
  source: string;
  is_aigc: boolean;
  width: number | null;
  height: number | null;
  status: string;
  thumb_url: string;
  cost_cents: number;
  created_at: string;
  mime: string;
  bytes: number;
} {
  return {
    id: asset.id,
    kind: asset.kind,
    source: asset.source,
    is_aigc: asset.aigcLabeled,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    thumb_url: thumbUrl(asset.id),
    cost_cents: asset.costCents,
    created_at: asset.createdAt.toISOString(),
    mime: asset.mime,
    bytes: Number(asset.bytes),
  };
}

export interface ListAssetsQuery {
  kind?: string;
  sku_id?: string;
  status?: string;
  aigc?: boolean;
  cursor?: string;
  limit?: number;
}

export async function listMediaAssets(
  query: ListAssetsQuery,
): Promise<{ items: ReturnType<typeof mapAssetSummary>[]; next_cursor: string | null }> {
  const prisma = getPrisma();
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const where: Prisma.MediaAssetWhereInput = { orgId: 1n, archivedAt: null };
  if (query.kind) where.kind = query.kind;
  if (query.status) where.status = query.status;
  if (query.sku_id) where.skuId = query.sku_id;
  if (query.aigc !== undefined) where.aigcLabeled = query.aigc;
  const rows = await prisma.mediaAsset.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return {
    items: page.map(mapAssetSummary),
    next_cursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function getMediaAsset(id: string): Promise<Record<string, unknown>> {
  const prisma = getPrisma();
  const asset = await prisma.mediaAsset.findFirst({ where: { id, archivedAt: null } });
  if (!asset) throw new ApiError('not_found', '媒体资产不存在');
  const variants = variantsOf(asset);
  const [listings] = await Promise.all([
    prisma.listing.findMany({ where: { mainImageId: id, archivedAt: null }, select: { id: true } }),
  ]);
  return {
    asset: {
      id: asset.id,
      kind: asset.kind,
      source: asset.source,
      bucket: asset.bucket,
      object_key: asset.objectKey,
      sha256: asset.sha256,
      mime: asset.mime,
      width: asset.width,
      height: asset.height,
      bytes: Number(asset.bytes),
      status: asset.status,
      is_aigc: asset.aigcLabeled,
      aigc_meta: asset.aigcMeta,
      review_note: asset.reviewNote,
      media_job_id: asset.mediaJobId,
      cost_cents: asset.costCents,
      created_at: asset.createdAt.toISOString(),
    },
    variants: variants.map((v) => ({
      key: v.key,
      url: `/api/media/assets/${id}/download?variant=${encodeURIComponent(v.key)}`,
      width: v.width,
      height: v.height,
      bytes: v.bytes,
      mime: v.mime,
    })),
    relations: {
      listings: listings.map((row) => row.id),
      drafts: [] as string[],
    },
    signed_url: null,
  };
}

export async function reviewMediaAsset(
  id: string,
  input: { result: 'approved' | 'rejected'; reason_code?: string; note?: string },
  ctx: ServiceContext,
): Promise<{ status: string; updated_drafts: string[]; quarantined: boolean }> {
  void ctx;
  const prisma = getPrisma();
  const asset = await prisma.mediaAsset.findFirst({ where: { id, archivedAt: null } });
  if (!asset) throw new ApiError('not_found', '媒体资产不存在');
  if (asset.status === 'archived') throw new ApiError('conflict', '资产已归档');
  const note = [input.reason_code, input.note].filter(Boolean).join(' | ') || null;
  const updated = await prisma.mediaAsset.updateMany({
    where: { id, archivedAt: null },
    data: { status: input.result, reviewNote: note },
  });
  if (updated.count === 0) throw new ApiError('conflict', '资产状态已变化，请刷新后重试');
  return { status: input.result, updated_drafts: [], quarantined: false };
}

export interface DownloadTarget {
  bucket: string;
  key: string;
  mime: string;
  filename: string;
}

/** 解析下载对象：默认源对象；variant 指定 thumb_320/detail_1200/... */
export async function resolveAssetDownload(id: string, variant?: string): Promise<DownloadTarget> {
  const prisma = getPrisma();
  const asset = await prisma.mediaAsset.findFirst({ where: { id, archivedAt: null } });
  if (!asset) throw new ApiError('not_found', '媒体资产不存在');
  const variants = variantsOf(asset);
  const picked = variant ? variants.find((v) => v.key === variant) : undefined;
  if (variant && !picked) throw new ApiError('not_found', `变体不存在：${variant}`);
  const key = picked?.objectKey ?? asset.objectKey;
  const bucket = picked?.bucket ?? asset.bucket;
  const mime = picked?.mime ?? asset.mime;
  const ext = key.split('.').pop() ?? 'bin';
  return { bucket, key, mime, filename: `${asset.id}-${picked?.key ?? 'source'}.${ext}` };
}
