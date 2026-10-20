/**
 * MediaRepository 的 Prisma 实现（运行期 worker 用）。
 *
 * 说明：现有 schema 没有 deadline/next_retry/cancel_requested 等列（t26 不改 schema），
 * 因此取消用 status='cancelled'、重试用 poll_after + attempt 表达。
 */
import { Prisma, type PrismaClient } from '@dssaas/db';
import type {
  CostLedgerEntry,
  MediaAssetRecord,
  MediaJobRecord,
  MediaJobStatus,
  MediaRepository,
  QuotaDecision,
  VariantMeta,
} from './types.js';

interface JobRow {
  id: string;
  orgId: bigint;
  purpose: string;
  status: string;
  params: unknown;
  idempotencyKey: string;
  providerId: string;
  modelId: string;
  externalJobId: string | null;
  pollAfter: Date | null;
  pollCount: number;
  lockedBy: string | null;
  lockedUntil: Date | null;
  attempt: number;
  maxAttempts: number;
  resultUrl: string | null;
  mediaAssetId: string | null;
  errorClass: string | null;
  errorCode: string | null;
  costCents: number;
  estimatedCostCents: number;
  subjectType: string;
  subjectId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

interface AssetRow {
  id: string;
  orgId: bigint;
  kind: string;
  source: string;
  bucket: string;
  objectKey: string;
  sha256: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: bigint;
  variants: unknown;
  aigcLabeled: boolean;
  aigcMeta: unknown;
  status: string;
  mediaJobId: string | null;
  costCents: number;
}

interface QuotaRow {
  id: string;
  maxImages: number | null;
  usedImages: number;
}

function mapJob(row: JobRow): MediaJobRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    purpose: row.purpose as MediaJobRecord['purpose'],
    status: row.status as MediaJobStatus,
    params: (row.params ?? {}) as Record<string, unknown>,
    idempotencyKey: row.idempotencyKey,
    providerId: row.providerId,
    modelId: row.modelId,
    externalJobId: row.externalJobId,
    pollAfter: row.pollAfter,
    pollCount: row.pollCount,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    resultUrl: row.resultUrl,
    mediaAssetId: row.mediaAssetId,
    errorClass: row.errorClass as MediaJobRecord['errorClass'],
    errorCode: row.errorCode,
    costCents: row.costCents,
    estimatedCostCents: row.estimatedCostCents,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}

function mapAsset(row: AssetRow): MediaAssetRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    source: row.source,
    bucket: row.bucket,
    objectKey: row.objectKey,
    sha256: row.sha256,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    variants: Array.isArray(row.variants) ? (row.variants as VariantMeta[]) : [],
    aigcLabeled: row.aigcLabeled,
    aigcMeta: (row.aigcMeta ?? null) as Record<string, unknown> | null,
    status: row.status,
    mediaJobId: row.mediaJobId ?? '',
    costCents: row.costCents,
  };
}

export class PrismaMediaRepository implements MediaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getJob(id: string): Promise<MediaJobRecord | null> {
    const row = (await this.prisma.mediaJob.findUnique({ where: { id } })) as unknown as JobRow | null;
    return row ? mapJob(row) : null;
  }

  async updateJob(id: string, patch: Partial<MediaJobRecord>): Promise<void> {
    const data: Record<string, unknown> = {};
    for (const key of [
      'status',
      'externalJobId',
      'pollAfter',
      'pollCount',
      'lockedBy',
      'lockedUntil',
      'attempt',
      'resultUrl',
      'mediaAssetId',
      'errorClass',
      'errorCode',
      'costCents',
      'finishedAt',
    ] as const) {
      if (patch[key] !== undefined) data[key] = patch[key];
    }
    if (Object.keys(data).length === 0) return;
    await this.prisma.mediaJob.update({ where: { id }, data: data as Prisma.MediaJobUpdateInput });
  }

  async listDueJobs(now: Date, limit: number): Promise<MediaJobRecord[]> {
    const rows = (await this.prisma.mediaJob.findMany({
      where: {
        status: { in: ['queued', 'submitted', 'polling', 'retrieved'] },
        archivedAt: null,
        OR: [{ pollAfter: null }, { pollAfter: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    })) as unknown as JobRow[];
    return rows.map(mapJob);
  }

  /**
   * 原子抢占：`FOR UPDATE SKIP LOCKED` + 显式租约（locked_by/locked_until）。
   * poll_after 仍只表示“下次轮询时间”，不再兼职租约。
   */
  async claimDueJobs(
    now: Date,
    limit: number,
    workerId: string,
    leaseMs: number,
  ): Promise<MediaJobRecord[]> {
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const claimed = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE media_job AS m
      SET locked_by = ${workerId},
          locked_until = ${leaseUntil},
          updated_at = now()
      WHERE m.id IN (
        SELECT id FROM media_job
        WHERE status IN ('queued', 'submitted', 'polling', 'retrieved')
          AND (poll_after IS NULL OR poll_after <= ${now})
          AND (locked_until IS NULL OR locked_until < ${now})
          AND archived_at IS NULL
        ORDER BY poll_after ASC NULLS FIRST
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      RETURNING m.id
    `);
    if (claimed.length === 0) return [];
    const rows = (await this.prisma.mediaJob.findMany({
      where: { id: { in: claimed.map((item) => item.id) } },
    })) as unknown as JobRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return claimed
      .map((item) => byId.get(item.id))
      .filter((row): row is JobRow => row !== undefined)
      .map(mapJob);
  }

  async renewLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.prisma.mediaJob.updateMany({
      where: { id: jobId, lockedBy: workerId },
      data: { lockedUntil: new Date(Date.now() + leaseMs) },
    });
    return result.count > 0;
  }

  async updateLockedJob(
    jobId: string,
    workerId: string,
    patch: Partial<MediaJobRecord>,
  ): Promise<boolean> {
    const data: Record<string, unknown> = {};
    for (const key of [
      'status',
      'externalJobId',
      'pollAfter',
      'pollCount',
      'lockedBy',
      'lockedUntil',
      'attempt',
      'resultUrl',
      'mediaAssetId',
      'errorClass',
      'errorCode',
      'costCents',
      'finishedAt',
    ] as const) {
      if (patch[key] !== undefined) data[key] = patch[key];
    }
    if (Object.keys(data).length === 0) return true;
    const result = await this.prisma.mediaJob.updateMany({
      where: { id: jobId, lockedBy: workerId },
      data: data as Prisma.MediaJobUpdateInput,
    });
    return result.count > 0;
  }

  async listCancelledJobs(limit: number): Promise<MediaJobRecord[]> {
    const rows = (await this.prisma.mediaJob.findMany({
      where: { status: 'cancelled' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    })) as unknown as JobRow[];
    return rows.map(mapJob);
  }

  async getAssetByJob(jobId: string): Promise<MediaAssetRecord | null> {
    const row = (await this.prisma.mediaAsset.findFirst({
      where: { mediaJobId: jobId, archivedAt: null },
    })) as unknown as AssetRow | null;
    return row ? mapAsset(row) : null;
  }

  async saveAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord> {
    const existing = await this.getAssetByJob(asset.mediaJobId);
    if (existing) return existing;
    const row = (await this.prisma.mediaAsset.create({
      data: {
        id: asset.id,
        orgId: asset.orgId,
        kind: asset.kind,
        source: asset.source,
        bucket: asset.bucket,
        objectKey: asset.objectKey,
        sha256: asset.sha256,
        mime: asset.mime,
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        bytes: asset.bytes,
        variants: asset.variants as unknown as Prisma.InputJsonValue,
        aigcLabeled: asset.aigcLabeled,
        ...(asset.aigcMeta ? { aigcMeta: asset.aigcMeta as Prisma.InputJsonValue } : {}),
        status: asset.status,
        mediaJobId: asset.mediaJobId,
        costCents: asset.costCents,
      },
    })) as unknown as AssetRow;
    return mapAsset(row);
  }

  async checkQuota(job: MediaJobRecord, now: Date): Promise<QuotaDecision> {
    const skuId = job.subjectType === 'product_sku' ? job.subjectId : null;
    const row = (await this.prisma.mediaQuota.findFirst({
      where: {
        orgId: job.orgId,
        archivedAt: null,
        skuId: skuId ?? null,
        windowStart: { lte: now },
        OR: [{ windowEnd: null }, { windowEnd: { gte: now } }],
      },
      orderBy: { windowStart: 'desc' },
    })) as unknown as QuotaRow | null;
    if (!row) return { allowed: true, used: 0, max: null };
    const max = row.maxImages;
    const allowed = max === null || row.usedImages < max;
    return {
      allowed,
      used: row.usedImages,
      max,
      ...(allowed
        ? {}
        : { message: `媒体配额已用完（${row.usedImages}/${max} 张/日），请明天再试或联系管理员提高额度` }),
    };
  }

  async consumeQuota(job: MediaJobRecord, now: Date, images: number): Promise<void> {
    const skuId = job.subjectType === 'product_sku' ? job.subjectId : null;
    const row = (await this.prisma.mediaQuota.findFirst({
      where: {
        orgId: job.orgId,
        archivedAt: null,
        skuId: skuId ?? null,
        windowStart: { lte: now },
        OR: [{ windowEnd: null }, { windowEnd: { gte: now } }],
      },
      orderBy: { windowStart: 'desc' },
    })) as unknown as QuotaRow | null;
    if (!row) return;
    await this.prisma.mediaQuota.update({
      where: { id: row.id },
      data: { usedImages: { increment: images } },
    });
  }

  async hasMediaCost(jobId: string): Promise<boolean> {
    const existing = await this.prisma.costLedger.findFirst({
      where: { kind: 'media', refType: 'media_job', refId: jobId },
      select: { id: true },
    });
    return existing !== null;
  }

  async addCostLedger(entry: CostLedgerEntry): Promise<void> {
    await this.prisma.costLedger.create({
      data: {
        orgId: entry.orgId,
        kind: entry.kind,
        refType: entry.refType,
        refId: entry.refId,
        tokens: entry.tokens,
        seconds: new Prisma.Decimal(entry.seconds),
        amountCents: entry.amountCents,
        occurredAt: entry.occurredAt,
      },
    });
  }
}
