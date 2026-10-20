/** 内存仓储（单测 / demo 用；与 Prisma 实现同端口语义）。 */
import type {
  CostLedgerEntry,
  MediaAssetRecord,
  MediaJobRecord,
  MediaRepository,
  QuotaDecision,
} from './types.js';

export interface MemoryQuota {
  maxImages: number | null;
  used: number;
}

export class MemoryMediaRepository implements MediaRepository {
  readonly jobs = new Map<string, MediaJobRecord>();
  readonly assets = new Map<string, MediaAssetRecord>();
  readonly ledgers: CostLedgerEntry[] = [];
  /** 测试注入：这些 job 的心跳续租会失败（模拟租约被抢）。 */
  readonly renewalFailures = new Set<string>();
  quota: MemoryQuota | null;

  constructor(seed: { jobs?: MediaJobRecord[]; quota?: MemoryQuota | null } = {}) {
    for (const job of seed.jobs ?? []) this.jobs.set(job.id, job);
    this.quota = seed.quota ?? null;
  }

  async getJob(id: string): Promise<MediaJobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async updateJob(id: string, patch: Partial<MediaJobRecord>): Promise<void> {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`job 不存在：${id}`);
    this.jobs.set(id, { ...current, ...patch });
  }

  async listDueJobs(now: Date, limit: number): Promise<MediaJobRecord[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          ['queued', 'submitted', 'polling', 'retrieved'].includes(job.status) &&
          (job.pollAfter === null || job.pollAfter.getTime() <= now.getTime()),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async claimDueJobs(
    now: Date,
    limit: number,
    workerId: string,
    leaseMs: number,
  ): Promise<MediaJobRecord[]> {
    const claimed: MediaJobRecord[] = [];
    for (const job of [...this.jobs.values()].sort(
      (a, b) => (a.pollAfter?.getTime() ?? 0) - (b.pollAfter?.getTime() ?? 0),
    )) {
      if (claimed.length >= limit) break;
      if (!['queued', 'submitted', 'polling', 'retrieved'].includes(job.status)) continue;
      if (job.pollAfter && job.pollAfter.getTime() > now.getTime()) continue;
      if (job.lockedUntil && job.lockedUntil.getTime() >= now.getTime()) continue;
      const next: MediaJobRecord = {
        ...job,
        lockedBy: workerId,
        lockedUntil: new Date(now.getTime() + leaseMs),
      };
      this.jobs.set(job.id, next);
      claimed.push(next);
    }
    return claimed;
  }

  async renewLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.lockedBy !== workerId) return false;
    if (this.renewalFailures.has(jobId)) return false;
    this.jobs.set(jobId, { ...job, lockedUntil: new Date(Date.now() + leaseMs) });
    return true;
  }

  async updateLockedJob(
    jobId: string,
    workerId: string,
    patch: Partial<MediaJobRecord>,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job || job.lockedBy !== workerId) return false;
    this.jobs.set(jobId, { ...job, ...patch });
    return true;
  }

  async listCancelledJobs(limit: number): Promise<MediaJobRecord[]> {
    return [...this.jobs.values()].filter((job) => job.status === 'cancelled').slice(0, limit);
  }

  async getAssetByJob(jobId: string): Promise<MediaAssetRecord | null> {
    return [...this.assets.values()].find((asset) => asset.mediaJobId === jobId) ?? null;
  }

  async saveAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord> {
    const existing = await this.getAssetByJob(asset.mediaJobId);
    if (existing) return existing;
    this.assets.set(asset.id, asset);
    return asset;
  }

  async checkQuota(): Promise<QuotaDecision> {
    if (!this.quota) return { allowed: true, used: 0, max: null };
    const { maxImages, used } = this.quota;
    const allowed = maxImages === null || used < maxImages;
    return {
      allowed,
      used,
      max: maxImages,
      ...(allowed ? {} : { message: `媒体配额已用完（${used}/${maxImages} 张/日），请明天再试或联系管理员提高额度` }),
    };
  }

  async consumeQuota(_job: MediaJobRecord, _now: Date, images: number): Promise<void> {
    if (this.quota) this.quota.used += images;
  }

  async hasMediaCost(jobId: string): Promise<boolean> {
    return this.ledgers.some((entry) => entry.refId === jobId);
  }

  async addCostLedger(entry: CostLedgerEntry): Promise<void> {
    this.ledgers.push(entry);
  }
}

export function makeJob(overrides: Partial<MediaJobRecord> = {}): MediaJobRecord {
  const id = overrides.id ?? `job-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    orgId: 1n,
    purpose: 'image',
    status: 'queued',
    params: { kind: 'scene', source: 'ai_generated' },
    idempotencyKey: `idem-${id}`,
    providerId: 'provider-mock',
    modelId: 'model-mock',
    externalJobId: null,
    pollAfter: null,
    pollCount: 0,
    lockedBy: null,
    lockedUntil: null,
    attempt: 0,
    maxAttempts: 2,
    resultUrl: null,
    mediaAssetId: null,
    errorClass: null,
    errorCode: null,
    costCents: 0,
    estimatedCostCents: 0,
    subjectType: 'other',
    subjectId: null,
    createdAt: new Date(0),
    finishedAt: null,
    ...overrides,
  };
}
