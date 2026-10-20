/**
 * 请求签名与时间戳防重放（M1 占位实现）。
 *
 * ⚠️ 平台签名算法**未核验**：docs/01 §3 #6「签名是否含时间戳与允许偏差」仍为待填。
 * 因此本文件不声称自己实现了拼多多签名：
 * - 头部名与材料格式均为本系统内部占位协议（`placeholder-hmac-sha256-v0`）；
 * - 核验后只需实现同一个 `RequestSigner` 接口并替换 `PlaceholderHmacSha256Signer`，
 *   `PddClient` 与留档逻辑不需要改。
 *
 * 防重放做两件事：
 * 1) 时间戳必须在允许窗口内（本地生成，不依赖平台时钟）；
 * 2) nonce 在窗口内只能出现一次（入站回调可使用同一个 Guard 校验平台推送）。
 */

import { createHash, createHmac } from 'node:crypto';
import { newNonce } from '../util/ids.js';

/** 占位签名方案标识；核验后升版并保留旧值用于回放识别。 */
export const PLACEHOLDER_SIGNATURE_SCHEME = 'placeholder-hmac-sha256-v0';

/** 头部名是内部约定，不是平台事实；核验后按官方文档替换。 */
export const SIGNATURE_HEADERS = {
  appKey: 'x-pdd-app-key',
  accessToken: 'x-pdd-access-token',
  timestamp: 'x-pdd-timestamp',
  nonce: 'x-pdd-nonce',
  signature: 'x-pdd-signature',
  scheme: 'x-pdd-signature-scheme',
} as const;

export const SIGNATURE_TODO =
  '待填：拼多多签名算法与时间戳容忍窗口（docs/01 §3 #6）。当前为 M0 占位实现，核验后替换 RequestSigner，不得把占位头当平台契约。';

export interface SigningContext {
  method: string;
  /** 请求路径（含 query 时由调用方传入完整 path）。 */
  path: string;
  /** 已序列化的请求体；GET 传空字符串。 */
  bodyText: string;
  timestampMs: number;
  nonce: string;
  appKey: string;
  appSecret: string;
  accessToken: string | null;
}

export interface RequestSigner {
  readonly scheme: string;
  /** 返回需要合并进请求头的键值（含 app key/timestamp/nonce/signature）。 */
  sign(context: SigningContext): Record<string, string>;
}

export function computeSha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 签名材料：method + path + 时间戳 + nonce + body sha256，换行分隔。 */
export function buildPlaceholderSignatureMaterial(
  context: Omit<SigningContext, 'appKey' | 'appSecret' | 'accessToken'>,
): string {
  return [
    context.method.toUpperCase(),
    context.path,
    String(context.timestampMs),
    context.nonce,
    computeSha256Hex(context.bodyText),
  ].join('\n');
}

/** 计算占位 HMAC-SHA256 签名（hex）。算法本身是内部占位，不是平台事实。 */
export function computePlaceholderSignature(context: SigningContext): string {
  const material = buildPlaceholderSignatureMaterial(context);
  return createHmac('sha256', context.appSecret).update(material, 'utf8').digest('hex');
}

export class PlaceholderHmacSha256Signer implements RequestSigner {
  readonly scheme = PLACEHOLDER_SIGNATURE_SCHEME;

  sign(context: SigningContext): Record<string, string> {
    const headers: Record<string, string> = {
      [SIGNATURE_HEADERS.appKey]: context.appKey,
      [SIGNATURE_HEADERS.timestamp]: String(context.timestampMs),
      [SIGNATURE_HEADERS.nonce]: context.nonce,
      [SIGNATURE_HEADERS.signature]: computePlaceholderSignature(context),
      [SIGNATURE_HEADERS.scheme]: this.scheme,
    };
    if (context.accessToken) headers[SIGNATURE_HEADERS.accessToken] = context.accessToken;
    return headers;
  }
}

/* ------------------------------------------------------------------ */
/* 时间戳防重放                                                        */
/* ------------------------------------------------------------------ */

export type ReplayVerdict =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'future' | 'replayed'; detail: Record<string, unknown> };

export interface TimestampReplayGuardOptions {
  windowMs: number;
  clock?: () => number;
  /** 最多保留的 nonce 数；超限淘汰最旧。 */
  maxEntries?: number;
}

/**
 * 时间窗 + nonce 去重。出站签名与入站回调共用。
 * 注意：内存实现只防单进程重放；多实例需换 Redis（M4 写入门任务落地）。
 */
export class TimestampReplayGuard {
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();

  constructor(options: TimestampReplayGuardOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error(`TimestampReplayGuard.windowMs 必须为正数，实际 ${options.windowMs}`);
    }
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? Date.now;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  get size(): number {
    this.prune();
    return this.seen.size;
  }

  check(timestampMs: number, nonce: string): ReplayVerdict {
    if (!Number.isInteger(timestampMs) || timestampMs <= 0) {
      return { ok: false, reason: 'expired', detail: { timestamp_ms: timestampMs } };
    }
    if (nonce.trim() === '') {
      return { ok: false, reason: 'replayed', detail: { nonce: '' } };
    }
    this.prune();
    const now = this.clock();
    const skew = now - timestampMs;
    if (skew > this.windowMs) {
      return { ok: false, reason: 'expired', detail: { skew_ms: skew, window_ms: this.windowMs } };
    }
    if (skew < -this.windowMs) {
      return { ok: false, reason: 'future', detail: { skew_ms: skew, window_ms: this.windowMs } };
    }
    if (this.seen.has(nonce)) {
      return { ok: false, reason: 'replayed', detail: { nonce } };
    }
    this.seen.set(nonce, timestampMs);
    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    return { ok: true };
  }

  reset(): void {
    this.seen.clear();
  }

  private prune(): void {
    const cutoff = this.clock() - this.windowMs;
    for (const [nonce, timestamp] of this.seen) {
      if (timestamp < cutoff) this.seen.delete(nonce);
    }
  }
}

/** 为一次出站调用生成不重复的 (timestamp, nonce)。 */
export function reserveOutboundNonce(
  guard: TimestampReplayGuard,
  clock: () => number,
): { timestampMs: number; nonce: string } {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const timestampMs = clock();
    const nonce = newNonce();
    if (guard.check(timestampMs, nonce).ok) return { timestampMs, nonce };
  }
  throw new Error('无法生成唯一 nonce（TimestampReplayGuard 拒绝 5 次）');
}
