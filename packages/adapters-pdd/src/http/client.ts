/**
 * 拼多多中心侧 HTTP 客户端（M1 骨架）。
 *
 * 调用前检查顺序（任何一步失败都不会发起网络请求）：
 *   1. 接口在注册表里；
 *   2. 接口已核验（method/version/path 非 null）——未核验只能返回 dry-run / 抛错；
 *   3. 配置不是 dry-run（缺凭据、缺 baseUrl、显式 PDD_DRY_RUN=1）；
 *   4. 本地令牌桶拿到许可；
 *   5. 生成时间戳 + nonce（防重放）并签名；
 *   6. 传输 → 分类 → 留档；可重试错误按退避重试，不可重试直接抛。
 *
 * 本文件不写任何平台 method 名；method/path 全部来自注册表（当前为 null）。
 */

import { describePddConfig, loadPddConfig, type PddConfig } from '../config.js';
import { PddError, isPddError, type PddErrorInit } from '../errors.js';
import { pddRegistry, InterfaceRegistry } from '../registry/index.js';
import { PDD_SOURCE_DOC } from '../registry/types.js';
import type { PddInterfaceSpec } from '../registry/types.js';
import { canonicalJson, sha256Hex } from '../util/canonical.js';
import { isoNow, newRequestId } from '../util/ids.js';
import {
  JsonFileArchiver,
  NullArchiver,
  responseBodyDigest,
  type CallArchiveRecord,
  type RequestArchiver,
} from './archive.js';
import { classifyHttpResponse, classifyTransportError } from './classification.js';
import { TokenBucketLimiter, type RateLimiter } from './rate-limiter.js';
import { DEFAULT_RETRY_POLICY, computeBackoffDelayMs, type RetryPolicy } from './retry.js';
import {
  PlaceholderHmacSha256Signer,
  SIGNATURE_TODO,
  TimestampReplayGuard,
  reserveOutboundNonce,
  type RequestSigner,
} from './signer.js';
import { FetchTransport, type HttpTransport, type TransportRequest, type TransportResponse } from './transport.js';

export interface PddCallOptions {
  /** 调用方传入的 request_id（贯穿 API / worker）；缺省自动生成。 */
  requestId?: string;
  /** 写入门 L3 写幂等键；只进留档，不发给未核验的平台。 */
  idempotencyKey?: string | null;
  signal?: AbortSignal;
  /** path 模板占位符替换值，例如 { item_id: '123' }。 */
  pathParams?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface PddCallRequestPreview {
  method: string | null;
  path: string | null;
  url: string | null;
  headers: Record<string, string>;
  body: unknown;
  signature_scheme: string;
}

export interface PddCallDryRun {
  status: 'dry_run';
  reason: 'unverified_interface' | 'dry_run';
  interface_key: string;
  verification: PddInterfaceSpec['verification'];
  request_preview: PddCallRequestPreview;
  warnings: string[];
  request_id: string;
  archived_path: string | null;
  duration_ms: number;
}

export interface PddCallSuccess<T> {
  status: 'success';
  interface_key: string;
  http_status: number;
  data: T;
  attempts: number;
  retries: number;
  request_id: string;
  archived_path: string | null;
  duration_ms: number;
}

export type PddCallResult<T> = PddCallDryRun | PddCallSuccess<T>;

export interface PddClientOptions {
  config: PddConfig;
  /** 生产默认 docs/01 注册表；测试可注入合成已验证接口。 */
  registry?: InterfaceRegistry;
  transport?: HttpTransport;
  signer?: RequestSigner;
  limiter?: RateLimiter;
  archiver?: RequestArchiver;
  retryPolicy?: RetryPolicy;
  /** 单次逻辑调用的总耗时上限（含限流等待与重试）。默认 60000ms。 */
  maxElapsedMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  replayGuard?: TimestampReplayGuard;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PddClient {
  readonly config: PddConfig;
  private readonly registry: InterfaceRegistry;
  private readonly transport: HttpTransport | null;
  private readonly signer: RequestSigner;
  private readonly limiter: RateLimiter;
  private readonly archiver: RequestArchiver;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxElapsedMs: number;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly replayGuard: TimestampReplayGuard;

  constructor(options: PddClientOptions) {
    this.config = options.config;
    this.registry = options.registry ?? pddRegistry;
    this.transport = options.transport ?? (this.config.dryRun ? null : new FetchTransport());
    this.signer = options.signer ?? new PlaceholderHmacSha256Signer();
    this.limiter = options.limiter ?? new TokenBucketLimiter({ qps: this.config.internalQps });
    this.archiver = options.archiver ?? new JsonFileArchiver({ dir: this.config.archiveDir });
    this.retryPolicy = options.retryPolicy ?? { ...DEFAULT_RETRY_POLICY, maxAttempts: this.config.maxAttempts };
    this.maxElapsedMs = options.maxElapsedMs ?? 60_000;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.replayGuard = options.replayGuard ?? new TimestampReplayGuard({ windowMs: this.config.clockSkewWindowMs });
  }

  /** 配置摘要（不含 secret），供启动日志/验收记录使用。 */
  describe(): Record<string, unknown> {
    return {
      ...describePddConfig(this.config),
      registry: this.registry.stats(),
      signature_scheme: this.signer.scheme,
      signature_todo: SIGNATURE_TODO,
      source_doc: PDD_SOURCE_DOC,
    };
  }

  async call<T = unknown>(interfaceKey: string, payload: unknown = {}, options: PddCallOptions = {}): Promise<PddCallResult<T>> {
    const requestId = options.requestId ?? newRequestId();
    const startedAt = this.clock();
    const spec = this.registry.require(interfaceKey);

    // 未核验接口：dry-run 返回预览；live 模式必须显式失败，绝不静默降级。
    if (spec.verification !== 'verified' || spec.platform_method === null || spec.platform_version === null || spec.path_template === null) {
      const dryRun = await this.buildDryRun(spec, payload, options, requestId, 'unverified_interface', this.clock() - startedAt);
      if (this.config.dryRun) return dryRun;
      this.registry.requireCallable(interfaceKey); // 抛 unverified_interface（带 TODO 详情）
      throw new PddError({
        code: 'unverified_interface',
        message: `接口 ${interfaceKey} 未核验，live 模式不允许调用`,
        errorClass: 'permanent',
        nextAction: 'contact_admin',
        requestId,
        detail: { interface_key: interfaceKey, doc_ref: spec.doc_ref },
      });
    }

    const path = resolvePathTemplate(spec.path_template, options.pathParams);
    const method = spec.platform_method;
    const bodyText = method === 'GET' || method === 'HEAD' ? '' : canonicalJson(payload);

    if (this.config.dryRun) {
      // dry-run 不要求 baseUrl：缺域名正是待核验状态，预览里显式留 null。
      const previewUrl = this.config.baseUrl === null ? null : this.buildUrl(path);
      return this.buildDryRun(spec, payload, options, requestId, 'dry_run', this.clock() - startedAt, {
        method,
        path,
        url: previewUrl,
        bodyText,
      });
    }
    const url = this.buildUrl(path);

    if (!this.transport) {
      throw new PddError({
        code: 'config_error',
        message: 'live 模式缺少 transport',
        errorClass: 'permanent',
        nextAction: 'contact_admin',
        requestId,
      });
    }
    const appKey = this.config.appKey;
    const appSecret = this.config.appSecret;
    if (appKey === null || appSecret === null) {
      throw new PddError({
        code: 'config_error',
        message: 'live 模式缺少 appKey/appSecret',
        errorClass: 'permanent',
        nextAction: 'contact_admin',
        requestId,
      });
    }

    let attempt = 0;
    let lastArchivedPath: string | null = null;
    let lastError: PddError | null = null;
    while (attempt < this.retryPolicy.maxAttempts) {
      attempt += 1;
      const elapsedBefore = this.clock() - startedAt;
      if (elapsedBefore >= this.maxElapsedMs) break;

      await this.limiter.acquire(interfaceKey, { signal: options.signal });

      const { timestampMs, nonce } = reserveOutboundNonce(this.replayGuard, this.clock);
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-request-id': requestId,
        ...(bodyText === '' ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        ...this.signer.sign({
          method,
          path,
          bodyText,
          timestampMs,
          nonce,
          appKey,
          appSecret,
          accessToken: this.config.accessToken,
        }),
      };
      const attemptStartedAt = this.clock();
      const request: TransportRequest = {
        method,
        url,
        headers,
        bodyText,
        timeoutMs: this.config.timeoutMs,
        maxResponseBytes: this.config.maxResponseBytes,
        requestId,
        interfaceKey,
        ...(options.signal ? { signal: options.signal } : {}),
      };

      let response: TransportResponse;
      try {
        response = await this.transport.request(request);
      } catch (error) {
        const classified = classifyTransportError(error);
        lastError = classified;
        lastArchivedPath = await this.archiveAttempt({
          spec,
          requestId,
          attempt,
          transport: 'http',
          startedAt: attemptStartedAt,
          request,
          outcome: 'failure',
          error: classified,
          options,
        });
        if (!classified.retryable || attempt >= this.retryPolicy.maxAttempts) break;
        const delay = computeBackoffDelayMs(attempt, this.retryPolicy, this.random, classified.retryAfterMs);
        if (this.clock() - startedAt + delay > this.maxElapsedMs) break;
        await this.sleep(delay);
        continue;
      }

      const failure = classifyHttpResponse(response, this.clock());
      lastArchivedPath = await this.archiveAttempt({
        spec,
        requestId,
        attempt,
        transport: 'http',
        startedAt: attemptStartedAt,
        request,
        response,
        outcome: failure ? 'failure' : 'success',
        ...(failure ? { error: failure } : {}),
        options,
      });
      if (!failure) {
        return {
          status: 'success',
          interface_key: interfaceKey,
          http_status: response.status,
          data: response.body as T,
          attempts: attempt,
          retries: attempt - 1,
          request_id: requestId,
          archived_path: lastArchivedPath,
          duration_ms: this.clock() - startedAt,
        };
      }
      lastError = failure;
      if (!failure.retryable || attempt >= this.retryPolicy.maxAttempts) break;
      const delay = computeBackoffDelayMs(attempt, this.retryPolicy, this.random, failure.retryAfterMs);
      if (this.clock() - startedAt + delay > this.maxElapsedMs) break;
      await this.sleep(delay);
    }

    const error =
      lastError ??
      new PddError({
        code: 'unknown',
        message: `接口 ${interfaceKey} 未执行（超过总耗时上限或重试耗尽）`,
        errorClass: 'manual',
        nextAction: 'contact_admin',
      });
    throw withContext(error, {
      requestId,
      attempts: attempt,
      archivedPath: lastArchivedPath,
      interfaceKey,
    });
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.baseUrl;
    if (baseUrl === null) {
      throw new PddError({
        code: 'config_error',
        message: 'PDD_API_BASE_URL 未配置，无法构造请求 URL',
        errorClass: 'permanent',
        nextAction: 'contact_admin',
      });
    }
    if (/^https?:\/\//i.test(path)) return path;
    return `${baseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async buildDryRun(
    spec: PddInterfaceSpec,
    payload: unknown,
    options: PddCallOptions,
    requestId: string,
    reason: 'unverified_interface' | 'dry_run',
    durationMs: number,
    resolved?: { method: string; path: string; url: string | null; bodyText: string },
  ): Promise<PddCallDryRun> {
    const preview: PddCallRequestPreview = {
      method: resolved?.method ?? spec.platform_method,
      path: resolved?.path ?? spec.path_template,
      url: resolved?.url ?? null,
      headers: {
        accept: 'application/json',
        'x-request-id': requestId,
        'x-pdd-signature-scheme': this.signer.scheme,
      },
      body: payload,
      signature_scheme: this.signer.scheme,
    };
    const warnings = [
      ...(reason === 'unverified_interface'
        ? [`未核验接口：${spec.doc_ref}；method/权限/限流/字段仍为待填。`, `method ${spec.todos.method}`]
        : []),
      ...this.config.warnings,
      SIGNATURE_TODO,
    ];
    const startedAt = this.clock();
    const record: CallArchiveRecord = {
      schema_version: 'pdd-call-v1',
      call_id: requestId,
      request_id: requestId,
      interface_key: spec.key,
      transport: 'dry_run',
      attempt: 1,
      started_at: isoNow(startedAt),
      finished_at: isoNow(startedAt),
      duration_ms: Math.max(0, durationMs),
      request: {
        method: preview.method,
        path: preview.path,
        url: preview.url,
        headers: preview.headers,
        body: payload,
        body_sha256: hashOf(payload),
      },
      outcome: 'dry_run',
      idempotency_key: options.idempotencyKey ?? null,
      metadata: options.metadata,
      redaction: 'archive-v1',
      notes: [`dry_run_reason=${reason}`, ...(spec.verification !== 'verified' ? ['interface_unverified'] : [])],
    };
    const archivedPath = await this.archiver.archive(record);
    return {
      status: 'dry_run',
      reason,
      interface_key: spec.key,
      verification: spec.verification,
      request_preview: preview,
      warnings,
      request_id: requestId,
      archived_path: archivedPath,
      duration_ms: Math.max(0, durationMs),
    };
  }

  private async archiveAttempt(input: {
    spec: PddInterfaceSpec;
    requestId: string;
    attempt: number;
    transport: 'http' | 'replay';
    startedAt: number;
    request: TransportRequest;
    response?: TransportResponse;
    outcome: 'success' | 'failure';
    error?: PddError;
    options: PddCallOptions;
  }): Promise<string | null> {
    const finishedAt = this.clock();
    const bodyDigest = responseBodyDigest(input.response?.bodyText ?? '', input.response?.body);
    const record: CallArchiveRecord = {
      schema_version: 'pdd-call-v1',
      call_id: input.requestId,
      request_id: input.requestId,
      interface_key: input.spec.key,
      transport: input.transport,
      attempt: input.attempt,
      started_at: isoNow(input.startedAt),
      finished_at: isoNow(finishedAt),
      duration_ms: Math.max(0, finishedAt - input.startedAt),
      request: {
        method: input.request.method,
        path: pathOfUrl(input.request.url),
        url: input.request.url,
        headers: input.request.headers,
        body: safeJson(input.request.bodyText),
        body_sha256: hashOf(input.request.bodyText),
      },
      ...(input.response
        ? {
            response: {
              status: input.response.status,
              headers: input.response.headers,
              body: bodyDigest.redacted,
              body_sha256: bodyDigest.body_sha256,
              truncated: input.response.truncated,
            },
          }
        : {}),
      outcome: input.outcome,
      ...(input.error
        ? {
            error: {
              code: input.error.code,
              error_class: input.error.errorClass,
              retryable: input.error.retryable,
              next_action: input.error.nextAction,
              message: input.error.message,
              ...(input.error.status !== undefined ? { status: input.error.status } : {}),
            },
          }
        : {}),
      idempotency_key: input.options.idempotencyKey ?? null,
      metadata: input.options.metadata,
      redaction: 'archive-v1',
    };
    return this.archiver.archive(record);
  }
}

function resolvePathTemplate(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = params?.[key];
    if (value === undefined) {
      throw new PddError({
        code: 'config_error',
        message: `path 模板占位符未提供：${match}`,
        errorClass: 'permanent',
        nextAction: 'contact_admin',
        detail: { template, missing: key },
      });
    }
    return encodeURIComponent(value);
  });
}

function pathOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function safeJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 字符串按原文哈希；对象按 canonical JSON 哈希。 */
function hashOf(value: unknown): string {
  return typeof value === 'string' ? sha256Hex(value) : sha256Hex(canonicalJson(value));
}

/** 构造带上下文（request_id / 尝试次数 / 留档路径）的错误。 */
function withContext(
  error: PddError,
  context: { requestId: string; attempts: number; archivedPath: string | null; interfaceKey: string },
): PddError {
  const init: PddErrorInit = {
    code: error.code,
    message: error.message,
    errorClass: error.errorClass,
    nextAction: error.nextAction,
    status: error.status,
    requestId: context.requestId,
    attempts: context.attempts,
    retryAfterMs: error.retryAfterMs,
    detail: {
      ...(error.detail ?? {}),
      interface_key: context.interfaceKey,
      ...(context.archivedPath ? { archived_path: context.archivedPath } : {}),
    },
    cause: error,
  };
  return new PddError(init);
}

/** 便捷工厂：从环境变量加载配置（缺省即 dry-run）。 */
export function createPddClientFromEnv(env: NodeJS.ProcessEnv = process.env): PddClient {
  return new PddClient({ config: loadPddConfig({ env }) });
}

export { isPddError };
