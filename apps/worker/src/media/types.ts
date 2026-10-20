/**
 * M6 媒体管线核心类型（不依赖 Prisma，便于测试注入）。
 *
 * 状态集合与 docs/10 §5.1 对齐，落库时用 06 的 9 个值：
 * queued / submitted / polling / retrieved / stored / succeeded / failed / expired / cancelled。
 */
export type MediaJobStatus =
  | 'queued'
  | 'submitted'
  | 'polling'
  | 'retrieved'
  | 'stored'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type MediaPurpose = 'image' | 'video' | 'render';

/** 06 已有三值 CHECK；本任务不扩 uncertain/guard。 */
export type MediaErrorClass = 'retryable' | 'manual' | 'permanent';

export interface MediaJobRecord {
  id: string;
  orgId: bigint;
  purpose: MediaPurpose;
  status: MediaJobStatus;
  params: Record<string, unknown>;
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
  errorClass: MediaErrorClass | null;
  errorCode: string | null;
  costCents: number;
  estimatedCostCents: number;
  subjectType: string;
  subjectId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface VariantMeta {
  key: string;
  bucket: string;
  objectKey: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  aigcLabeled: boolean;
}

export interface MediaAssetRecord {
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
  variants: VariantMeta[];
  aigcLabeled: boolean;
  aigcMeta: Record<string, unknown> | null;
  status: string;
  mediaJobId: string;
  costCents: number;
}

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  max: number | null;
  /** 超限时给用户的可读文案。 */
  message?: string;
}

export interface CostLedgerEntry {
  orgId: bigint;
  kind: 'media';
  refType: 'media_job';
  refId: string;
  tokens: number;
  seconds: number;
  amountCents: number;
  occurredAt: Date;
}

/** 仓储端口：Prisma 实现见 prisma-repository.ts；测试用内存实现。 */
export interface MediaRepository {
  getJob(id: string): Promise<MediaJobRecord | null>;
  updateJob(id: string, patch: Partial<MediaJobRecord>): Promise<void>;
  listDueJobs(now: Date, limit: number): Promise<MediaJobRecord[]>;
  /** 原子抢占可执行任务：FOR UPDATE SKIP LOCKED + 租约（workerId/lockedUntil）。 */
  claimDueJobs(now: Date, limit: number, workerId: string, leaseMs: number): Promise<MediaJobRecord[]>;
  /** 心跳续租；返回 false 表示租约已丢失（被抢占/过期被接手）。 */
  renewLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  /** 带租约守卫的更新；返回 false 表示租约已丢失，调用方必须立即停止写入。 */
  updateLockedJob(jobId: string, workerId: string, patch: Partial<MediaJobRecord>): Promise<boolean>;
  listCancelledJobs(limit: number): Promise<MediaJobRecord[]>;
  getAssetByJob(jobId: string): Promise<MediaAssetRecord | null>;
  saveAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord>;
  checkQuota(job: MediaJobRecord, now: Date): Promise<QuotaDecision>;
  consumeQuota(job: MediaJobRecord, now: Date, images: number): Promise<void>;
  hasMediaCost(jobId: string): Promise<boolean>;
  addCostLedger(entry: CostLedgerEntry): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
