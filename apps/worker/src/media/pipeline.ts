/**
 * 媒体管线状态机（M6 机制实现）。
 *
 * 设计要点：
 * - 依赖 repo/storage/provider/clock 注入：单测不需要数据库，也不需要真实供应商；
 * - 状态推进一次只走一步（submit → poll → retrieve/store），由 poller 反复调用；
 * - 幂等：provider 以 idempotencyKey 去重，asset 以 mediaJobId 只建一次，
 *   cost_ledger 以 refId 只记一次；
 * - 取消：非终态置 cancelled，并清理 `mock/_tmp/<jobId>/` 临时对象；
 * - 失败：retryable 按 attempt 重投；manual/permanent 直接 failed（error_class 落库）；
 * - 多实例：claimDueJobs（FOR UPDATE SKIP LOCKED + locked_by/until 租约）+ 30s 心跳续租，
 *   续租失败立即放弃写入；poll_after 只表示下次轮询时间。
 */
import { randomUUID } from 'node:crypto';
import { backoffDelayMs } from './backoff.js';
import {
  MEDIA_BUCKET,
  chartObjectKey,
  mimeToExt,
  sourceObjectKey,
  tempPrefix,
  variantObjectKey,
} from './keys.js';
import { renderImageVariants, renderSizeChart, type SizeChartInput } from './render.js';
import type { ObjectStorage } from './storage.js';
import { sha256Hex } from './storage.js';
import type { MediaProvider } from './provider.js';
import type {
  Clock,
  MediaAssetRecord,
  MediaErrorClass,
  MediaJobRecord,
  MediaJobStatus,
  MediaRepository,
  VariantMeta,
  CostLedgerEntry,
} from './types.js';
import { systemClock } from './types.js';

export class MediaPipelineError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'quota' | 'provider' | 'storage',
    message: string,
  ) {
    super(message);
    this.name = 'MediaPipelineError';
  }
}

export class QuotaExceededError extends MediaPipelineError {
  constructor(message: string, public readonly used: number, public readonly max: number | null) {
    super('quota', message);
    this.name = 'QuotaExceededError';
  }
}

export interface MediaPipelineDeps {
  repo: MediaRepository;
  storage: ObjectStorage;
  provider: MediaProvider;
  clock?: Clock;
  random?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void };
  /** 多实例租约：worker 标识 / 租约时长 / 心跳间隔。 */
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

export class LeaseLostError extends MediaPipelineError {
  constructor(jobId: string) {
    super('conflict', `媒体任务租约已丢失（${jobId}），放弃本次处理`);
    this.name = 'LeaseLostError';
  }
}

const TERMINAL: MediaJobStatus[] = ['succeeded', 'failed', 'expired', 'cancelled'];

function isAigc(job: MediaJobRecord): boolean {
  const source = typeof job.params.source === 'string' ? job.params.source : '';
  const kind = typeof job.params.kind === 'string' ? job.params.kind : '';
  return source === 'ai_generated' || ['scene', 'model', 'concept', 'short_video'].includes(kind);
}

function assetKind(job: MediaJobRecord): string {
  if (typeof job.params.kind === 'string' && job.params.kind !== '') return job.params.kind;
  if (job.purpose === 'render') return 'size_chart';
  if (job.purpose === 'video') return 'video';
  return 'scene';
}

export class MediaPipeline {
  private readonly clock: Clock;
  private readonly random: () => number;
  readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly leaseLost = new Set<string>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: MediaPipelineDeps) {
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseMs = deps.leaseMs ?? 90_000;
    this.heartbeatMs = deps.heartbeatMs ?? 30_000;
  }

  private now(): Date {
    return this.clock.now();
  }

  /** 处理一个任务：按当前状态推进一步；终态直接返回。 */
  async advance(jobId: string): Promise<MediaJobRecord> {
    const job = await this.deps.repo.getJob(jobId);
    if (!job) throw new MediaPipelineError('not_found', `媒体任务不存在：${jobId}`);
    if (TERMINAL.includes(job.status)) {
      if (job.status === 'cancelled') await this.cleanupTemp(job);
      return job;
    }
    const guarded = job.lockedBy !== null && job.lockedBy === this.workerId;
    if (guarded) this.startHeartbeat(job.id);
    try {
      if (!job.externalJobId && job.status !== 'retrieved') return await this.submit(job);
      if (job.status === 'retrieved') return await this.store(job);
      return await this.poll(job);
    } finally {
      this.stopHeartbeat(job.id);
      if (guarded) await this.release(job.id);
    }
  }

  private startHeartbeat(jobId: string): void {
    if (this.heartbeats.has(jobId)) return;
    const timer = setInterval(() => {
      if (this.leaseLost.has(jobId)) return;
      void this.deps.repo
        .renewLease(jobId, this.workerId, this.leaseMs)
        .then((ok) => {
          if (!ok) this.leaseLost.add(jobId);
        })
        .catch(() => {
          this.leaseLost.add(jobId);
        });
    }, this.heartbeatMs);
    timer.unref();
    this.heartbeats.set(jobId, timer);
  }

  private stopHeartbeat(jobId: string): void {
    const timer = this.heartbeats.get(jobId);
    if (timer) clearInterval(timer);
    this.heartbeats.delete(jobId);
  }

  /** 每次写库/落对象前确认租约仍在；失租立即抛错，禁止继续写。 */
  private async ensureLease(job: MediaJobRecord): Promise<void> {
    if (job.lockedBy === null || job.lockedBy !== this.workerId) return;
    if (this.leaseLost.has(job.id)) throw new LeaseLostError(job.id);
    const ok = await this.deps.repo.renewLease(job.id, this.workerId, this.leaseMs);
    if (!ok) {
      this.leaseLost.add(job.id);
      throw new LeaseLostError(job.id);
    }
  }

  /** 带租约守卫的更新：锁定任务必须用 locked_by 条件更新；失败即放弃。 */
  private async persist(
    job: MediaJobRecord,
    patch: Partial<MediaJobRecord>,
  ): Promise<MediaJobRecord> {
    const next = { ...job, ...patch };
    if (job.lockedBy !== null && job.lockedBy === this.workerId) {
      const ok = await this.deps.repo.updateLockedJob(job.id, this.workerId, patch);
      if (!ok) {
        this.leaseLost.add(job.id);
        throw new LeaseLostError(job.id);
      }
    } else {
      await this.deps.repo.updateJob(job.id, patch);
    }
    return next;
  }

  /** 单步处理结束释放租约；poll_after 仍是下次轮询时间，不受租约影响。 */
  private async release(jobId: string): Promise<void> {
    if (this.leaseLost.has(jobId)) return;
    try {
      await this.deps.repo.updateLockedJob(jobId, this.workerId, {
        lockedBy: null,
        lockedUntil: null,
      });
    } catch {
      // 释放失败只会让租约自然过期，不影响正确性。
    }
  }

  /** 提交：先做配额判定，再向 provider 提交并设置首次轮询时间。 */
  private async submit(job: MediaJobRecord): Promise<MediaJobRecord> {
    await this.ensureLease(job);
    const now = this.now();
    const quota = await this.deps.repo.checkQuota(job, now);
    if (!quota.allowed) {
      await this.persist(job, {
        status: 'failed',
        errorClass: 'manual',
        errorCode: 'quota',
        finishedAt: now,
      });
      throw new QuotaExceededError(
        quota.message ?? `媒体配额已用完（${quota.used}/${quota.max ?? '∞'}），请明天再试或联系管理员`,
        quota.used,
        quota.max,
      );
    }
    const { externalJobId } = await this.deps.provider.submit({
      jobId: job.id,
      idempotencyKey: job.idempotencyKey,
      purpose: job.purpose,
      params: job.params,
    });
    const delay = backoffDelayMs(job.purpose, 0, this.random);
    const updated: MediaJobRecord = {
      ...job,
      externalJobId,
      status: 'submitted',
      pollCount: 0,
      pollAfter: new Date(now.getTime() + delay),
    };
    await this.persist(job, updated);
    return updated;
  }

  private async poll(job: MediaJobRecord): Promise<MediaJobRecord> {
    await this.ensureLease(job);
    const now = this.now();
    const result = await this.deps.provider.poll(job.externalJobId as string);
    const maxPoll = typeof job.params.max_poll === 'number' ? job.params.max_poll : 60;

    if (result.status === 'processing') {
      const pollCount = job.pollCount + 1;
      if (pollCount > maxPoll) {
        const updated: MediaJobRecord = {
          ...job,
          status: 'expired',
          errorClass: 'manual',
          errorCode: 'poll_exhausted',
          pollCount,
          finishedAt: now,
        };
        await this.persist(job, updated);
        return updated;
      }
      const delay = backoffDelayMs(job.purpose, pollCount, this.random);
      const updated: MediaJobRecord = {
        ...job,
        status: 'polling',
        pollCount,
        pollAfter: new Date(now.getTime() + delay),
      };
      await this.persist(job, updated);
      return updated;
    }

    if (result.status === 'failed') {
      const retryable = result.errorClass === 'retryable';
      if (retryable && job.attempt < job.maxAttempts) {
        const attempt = job.attempt + 1;
        const delay = backoffDelayMs(job.purpose, attempt, this.random);
        const updated: MediaJobRecord = {
          ...job,
          status: 'queued',
          externalJobId: null,
          attempt,
          pollCount: 0,
          errorClass: 'retryable',
          errorCode: result.code,
          pollAfter: new Date(now.getTime() + delay),
        };
        await this.persist(job, updated);
        return updated;
      }
      const updated: MediaJobRecord = {
        ...job,
        status: 'failed',
        errorClass: result.errorClass,
        errorCode: result.code,
        finishedAt: now,
      };
      await this.persist(job, updated);
      return updated;
    }

    // 供应商成功：进入取回阶段；usage 成本先记到 job.costCents，落库时使用。
    const updated: MediaJobRecord = {
      ...job,
      status: 'retrieved',
      resultUrl: result.resultUrl,
      costCents: result.usage.costCents,
      pollAfter: now,
    };
    await this.persist(job, updated);
    return updated;
  }

  private async store(job: MediaJobRecord): Promise<MediaJobRecord> {
    await this.ensureLease(job);
    const existing = await this.deps.repo.getAssetByJob(job.id);
    if (existing) return this.finalize(job, existing);

    try {
      return job.purpose === 'render' ? await this.storeRenderedChart(job) : await this.storeProviderAsset(job);
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const attempt = job.attempt + 1;
      if (attempt <= job.maxAttempts) {
        const delay = backoffDelayMs(job.purpose, attempt, this.random);
        const updated: MediaJobRecord = {
          ...job,
          status: 'queued',
          externalJobId: null,
          attempt,
          errorClass: 'retryable',
          errorCode: 'store_failed',
          pollAfter: new Date(this.now().getTime() + delay),
        };
        await this.persist(job, updated);
        this.deps.log?.warn({ jobId: job.id, message }, '媒体落库失败，已安排重试');
        return updated;
      }
      const updated: MediaJobRecord = {
        ...job,
        status: 'failed',
        errorClass: 'permanent',
        errorCode: 'store_failed',
        finishedAt: this.now(),
      };
      await this.persist(job, updated);
      return updated;
    }
  }

  private async storeProviderAsset(job: MediaJobRecord): Promise<MediaJobRecord> {
    await this.ensureLease(job);
    const now = this.now();
    const fetched = await this.deps.provider.fetch(job.externalJobId as string);
    const kind = assetKind(job);
    const ext = mimeToExt(fetched.mime);
    const assetId = randomUUID();
    const base = {
      kind,
      orgId: job.orgId,
      at: now,
      assetId,
    };
    const sourceKey = sourceObjectKey({ ...base, ext });
    const tempKey = `${tempPrefix(job.id)}source.${ext}`;

    // 临时对象：取消时按 `mock/_tmp/<jobId>/` 前缀清理。
    await this.deps.storage.put(MEDIA_BUCKET, tempKey, fetched.bytes, fetched.mime);
    await this.deps.storage.put(MEDIA_BUCKET, sourceKey, fetched.bytes, fetched.mime);

    const aigc = isAigc(job);
    const rendered = await renderImageVariants(fetched.bytes, { aigc });
    const variants: VariantMeta[] = [];
    for (const variant of rendered) {
      const key = variantObjectKey({ ...base, variantKey: variant.key, ext: 'webp' });
      await this.deps.storage.put(MEDIA_BUCKET, key, variant.buffer, variant.mime);
      variants.push({
        key: variant.key,
        bucket: MEDIA_BUCKET,
        objectKey: key,
        sha256: variant.sha256,
        mime: variant.mime,
        width: variant.width,
        height: variant.height,
        bytes: variant.bytes,
        aigcLabeled: variant.aigcLabeled,
      });
    }

    const metadata = await import('sharp').then(({ default: sharp }) => sharp(fetched.bytes).metadata());
    const sourceSha = sha256Hex(fetched.bytes);
    const asset: MediaAssetRecord = {
      id: assetId,
      orgId: job.orgId,
      kind,
      source: aigc ? 'ai_generated' : (typeof job.params.source === 'string' ? job.params.source : 'shoot'),
      bucket: MEDIA_BUCKET,
      objectKey: sourceKey,
      sha256: sourceSha,
      mime: fetched.mime,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      bytes: BigInt(fetched.bytes.length),
      variants,
      aigcLabeled: aigc,
      aigcMeta: aigc
        ? { text: 'AI 生成', position: 'bottom-right', variant_scope: 'all', model_id: job.modelId }
        : null,
      status: 'pending_review',
      mediaJobId: job.id,
      costCents: job.costCents,
    };
    await this.ensureLease(job);
    await this.deps.repo.saveAsset(asset);
    await this.deps.repo.consumeQuota(job, now, 1);
    const seconds = job.purpose === 'video' && typeof job.params.duration_seconds === 'number'
      ? job.params.duration_seconds
      : 0;
    await this.addCostIfMissing(job, job.costCents, seconds, now);
    await this.deps.storage.delete(MEDIA_BUCKET, tempKey);
    return this.finalize(job, asset);
  }

  private async storeRenderedChart(job: MediaJobRecord): Promise<MediaJobRecord> {
    await this.ensureLease(job);
    const now = this.now();
    const raw = job.params.size_chart;
    if (!raw || typeof raw !== 'object') throw new Error('render 任务缺少 params.size_chart');
    const input = raw as unknown as SizeChartInput;
    const renderInput: SizeChartInput = {
      ...input,
      effectiveFrom: new Date(input.effectiveFrom),
    };
    const rendered = await renderSizeChart(renderInput);
    const assetId = randomUUID();
    const base = { kind: 'size_chart', orgId: job.orgId, at: now, assetId };
    const variants: VariantMeta[] = [];
    for (const chart of rendered.charts) {
      const ext = chart.key === 'chart_750' ? '' : '_1200';
      const key = chartObjectKey({ ...base, dataVersion: `${rendered.dataVersion}${ext}` });
      await this.deps.storage.put(MEDIA_BUCKET, key, chart.buffer, chart.mime);
      variants.push({
        key: chart.key,
        bucket: MEDIA_BUCKET,
        objectKey: key,
        sha256: chart.sha256,
        mime: chart.mime,
        width: chart.width,
        height: chart.height,
        bytes: chart.bytes,
        aigcLabeled: false,
      });
    }
    const first = variants[0];
    if (!first) throw new Error('尺码表渲染未产出图表');
    const asset: MediaAssetRecord = {
      id: assetId,
      orgId: job.orgId,
      kind: 'size_chart',
      source: 'rendered',
      bucket: MEDIA_BUCKET,
      objectKey: first.objectKey,
      sha256: first.sha256,
      mime: 'image/png',
      width: first.width,
      height: first.height,
      bytes: BigInt(first.bytes),
      variants,
      aigcLabeled: false,
      aigcMeta: null,
      status: 'pending_review',
      mediaJobId: job.id,
      costCents: 0,
    };
    await this.ensureLease(job);
    await this.deps.repo.saveAsset(asset);
    await this.addCostIfMissing(job, 0, 0.5, now);
    return this.finalize(job, asset);
  }

  private async addCostIfMissing(
    job: MediaJobRecord,
    amountCents: number,
    seconds: number,
    at: Date,
  ): Promise<void> {
    if (await this.deps.repo.hasMediaCost(job.id)) return;
    await this.ensureLease(job);
    const entry: CostLedgerEntry = {
      orgId: job.orgId,
      kind: 'media',
      refType: 'media_job',
      refId: job.id,
      tokens: 0,
      seconds,
      amountCents,
      occurredAt: at,
    };
    await this.deps.repo.addCostLedger(entry);
  }

  private async finalize(job: MediaJobRecord, asset: MediaAssetRecord): Promise<MediaJobRecord> {
    const updated: MediaJobRecord = {
      ...job,
      status: 'succeeded',
      mediaAssetId: asset.id,
      costCents: asset.costCents,
      errorClass: null,
      errorCode: null,
      finishedAt: job.finishedAt ?? this.now(),
    };
    await this.persist(job, updated);
    return updated;
  }

  /** 取消：非终态置 cancelled，尽力通知供应商并清理临时对象；重复取消幂等。 */
  async cancel(jobId: string, reason = 'user'): Promise<MediaJobRecord> {
    const job = await this.deps.repo.getJob(jobId);
    if (!job) throw new MediaPipelineError('not_found', `媒体任务不存在：${jobId}`);
    if (job.status === 'succeeded') {
      throw new MediaPipelineError('conflict', '任务已完成，不能取消（可归档资产）');
    }
    if (job.status === 'cancelled') {
      await this.cleanupTemp(job);
      return job;
    }
    if (job.status === 'failed' || job.status === 'expired') {
      await this.cleanupTemp(job);
      return job;
    }
    await this.persist(job, {
      status: 'cancelled',
      errorCode: reason === 'user' ? 'cancelled_by_user' : reason,
      finishedAt: this.now(),
    });
    if (job.externalJobId) {
      try {
        await this.deps.provider.cancel(job.externalJobId);
      } catch {
        // 供应商不支持取消时忽略；本地已停止推进。
      }
    }
    await this.cleanupTemp(job);
    return { ...job, status: 'cancelled', errorCode: 'cancelled_by_user', finishedAt: this.now() };
  }

  async cleanupTemp(job: MediaJobRecord): Promise<void> {
    const prefix = tempPrefix(job.id);
    try {
      const keys = await this.deps.storage.list(MEDIA_BUCKET, prefix);
      for (const key of keys) await this.deps.storage.delete(MEDIA_BUCKET, key);
    } catch (error) {
      this.deps.log?.warn({ jobId: job.id, error }, '清理媒体临时对象失败');
    }
  }

  /** 对已取消任务做一次清理（poller 周期调用，幂等）。 */
  async cleanupCancelled(limit = 20): Promise<void> {
    const jobs = await this.deps.repo.listCancelledJobs(limit);
    for (const job of jobs) await this.cleanupTemp(job);
  }

  /** 扫描到期任务并逐个推进；单个任务失败不影响其余任务。 */
  async runDue(limit = 10): Promise<MediaJobRecord[]> {
    const jobs = await this.deps.repo.claimDueJobs(this.now(), limit, this.workerId, this.leaseMs);
    const results: MediaJobRecord[] = [];
    for (const job of jobs) {
      try {
        results.push(await this.advance(job.id));
      } catch (error) {
        this.deps.log?.warn({ jobId: job.id, error }, '媒体任务推进失败');
      }
    }
    return results;
  }
}

export type StoreErrorClass = MediaErrorClass;
