/**
 * 测试替身（**只用于测试与本地回放**，不是平台实现）。
 *
 * 三个必须显式可注入的依赖：时钟、随机、transport。没有它们就无法做到
 * docs/15 §4.2.4 的「录制时固定 timestamp 与 nonce」。
 *
 * 关于 `createTestSigner`：
 * - 它用 HMAC-SHA256 对规范化参数签名，**不是** 1688 的签名算法（那未核验）；
 * - 它的存在只为验证「签名可复算 + 签名头进入请求」这条管线行为；
 * - `id` 明确带 `test-only/` 前缀，避免被误当成生产实现。
 */

import { createHmac } from 'node:crypto';
import { AdapterError } from '../errors.js';
import type { SignedRequest, SignInput, RequestSigner } from '../client/signature.js';
import { canonicalizeParams } from '../client/signature.js';
import type { Clock, HttpResponse, RandomSource, Transport } from '../client/types.js';

/** 可拨动的时钟：`sleep()` 不真等待，直接推进虚拟时间并记录睡眠时长。 */
export class FixedClock implements Clock {
  private current: number;
  readonly sleeps: number[] = [];

  constructor(startIso = '2026-10-20T02:00:00.000Z') {
    this.current = Date.parse(startIso);
  }

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += Math.max(0, ms);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

/** 确定性伪随机（mulberry32），保证回放/快照稳定。 */
export class SeededRandom implements RandomSource {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export type TransportHandler = (request: Parameters<Transport['request']>[0], attempt: number) => HttpResponse | Promise<HttpResponse>;

/** 可控 transport：记录所有请求，按 handler 返回响应；不触网。 */
export class FakeTransport implements Transport {
  readonly requests: Array<Parameters<Transport['request']>[0]> = [];
  private attempt = 0;

  constructor(private readonly handler: TransportHandler) {}

  async request(request: Parameters<Transport['request']>[0]): Promise<HttpResponse> {
    this.requests.push(request);
    this.attempt += 1;
    return this.handler(request, this.attempt);
  }
}

/** JSON 响应构造器。 */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

/**
 * **仅测试**的签名器：HMAC-SHA256(secret, canonicalize(params) + body + timestamp + nonce)。
 * 它不是 1688 的真实算法；`verified: true` 只代表「测试管线可放行」。
 */
export function createTestSigner(secret = 'test-secret'): RequestSigner {
  return {
    id: 'test-only/hmac-sha256',
    verified: true,
    sign(input: SignInput): SignedRequest {
      const payload = [canonicalizeParams(input.params), input.body ?? '', String(input.timestamp), input.nonce].join('\n');
      const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
      return { headers: { 'x-test-signature': signature }, query: {} };
    },
  };
}

/** 永远失败的 transport：用于断言「契约未核验时根本不发请求」。 */
export class ForbiddenTransport implements Transport {
  calls = 0;

  async request(): Promise<HttpResponse> {
    this.calls += 1;
    throw new AdapterError({ code: 'NETWORK', message: '测试期禁止真实网络（docs/15 §4.3 disableNetConnect）', retryable: false });
  }
}
