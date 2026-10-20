/**
 * 媒体供应商端口 + mock 实现（M6 机制验证用；真实厂商等用户给 model id）。
 *
 * MockMediaProvider 的行为完全确定性：
 * - submit 以 idempotencyKey 去重，同一键返回同一 externalJobId；
 * - poll 先返回 pendingPolls 次 processing，再 succeeded（可注入失败分类）；
 * - fetch 返回一张由 SVG 栅格化的 PNG（1200×1600），供变体/落库链路使用。
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { MediaErrorClass, MediaPurpose } from './types.js';

export interface ProviderSubmitInput {
  jobId: string;
  idempotencyKey: string;
  purpose: MediaPurpose;
  params: Record<string, unknown>;
}

export interface ProviderUsage {
  images: number;
  seconds: number;
  costCents: number;
}

export type ProviderPollResult =
  | { status: 'processing' }
  | { status: 'succeeded'; resultUrl: string; usage: ProviderUsage }
  | { status: 'failed'; errorClass: MediaErrorClass; code: string; message: string };

export interface MediaProvider {
  submit(input: ProviderSubmitInput): Promise<{ externalJobId: string }>;
  poll(externalJobId: string): Promise<ProviderPollResult>;
  fetch(externalJobId: string): Promise<{ bytes: Buffer; mime: string }>;
  cancel(externalJobId: string): Promise<{ supported: boolean }>;
}

interface MockJobState {
  externalJobId: string;
  idempotencyKey: string;
  purpose: MediaPurpose;
  pendingPolls: number;
  polls: number;
  failMode: MediaErrorClass | null;
  costCents: number;
  cancelled: boolean;
}

export interface MockProviderOptions {
  pendingPolls?: number;
  costCents?: number;
  width?: number;
  height?: number;
}

function mockImage(width: number, height: number): Promise<Buffer> {
  // 简单平铺"服装"图，避免依赖外部素材；PNG 输出确定。
  const shirt = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#e9eef3"/>
      <rect x="${width * 0.18}" y="${height * 0.12}" width="${width * 0.64}" height="${height * 0.72}" rx="${width * 0.03}" fill="#7f9bb5"/>
      <rect x="${width * 0.1}" y="${height * 0.16}" width="${width * 0.16}" height="${height * 0.34}" rx="${width * 0.03}" fill="#6c88a1"/>
      <rect x="${width * 0.74}" y="${height * 0.16}" width="${width * 0.16}" height="${height * 0.34}" rx="${width * 0.03}" fill="#6c88a1"/>
      <rect x="${width * 0.38}" y="${height * 0.12}" width="${width * 0.24}" height="${height * 0.07}" rx="${width * 0.02}" fill="#d9e2ea"/>
      <text x="${width / 2}" y="${height * 0.9}" font-family="sans-serif" font-size="${Math.round(width * 0.035)}" text-anchor="middle" fill="#4b5b6b">MOCK PROVIDER</text>
    </svg>`;
  return sharp(Buffer.from(shirt)).png().toBuffer();
}

export class MockMediaProvider implements MediaProvider {
  private readonly byIdempotency = new Map<string, MockJobState>();
  private readonly byExternal = new Map<string, MockJobState>();

  constructor(private readonly options: MockProviderOptions = {}) {}

  async submit(input: ProviderSubmitInput): Promise<{ externalJobId: string }> {
    const existing = this.byIdempotency.get(input.idempotencyKey);
    if (existing) return { externalJobId: existing.externalJobId };
    const externalJobId = `mock_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
    const state: MockJobState = {
      externalJobId,
      idempotencyKey: input.idempotencyKey,
      purpose: input.purpose,
      pendingPolls:
        typeof input.params.pending_polls === 'number'
          ? input.params.pending_polls
          : (this.options.pendingPolls ?? 2),
      polls: 0,
      failMode: null,
      costCents: typeof input.params.cost_cents === 'number' ? input.params.cost_cents : (this.options.costCents ?? 4),
      cancelled: false,
    };
    this.byIdempotency.set(input.idempotencyKey, state);
    this.byExternal.set(externalJobId, state);
    return { externalJobId };
  }

  async poll(externalJobId: string): Promise<ProviderPollResult> {
    const state = this.byExternal.get(externalJobId);
    if (!state) {
      return { status: 'failed', errorClass: 'permanent', code: 'mock_not_found', message: 'mock 任务不存在' };
    }
    if (state.cancelled) {
      return { status: 'failed', errorClass: 'manual', code: 'cancelled', message: 'mock 任务已取消' };
    }
    state.polls += 1;
    if (state.failMode) {
      return {
        status: 'failed',
        errorClass: state.failMode,
        code: `mock_${state.failMode}`,
        message: `mock 供应商返回 ${state.failMode} 失败`,
      };
    }
    if (state.polls <= state.pendingPolls) return { status: 'processing' };
    return {
      status: 'succeeded',
      resultUrl: `memory://mock/${externalJobId}`,
      usage: { images: 1, seconds: 0, costCents: state.costCents },
    };
  }

  async fetch(externalJobId: string): Promise<{ bytes: Buffer; mime: string }> {
    const state = this.byExternal.get(externalJobId);
    if (!state) throw new Error(`mock 任务不存在：${externalJobId}`);
    const bytes = await mockImage(this.options.width ?? 1200, this.options.height ?? 1600);
    return { bytes, mime: 'image/png' };
  }

  async cancel(externalJobId: string): Promise<{ supported: boolean }> {
    const state = this.byExternal.get(externalJobId);
    if (state) state.cancelled = true;
    return { supported: true };
  }

  /** 测试用：注入失败模式（真实实现里由供应商返回码映射）。 */
  setFailMode(externalJobId: string, mode: MediaErrorClass | null): void {
    const state = this.byExternal.get(externalJobId);
    if (state) state.failMode = mode;
  }

  getSubmitCount(): number {
    return this.byExternal.size;
  }
}
