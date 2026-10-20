/**
 * Typert RPC 桥接客户端（api 侧，docs/17 §2.2 ⑥、§3.3、§3.4）。
 *
 * 传输是 **HTTP POST + SSE 回传**，不是 `/connect`（docs/21 §13 明确禁止 owner Peer）。
 * Host 在内部精确路由 `/internal/agent/run` 上校验 Bearer、来源与方法，然后用非 owner
 * Peer 调 `typertGateway.stream(...)`；本客户端只负责：
 *
 *   1) 业务信封序列化（camelCase，docs/17 §3.1）；
 *   2) SSE 帧 → `BridgeEvent` 的严格解析；
 *   3) AbortSignal 取消（浏览器停止 → api → Host，wire 上 signal 不存在）；
 *   4) 建连 / 首 token / 整次运行三层超时（连接期指数退避重试，首事件后不重试）；
 *   5) 失败映射为统一错误码（Host 不可达 → `dsh_unavailable`，绝不静默）。
 *
 * 注意：本文件不 spawn `dsh-headless`，也不读 `.jsonl`（docs/17 §1.2 禁止清单）。
 */
import { readFileSync, statSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { constantTimeEqual } from '../lib/ids.js';
import type { AgentRunEnvelope, BridgeEvent, BridgeHealth } from './types.js';

export const BRIDGE_RUN_PATH = '/internal/agent/run';
export const BRIDGE_HEALTH_PATH = '/internal/health';

export type BridgeErrorCode =
  | 'dsh_unavailable'
  | 'upstream_5xx'
  | 'timeout'
  | 'cancelled'
  | 'queue_full'
  | 'conflict'
  | 'validation_failed'
  | 'internal_error';

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status: number | null;
  readonly detail?: unknown;
  readonly retryable: boolean;

  constructor(
    code: BridgeErrorCode,
    message: string,
    options: { status?: number | null; detail?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BridgeError';
    this.code = code;
    this.status = options.status ?? null;
    this.detail = options.detail;
    this.retryable = options.retryable ?? (code === 'dsh_unavailable' || code === 'upstream_5xx');
  }
}

export interface SseFrame {
  event: string;
  data: string;
  id: string | null;
}

/** 增量 SSE 解析器（\n / \r\n、注释行、多 data 行、retry 字段）。 */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let index = this.buffer.search(/\r?\n\r?\n/);
    while (index >= 0) {
      const raw = this.buffer.slice(0, index);
      const separator = this.buffer.slice(index).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
      this.buffer = this.buffer.slice(index + separator.length);
      const frame = parseSseFrame(raw);
      if (frame) frames.push(frame);
      index = this.buffer.search(/\r?\n\r?\n/);
    }
    return frames;
  }

  /** 流结束时处理最后一个没有空行结尾的帧。 */
  flush(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = '';
    const frame = parseSseFrame(raw);
    return frame ? [frame] : [];
  }
}

export function parseSseFrame(raw: string): SseFrame | null {
  if (!raw.trim()) return null;
  let event = 'message';
  let id: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'id') id = value;
    // retry / 未知字段：忽略
  }
  if (dataLines.length === 0) {
    // `event:` 无 data 在 Host 契约里不存在；注释行已在上方跳过。
    if (event === 'message') return null;
  }
  return { event, data: dataLines.join('\n'), id };
}

const KNOWN_BRIDGE_EVENTS = new Set<BridgeEvent['type']>([
  'queued',
  'meta',
  'step',
  'delta',
  'tool_call',
  'tool_result',
  'need_input',
  'usage',
  'final',
  'error',
  'heartbeat',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 把一帧 SSE 解析成内部事件；未知事件返回 null（向前兼容，不因 Host 新增事件断流）。 */
export function parseBridgeEvent(frame: SseFrame): BridgeEvent | null {
  if (frame.event === 'message') return null;
  if (!KNOWN_BRIDGE_EVENTS.has(frame.event as BridgeEvent['type'])) return null;
  let data: unknown = {};
  if (frame.data.trim() !== '') {
    try {
      data = JSON.parse(frame.data);
    } catch (cause) {
      throw new BridgeError('internal_error', `桥接事件 ${frame.event} 的 data 不是合法 JSON`, {
        detail: { event: frame.event },
        cause,
      });
    }
  }
  const record = asRecord(data) ?? {};

  switch (frame.event as BridgeEvent['type']) {
    case 'queued':
      return { type: 'queued', position: asNumber(record.position) ?? 0 };
    case 'meta':
      return {
        type: 'meta',
        runId: asString(record.runId) ?? '',
        sessionId: asString(record.sessionId) ?? undefined,
        bundleVersion: asString(record.bundleVersion) ?? undefined,
        modelId: asString(record.modelId) ?? undefined,
      };
    case 'step': {
      const status = record.status;
      if (status !== 'running' && status !== 'done' && status !== 'failed') {
        throw new BridgeError('internal_error', '桥接事件 step.status 非法', {
          detail: { status },
        });
      }
      return {
        type: 'step',
        seq: asNumber(record.seq) ?? 0,
        name: asString(record.name) ?? 'step',
        status,
        summary: asString(record.summary) ?? undefined,
      };
    }
    case 'delta':
      return { type: 'delta', text: asString(record.text) ?? '' };
    case 'tool_call':
      return {
        type: 'tool_call',
        tool: asString(record.tool) ?? 'unknown',
        argsSummary: asString(record.argsSummary) ?? undefined,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool: asString(record.tool) ?? 'unknown',
        ok: record.ok === true,
        summary: asString(record.summary) ?? undefined,
      };
    case 'need_input': {
      const options = Array.isArray(record.options)
        ? record.options.filter((item): item is string => typeof item === 'string')
        : undefined;
      return {
        type: 'need_input',
        question: asString(record.question) ?? '',
        options,
      };
    }
    case 'usage':
      return {
        type: 'usage',
        inputTokens: asNumber(record.inputTokens) ?? 0,
        outputTokens: asNumber(record.outputTokens) ?? 0,
        costCents: asNumber(record.costCents) ?? 0,
      };
    case 'final': {
      const output = asRecord(record.output) ?? {};
      return {
        type: 'final',
        output: {
          text: asString(output.text) ?? undefined,
          artifacts: Array.isArray(output.artifacts) ? output.artifacts : [],
        },
        durationMs: asNumber(record.durationMs) ?? undefined,
      };
    }
    case 'error':
      return {
        type: 'error',
        code: asString(record.code) ?? 'internal_error',
        message: asString(record.message) ?? 'Host 返回未知错误',
        retryable: record.retryable === true,
        nextAction: asString(record.nextAction) ?? undefined,
      };
    case 'heartbeat':
      return { type: 'heartbeat' };
    default:
      return null;
  }
}

/** 令牌来源：显式 env（开发）优先，其次 0600 文件（生产，Host 每次重启轮换）。 */
export class BridgeTokenProvider {
  private cached: { token: string; mtimeMs: number } | null = null;

  constructor(
    private readonly options: { inlineToken: string | null; filePath: string | null },
  ) {}

  resolve(): string | null {
    if (this.options.inlineToken) return this.options.inlineToken.trim() || null;
    if (!this.options.filePath) return null;
    try {
      const stat = statSync(this.options.filePath);
      if (this.cached && this.cached.mtimeMs === stat.mtimeMs) return this.cached.token;
      const token = readFileSync(this.options.filePath, 'utf8').trim();
      if (!token) return null;
      this.cached = { token, mtimeMs: stat.mtimeMs };
      return token;
    } catch {
      return null;
    }
  }

  /** 生产 fail closed：配置了文件却读不到时，调用方必须拒绝请求而不是无鉴权降级。 */
  describeSource(): string {
    if (this.options.inlineToken) return 'env:DSH_BRIDGE_TOKEN';
    if (this.options.filePath) return `file:${this.options.filePath}`;
    return 'none';
  }
}

export interface RunOptions {
  /** 建连超时（默认 config.dshConnectTimeoutMs）。 */
  connectTimeoutMs?: number;
  /** 首 token 超时（默认 config.agentFirstTokenTimeoutMs）。 */
  firstTokenTimeoutMs?: number;
  /** 连接期重试次数（只在收到任何业务事件之前生效）。 */
  reconnectAttempts?: number;
  /** 观测钩子：首 token 到达。 */
  onFirstToken?: (elapsedMs: number) => void;
  /** 观测钩子：桥接返回的 runId/sessionId（meta 事件）。 */
  onMeta?: (meta: { runId: string; sessionId?: string; modelId?: string; bundleVersion?: string }) => void;
}

export interface BridgeClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof BridgeError) {
    return error.retryable && (error.code === 'dsh_unavailable' || error.code === 'upstream_5xx');
  }
  const candidate = error as { name?: string; code?: string; cause?: { code?: string } };
  return (
    candidate?.name === 'TypeError' ||
    candidate?.code === 'ECONNREFUSED' ||
    candidate?.code === 'ECONNRESET' ||
    candidate?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    candidate?.cause?.code === 'ECONNREFUSED'
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

export class TypertBridgeClient {
  private readonly token: BridgeTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: BridgeClientDeps['log'];
  private healthCache: { at: number; value: BridgeHealth } | null = null;

  constructor(
    private readonly config: AppConfig,
    deps: BridgeClientDeps = {},
  ) {
    this.token = new BridgeTokenProvider({
      inlineToken: config.dshBridgeToken,
      filePath: config.dshBridgeTokenFile,
    });
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.log = deps.log;
  }

  get baseUrl(): string {
    return this.config.dshBridgeUrl;
  }

  get tokenSource(): string {
    return this.token.describeSource();
  }

  /** 常量时间校验令牌（Host 侧同一口径；客户端只用于自检/测试断言）。 */
  hasToken(): boolean {
    return this.token.resolve() !== null;
  }

  /** 健康探针：GET /internal/health，带缓存；永不抛出，Host 挂时返回 ok=false。 */
  async health(force = false): Promise<BridgeHealth> {
    const cached = this.healthCache;
    if (!force && cached && this.now() - cached.at < this.config.dshHealthCacheMs) {
      return cached.value;
    }
    const started = this.now();
    const token = this.token.resolve();
    let value: BridgeHealth;
    if (!token) {
      value = {
        ok: false,
        status: 'down',
        version: null,
        preset: null,
        manifest_hash: null,
        mcp_tools: null,
        latency_ms: null,
        error: {
          code: 'dsh_unavailable',
          message: '桥接令牌不可用（DSH_BRIDGE_TOKEN_FILE / DSH_BRIDGE_TOKEN 均未解析出令牌）',
          detail: { reason: 'bridge_token_missing', token_source: this.token.describeSource() },
        },
      };
      this.healthCache = { at: this.now(), value };
      return value;
    }
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${BRIDGE_HEALTH_PATH}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.dshHealthTimeoutMs),
      });
      const latency = this.now() - started;
      if (!response.ok) {
        value = {
          ok: false,
          status: 'down',
          version: null,
          preset: null,
          manifest_hash: null,
          mcp_tools: null,
          latency_ms: latency,
          error: {
            code: response.status === 503 ? 'dsh_unavailable' : 'upstream_5xx',
            message:
              response.status === 401 || response.status === 403 || response.status === 404
                ? 'Host 桥接拒绝了探针请求（令牌或路径不匹配）'
                : `Host 健康检查返回 HTTP ${response.status}`,
            detail: { reason: 'bridge_health_failed', status: response.status },
          },
        };
      } else {
        const body = asRecord(await response.json().catch(() => ({}))) ?? {};
        value = {
          ok: body.status === undefined || body.status === 'ok',
          status: 'ok',
          version: asString(body.version) ?? null,
          preset: asString(body.preset) ?? null,
          manifest_hash: asString(body.manifest_hash) ?? asString(body.manifestHash) ?? null,
          mcp_tools: asNumber(body.mcp_tools) ?? asNumber(body.mcpTools) ?? null,
          latency_ms: latency,
          error: null,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      value = {
        ok: false,
        status: 'down',
        version: null,
        preset: null,
        manifest_hash: null,
        mcp_tools: null,
        latency_ms: this.now() - started,
        error: {
          code: 'dsh_unavailable',
          message: `无法连接 DSH Host：${message}`,
          detail: { reason: 'connect_failed', bridge_url: this.baseUrl },
        },
      };
    }
    this.healthCache = { at: this.now(), value };
    return value;
  }

  /**
   * 打开一次流式调用。返回 async iterable，消费方 `for await` 即可；
   * 调用方 abort signal 会关闭上游连接（Host 侧 `req.on('close')` → 取消 Agent）。
   */
  async *run(
    envelope: AgentRunEnvelope,
    signal: AbortSignal,
    options: RunOptions = {},
  ): AsyncGenerator<BridgeEvent, void, void> {
    const token = this.token.resolve();
    if (!token) {
      throw new BridgeError(
        'dsh_unavailable',
        'DSH Host 未配置桥接令牌：无法鉴权（fail closed，不做无鉴权降级）',
        { detail: { reason: 'bridge_token_missing', token_source: this.token.describeSource() } },
      );
    }
    const attempts = Math.max(1, 1 + (options.reconnectAttempts ?? this.config.agentBridgeReconnectAttempts));
    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw this.cancelledError(signal);
      let emitted = 0;
      const stream = this.openStream(envelope, token, signal, options);
      try {
        for await (const event of stream) {
          emitted += 1;
          if (event.type === 'meta') {
            options.onMeta?.({
              runId: event.runId,
              sessionId: event.sessionId,
              modelId: event.modelId,
              bundleVersion: event.bundleVersion,
            });
          }
          yield event;
        }
        return;
      } catch (error) {
        lastError = error;
        if (signal.aborted) throw this.cancelledError(signal);
        if (emitted > 0 || attempt + 1 >= attempts || !isRetryableTransport(error)) {
          throw this.normalizeError(error);
        }
        const delay = Math.min(
          this.config.agentBridgeReconnectBaseMs * 2 ** attempt,
          Math.max(this.config.agentBridgeReconnectBaseMs, 2000),
        );
        this.log?.warn(
          { attempt: attempt + 1, attempts, delay, bridge_url: this.baseUrl },
          'agent bridge connect failed; retrying',
        );
        await this.sleep(delay);
      }
    }
    throw this.normalizeError(lastError);
  }

  private cancelledError(signal: AbortSignal): BridgeError {
    const reason = abortReason(signal);
    const message =
      reason instanceof BridgeError
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : '已取消';
    return new BridgeError('cancelled', message, { retryable: false });
  }

  private normalizeError(error: unknown): BridgeError {
    if (error instanceof BridgeError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new BridgeError('dsh_unavailable', `DSH Host 调用失败：${message}`, {
      detail: { reason: 'connect_failed', bridge_url: this.baseUrl },
      cause: error,
    });
  }

  private async *openStream(
    envelope: AgentRunEnvelope,
    token: string,
    callerSignal: AbortSignal,
    options: RunOptions,
  ): AsyncGenerator<BridgeEvent, void, void> {
    const connectTimeoutMs = options.connectTimeoutMs ?? this.config.dshConnectTimeoutMs;
    const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? this.config.agentFirstTokenTimeoutMs;
    const requestController = new AbortController();
    const combined = AbortSignal.any([callerSignal, requestController.signal]);
    const startedAt = this.now();
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => {
      requestController.abort(
        new BridgeError('dsh_unavailable', `DSH Host 建连超时（>${connectTimeoutMs}ms）`, {
          detail: { reason: 'connect_timeout', bridge_url: this.baseUrl },
        }),
      );
    }, connectTimeoutMs);
    connectTimer.unref?.();
    let firstTokenTimer: NodeJS.Timeout | null = null;
    let firstTokenSeen = false;

    const armFirstTokenTimer = (): void => {
      firstTokenTimer = setTimeout(() => {
        requestController.abort(
          new BridgeError('timeout', `首 token 超时（>${firstTokenTimeoutMs}ms）`, {
            detail: { reason: 'first_token_timeout' },
          }),
        );
      }, firstTokenTimeoutMs);
      firstTokenTimer.unref?.();
    };
    const clearTimers = (): void => {
      if (connectTimer) clearTimeout(connectTimer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      connectTimer = null;
      firstTokenTimer = null;
    };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${BRIDGE_RUN_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-request-id': envelope.requestId,
          'x-run-id': envelope.runId,
        },
        body: JSON.stringify(envelope),
        signal: combined,
      });
    } catch (error) {
      clearTimers();
      if (callerSignal.aborted) throw this.cancelledError(callerSignal);
      const reason = abortReason(requestController.signal);
      if (reason instanceof BridgeError) throw reason;
      throw new BridgeError('dsh_unavailable', '无法连接 DSH Host', {
        detail: { reason: 'connect_failed', bridge_url: this.baseUrl },
        cause: error,
      });
    }
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    if (!response.ok) {
      clearTimers();
      const bodyText = await response.text().catch(() => '');
      throw this.httpError(response.status, bodyText);
    }
    if (!response.body) {
      clearTimers();
      throw new BridgeError('dsh_unavailable', 'DSH Host 返回了空事件流', {
        detail: { reason: 'empty_stream' },
      });
    }
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      clearTimers();
      throw new BridgeError('dsh_unavailable', 'DSH Host 响应不是 text/event-stream', {
        detail: {
          reason: 'unexpected_content_type',
          content_type: response.headers.get('content-type'),
        },
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    armFirstTokenTimer();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = parseBridgeEvent(frame);
          if (!event) continue;
          if (
            !firstTokenSeen &&
            (event.type === 'delta' || event.type === 'final' || event.type === 'error')
          ) {
            firstTokenSeen = true;
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
            options.onFirstToken?.(this.now() - startedAt);
          }
          yield event;
        }
      }
      for (const frame of parser.flush()) {
        const event = parseBridgeEvent(frame);
        if (event) yield event;
      }
    } catch (error) {
      if (callerSignal.aborted) throw this.cancelledError(callerSignal);
      const reason = abortReason(requestController.signal);
      if (reason instanceof BridgeError) throw reason;
      throw new BridgeError('dsh_unavailable', 'DSH Host 事件流中断', {
        detail: { reason: 'stream_interrupted', bridge_url: this.baseUrl },
        cause: error,
      });
    } finally {
      clearTimers();
      try {
        await reader.cancel();
      } catch {
        // 连接已断，忽略
      }
    }
  }

  private httpError(status: number, bodyText: string): BridgeError {
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(bodyText));
    } catch {
      body = null;
    }
    const remoteCode = asString(body?.code);
    const remoteMessage = asString(body?.message);
    if (status === 401 || status === 403 || status === 404) {
      return new BridgeError('dsh_unavailable', 'DSH Host 桥接拒绝了请求（令牌/路径/来源不匹配）', {
        status,
        detail: { reason: 'bridge_rejected', status },
        retryable: false,
      });
    }
    if (status === 409) {
      const sub = asString(body?.sub) ?? (remoteCode === 'session_busy' ? 'agent_running' : 'agent_busy');
      return new BridgeError('conflict', remoteMessage ?? 'Host 并发冲突', {
        status,
        detail: { sub, remote_code: remoteCode },
        retryable: false,
      });
    }
    if (status === 429) {
      return new BridgeError('queue_full', remoteMessage ?? 'Host 队列已满', {
        status,
        detail: { remote_code: remoteCode },
        retryable: true,
      });
    }
    if (status === 422 || status === 400) {
      return new BridgeError('validation_failed', remoteMessage ?? 'Host 拒绝了信封字段', {
        status,
        detail: { remote_code: remoteCode },
        retryable: false,
      });
    }
    if (status === 503) {
      return new BridgeError('dsh_unavailable', remoteMessage ?? 'DSH Host 暂不可用', {
        status,
        detail: { reason: 'host_unavailable', remote_code: remoteCode },
        retryable: true,
      });
    }
    return new BridgeError('upstream_5xx', remoteMessage ?? `DSH Host 返回 HTTP ${status}`, {
      status,
      retryable: status >= 500,
    });
  }
}

/** 常量时间比较桥接令牌（与 Host 侧同口径；测试/自检使用）。 */
export function bridgeTokenMatches(actual: string, expected: string): boolean {
  return constantTimeEqual(actual, expected);
}
