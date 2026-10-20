/**
 * 签名与请求指纹 —— 1688 侧的签名算法**未核验**（`TODO-1688-003`）。
 *
 * 本模块只定义两件确定的事：
 * 1. `RequestSigner` 是唯一的签名入口：真实算法由 edge-proxy / 后续适配实现，
 *    在拿到文档前只能是 `UNVERIFIED_SIGNER`（调用即失败，绝不伪造签名）；
 * 2. `canonicalizeParams()` / `requestFingerprint()` 是**我方内部**的规范化算法
 *    （排序 + percent-encoding + sha256），用于录制回放匹配与幂等键，
 *    与平台签名算法无关，不得混为一谈。
 *
 * 为什么签名不放在 `Alibaba1688Client` 内部：docs/00 §8.2 明确 edge-proxy 负责
 * 「请求签名、时间戳防重放、报文留档」，中心侧只做业务编排。这里的 signer 接口就是
 * 那条边界：中心侧给「参数 + 时间戳 + nonce」，签名实现可以下沉。
 */

import { createHash } from 'node:crypto';
import { AdapterError } from '../errors.js';
import { describeTodo } from '../todo.js';
import type { HttpRequest } from './types.js';

export interface SignInput {
  /** 平台 method 名；未核验时为 `null`（此时签名器必须拒绝）。 */
  method: string | null;
  /** 业务参数 + 公共参数（不含签名本身）。 */
  params: Record<string, string>;
  /** 请求体原文（form 或 JSON，协议未核验）。 */
  body: string | null;
  /** 毫秒时间戳；由调用方注入，录制时可固定。 */
  timestamp: number;
  /** 防重放随机串；由调用方注入，录制时用序号。 */
  nonce: string;
}

export interface SignedRequest {
  /** 需要附加到 header 的签名相关字段。 */
  headers: Record<string, string>;
  /** 需要附加到 query 的签名相关字段。 */
  query: Record<string, string>;
}

export interface RequestSigner {
  readonly id: string;
  /** 是否已按平台文档实现并对齐过 fixture；`false` 时客户端拒绝发送。 */
  readonly verified: boolean;
  sign(input: SignInput): SignedRequest;
}

/**
 * 未核验签名器：调用即抛 `CONTRACT_NOT_VERIFIED`。
 * 这是**默认**签名器 —— 在 `TODO-1688-003` 关闭前，任何真实调用都会在这里被挡住。
 */
export const UNVERIFIED_SIGNER: RequestSigner = {
  id: 'unverified/1688',
  verified: false,
  sign(): never {
    throw AdapterError.contractNotVerified(
      `1688 签名算法未核验，禁止构造真实请求：${describeTodo('TODO-1688-003')}`,
      ['TODO-1688-003'],
      { signer: 'unverified/1688' },
    );
  },
};

/** 参数规范化：按键排序、`key=value` 用 `&` 连接，值用严格 percent-encoding。 */
export function canonicalizeParams(params: Readonly<Record<string, string>>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
}

/**
 * 请求指纹（录制回放匹配键 / 幂等键素材）。
 * 覆盖 method、URL、body 与**白名单内的** header；不覆盖时间戳/nonce 等易变字段
 * （它们在录制时被脱敏，见 `archive.ts` 的 redaction 规则）。
 */
export function requestFingerprint(request: Pick<HttpRequest, 'method' | 'url' | 'headers' | 'body'>): string {
  const headerKeys = Object.keys(request.headers)
    .map((key) => key.toLowerCase())
    .filter((key) => !VOLATILE_HEADER_KEYS.has(key))
    .sort();
  const headers = headerKeys.map((key) => [key, request.headers[key] ?? ''] as const);
  const canonical = JSON.stringify({
    method: request.method,
    url: request.url,
    headers,
    body: request.body,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 不参与指纹的易变 header（签名/时间戳/随机串/请求 id）。 */
export const VOLATILE_HEADER_KEYS = new Set([
  'sign',
  'signature',
  'timestamp',
  'ts',
  'nonce',
  'x-request-id',
  'authorization',
  'cookie',
  'date',
]);
