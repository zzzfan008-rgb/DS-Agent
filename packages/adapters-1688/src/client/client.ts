/**
 * 1688 客户端 —— 契约未核验期只允许「计划」，不允许「发送」。
 *
 * 一条调用的完整链路（与 docs/00 §9.2 写入门、docs/15 §4 契约测试对齐）：
 *
 *   plan/execute
 *     → 查注册表（method 未核验即拒绝）
 *     → 本地令牌桶限流（保护性，非平台配额）
 *     → 组装请求 + 签名器（默认 UNVERIFIED_SIGNER，调用即失败）
 *     → transport 发送（真实 fetch / 录制 / 回放）
 *     → 错误分类（429/5xx 可重试，4xx 业务拒绝不可重试）
 *     → 每次尝试写留档（脱敏）
 *     → 返回解析后的 body
 *
 * 为什么 `execute()` 对真实操作永远抛 `CONTRACT_NOT_VERIFIED`：
 * 不是没写完，而是 docs/02 明确「回填完成前不得编写 adapter 代码，也不得按第三方文章/
 * 记忆猜 method 名」。把失败做成显式错误码，比偷偷发一个错请求安全得多。
 */

import { AdapterError } from '../errors.js';
import { canonicalHash } from '../json.js';
import type { TodoId } from '../todo.js';
import {
  type ArchiveEntry,
  type ArchiveSink,
  MemoryArchiveSink,
  archiveRequest,
  archiveResponse,
} from './archive.js';
import { ASSUMED_CLIENT_RATE_LIMIT, TokenBucketRateLimiter, type RateLimiter, type RateLimitConfig } from './limiter.js';
import {
  DEFAULT_CATALOG,
  verificationGaps,
  type OperationCatalog,
  type OperationChannel,
  type OperationDescriptor,
  type RiskLevel,
  type VerificationGap,
} from './registry.js';
import {
  DEFAULT_RETRY_POLICY,
  executeWithRetry,
  parseRetryAfter,
  policyForOperation,
  type RetryPolicy,
} from './retry.js';
import { UNVERIFIED_SIGNER, type RequestSigner } from './signature.js';
import {
  httpTransport,
  systemClock,
  systemRandom,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type RandomSource,
  type Transport,
} from './types.js';

export interface ClientOptions {
  transport?: Transport;
  signer?: RequestSigner;
  limiter?: RateLimiter;
  archive?: ArchiveSink;
  clock?: Clock;
  random?: RandomSource;
  retryPolicy?: RetryPolicy;
  catalog?: OperationCatalog;
  /** 本地限流配置（默认保守假设 `ASSUMED_CLIENT_RATE_LIMIT`）。 */
  limiterConfig?: RateLimitConfig;
  /** 平台调用域名（未核验，必须显式配置）；缺失时 `execute()` 直接失败。 */
  baseUrl?: string | null;
  /** 契约版本（平台文档版本/公告号），用于留档与漂移定位。 */
  contractVersion?: string | null;
}

export interface ExecuteOptions {
  /** 业务参数（键名是平台字段名，未核验前由调用方从契约 fixture 反推，不得猜）。 */
  params?: Record<string, string | number | boolean>;
  /** 幂等键；B/C 级没有它时重试次数被压到 1（docs/00 §9.2）。 */
  idempotencyKey?: string | null;
  /** 调用方透传的 request_id（贯穿 api→worker→adapter，docs/12 §4）。 */
  requestId?: string;
}

export interface ClientPlan {
  operation: string;
  title: string;
  channel: OperationChannel;
  actionCode: string | null;
  riskLevel: RiskLevel | null;
  irreversible: boolean;
  /** 是否被未核验事实阻塞（当前恒为 true）。 */
  blocked: boolean;
  gaps: VerificationGap[];
  todoIds: TodoId[];
  /** 参数摘要（不含明文，用于 dry-run 留痕）。 */
  paramsDigest: string;
  /** 平台 method；未核验恒为 null。 */
  method: null;
}

export interface ExecuteResult<T> {
  data: T;
  status: number;
  attempts: number;
  delaysMs: number[];
  requestId: string;
}

function normalizeParams(params: ExecuteOptions['params']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      throw new AdapterError({
        code: 'INVALID_REQUEST',
        message: `参数 ${key} 必须是标量（协议未核验，禁止自动序列化嵌套结构）`,
        details: { param: key },
      });
    }
    out[key] = String(value);
  }
  return out;
}

export class Alibaba1688Client {
  readonly signer: RequestSigner;
  readonly archive: ArchiveSink;
  private readonly transport: Transport;
  private readonly limiter: RateLimiter;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly retryPolicy: RetryPolicy;
  private readonly catalog: OperationCatalog;
  private readonly baseUrl: string | null;
  private readonly contractVersion: string | null;

  constructor(options: ClientOptions = {}) {
    this.transport = options.transport ?? httpTransport();
    this.signer = options.signer ?? UNVERIFIED_SIGNER;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.catalog = options.catalog ?? DEFAULT_CATALOG;
    this.limiter = options.limiter ?? new TokenBucketRateLimiter(options.limiterConfig ?? ASSUMED_CLIENT_RATE_LIMIT, this.clock);
    this.archive = options.archive ?? new MemoryArchiveSink();
    this.baseUrl = options.baseUrl ?? null;
    this.contractVersion = options.contractVersion ?? null;
  }

  /** 只读计划：不发送、不限流、不签名。用于 dry-run、验收与 UI 的「为什么不能发」。 */
  plan(operationId: string, options: Pick<ExecuteOptions, 'params'> = {}): ClientPlan {
    const descriptor = this.requireOperation(operationId);
    const gaps = verificationGaps(descriptor);
    const params = normalizeParams(options.params);
    return {
      operation: descriptor.id,
      title: descriptor.title,
      channel: descriptor.channel,
      actionCode: descriptor.actionCode,
      riskLevel: descriptor.riskLevel,
      irreversible: descriptor.irreversible,
      blocked: gaps.length > 0,
      gaps,
      todoIds: descriptor.todoIds,
      paramsDigest: canonicalHash(params),
      method: null,
    };
  }

  /** 真正发送。当前对全部真实操作都会抛 `CONTRACT_NOT_VERIFIED`。 */
  async execute<T = unknown>(operationId: string, options: ExecuteOptions = {}): Promise<ExecuteResult<T>> {
    const descriptor = this.requireOperation(operationId);
    this.assertReadyToSend(descriptor);
    const params = normalizeParams(options.params);
    const policy = policyForOperation(this.retryPolicy, {
      riskLevel: descriptor.riskLevel,
      irreversible: descriptor.irreversible,
      idempotencyKey: options.idempotencyKey,
    });
    const requestId = options.requestId ?? this.newRequestId();
    const baseUrl = this.baseUrl;
    if (!baseUrl) {
      throw new AdapterError({
        code: 'INVALID_REQUEST',
        message: '未配置 1688 调用域名（baseUrl）；域名与路径均未核验（TODO-1688-002）',
        todoIds: ['TODO-1688-002'],
        details: { operation: descriptor.id },
      });
    }

    const outcome = await executeWithRetry(
      descriptor.id,
      async (attempt) => {
        await this.limiter.acquire(descriptor.id);
        const startedAt = this.clock.now();
        const timestamp = startedAt;
        const nonce = this.newNonce(timestamp);
        const request = this.buildRequest(descriptor, baseUrl, params, timestamp, nonce);
        let response: HttpResponse;
        try {
          response = await this.transport.request(request);
        } catch (error) {
          // 归档失败不得掩盖真正的平台/网络错误：此处只尽力留档。
          await this.writeArchive({
            requestId,
            operation: descriptor.id,
            attempt,
            occurredAt: new Date(startedAt).toISOString(),
            durationMs: this.clock.now() - startedAt,
            request: archiveRequest(request),
            response: null,
            error: {
              code: error instanceof AdapterError ? error.code : 'NETWORK',
              message: error instanceof Error ? error.message : String(error),
              retryable: error instanceof AdapterError ? error.retryable : true,
            },
            meta: { signerId: this.signer.id, redacted: true, contractVersion: this.contractVersion },
          }).catch(() => undefined);
          throw error;
        }

        // 先留档原始响应，再解析：解析失败（429/5xx/业务拒绝）也要能在归档里看到平台原文。
        await this.writeArchive({
          requestId,
          operation: descriptor.id,
          attempt,
          occurredAt: new Date(startedAt).toISOString(),
          durationMs: this.clock.now() - startedAt,
          request: archiveRequest(request),
          response: archiveResponse(response),
          error: null,
          meta: { signerId: this.signer.id, redacted: true, contractVersion: this.contractVersion },
        });

        // 解析放在重试循环内部：429/5xx 必须作为可重试错误抛出，否则外层不会退避。
        const data = this.interpret<T>(response);
        return { data, response };
      },
      policy,
      { clock: this.clock, random: this.random },
    );

    return {
      data: outcome.result.data,
      status: outcome.result.response.status,
      attempts: outcome.attempts,
      delaysMs: outcome.delaysMs,
      requestId,
    };
  }

  private requireOperation(operationId: string): OperationDescriptor {
    const descriptor = this.catalog.get(operationId);
    if (!descriptor) {
      throw new AdapterError({
        code: 'INVALID_REQUEST',
        message: `未知 1688 操作：${operationId}（注册表见 src/client/registry.ts）`,
        details: { operation: operationId },
      });
    }
    return descriptor;
  }

  private assertReadyToSend(descriptor: OperationDescriptor): void {
    if (descriptor.channel !== 'api') {
      throw new AdapterError({
        code: 'INVALID_REQUEST',
        message: `操作 ${descriptor.id} 走「${descriptor.channel === 'import' ? '导入包' : '人工'}」通道，不能通过 HTTP 客户端发送`,
        details: { operation: descriptor.id, channel: descriptor.channel },
      });
    }
    const gaps = verificationGaps(descriptor);
    if (gaps.length > 0) {
      const todoIds = [...new Set(gaps.map((gap) => gap.todoId))];
      throw AdapterError.contractNotVerified(
        `1688 操作 ${descriptor.id} 的契约未核验，拒绝发送。缺口：${gaps.map((gap) => `${gap.field}→${gap.todoId}`).join('、')}`,
        todoIds,
        { operation: descriptor.id, gaps: gaps.length },
      );
    }
  }

  private buildRequest(
    descriptor: OperationDescriptor,
    baseUrl: string,
    params: Record<string, string>,
    timestamp: number,
    nonce: string,
  ): HttpRequest {
    // descriptor 已在 assertReadyToSend 中确认这些字段非空；这里再做一次类型收敛。
    if (
      descriptor.method === null ||
      descriptor.httpMethod === null ||
      descriptor.path === null ||
      descriptor.paramsIn === null ||
      descriptor.bodyFormat === null ||
      descriptor.signatureRequired === null
    ) {
      throw AdapterError.contractNotVerified('请求协议字段缺失，拒绝构造请求', ['TODO-1688-002', 'TODO-1688-003']);
    }
    if (descriptor.signatureRequired && !this.signer.verified) {
      throw AdapterError.contractNotVerified(
        `签名器 ${this.signer.id} 未通过核验，拒绝构造真实请求`,
        ['TODO-1688-003'],
        { signer: this.signer.id },
      );
    }

    const url = new URL(descriptor.path, baseUrl);
    let body: string | null = null;
    if (descriptor.paramsIn === 'query') {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    } else if (descriptor.bodyFormat === 'form') {
      body = new URLSearchParams(params).toString();
    } else {
      body = JSON.stringify(params);
    }

    const signed = this.signer.sign({ method: descriptor.method, params, body, timestamp, nonce });
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(body !== null && descriptor.bodyFormat === 'json' ? { 'content-type': 'application/json' } : {}),
      ...(body !== null && descriptor.bodyFormat === 'form'
        ? { 'content-type': 'application/x-www-form-urlencoded' }
        : {}),
      ...signed.headers,
      ...(descriptor.signatureRequired ? { 'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce } : {}),
    };
    for (const [key, value] of Object.entries(signed.query)) url.searchParams.set(key, value);

    return { method: descriptor.httpMethod, url: url.toString(), headers, body };
  }

  private interpret<T>(response: HttpResponse): T {
    if (response.status >= 200 && response.status < 300) {
      if (response.body.trim().length === 0) return null as T;
      try {
        return JSON.parse(response.body) as T;
      } catch (error) {
        throw new AdapterError({
          code: 'PARSE_ERROR',
          message: '平台响应不是合法 JSON，响应结构未核验（TODO-1688-001/004）',
          todoIds: ['TODO-1688-001', 'TODO-1688-004'],
          details: { status: response.status },
          cause: error,
        });
      }
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers['retry-after'], this.clock.now());
      throw new AdapterError({
        code: 'RATE_LIMITED',
        message: '平台限流（429）',
        retryable: true,
        details: { status: response.status, retryAfterMs: retryAfterMs ?? null },
      });
    }
    if (response.status >= 500) {
      throw new AdapterError({
        code: 'UPSTREAM_5XX',
        message: `平台 5xx（${response.status}）`,
        retryable: true,
        details: { status: response.status },
      });
    }
    // 4xx：业务拒绝，不重试（docs/11 禁止重试清单：平台明确永久拒绝）。
    const excerpt = response.body.slice(0, 200).replaceAll(/\s+/g, ' ');
    throw new AdapterError({
      code: 'PLATFORM_REJECT',
      message: `平台拒绝（${response.status}）：${excerpt}`,
      retryable: false,
      todoIds: ['TODO-1688-004'],
      details: { status: response.status },
    });
  }

  private async writeArchive(entry: ArchiveEntry): Promise<void> {
    try {
      await this.archive.write(entry);
    } catch (error) {
      throw new AdapterError({
        code: 'ARCHIVE_FAILED',
        message: '留档写入失败：不可逆动作不允许无留档执行（docs/00 §9.3）',
        details: { operation: entry.operation, attempt: entry.attempt },
        cause: error,
      });
    }
  }

  private newRequestId(): string {
    const stamp = this.clock.now().toString(36);
    const random = Math.floor(this.random.next() * 1e12).toString(36);
    return `req_${stamp}_${random}`;
  }

  private newNonce(timestamp: number): string {
    return `${timestamp.toString(36)}${Math.floor(this.random.next() * 1e9).toString(36)}`;
  }
}

/** 便捷工厂：默认使用未核验签名器与内存归档（适合 dry-run 与测试）。 */
export function createClient(options: ClientOptions = {}): Alibaba1688Client {
  return new Alibaba1688Client(options);
}

export type { RateLimitConfig };
