/**
 * HTTP 传输抽象。
 *
 * 分离 Transport 的目的：
 * - 单测可注入回放/假传输，绝不触达真实平台；
 * - 未来 edge-proxy（docs/00 §8.3）可用同一接口替换，中心侧业务逻辑不变。
 */

import { PddError } from '../errors.js';

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyText: string;
  timeoutMs: number;
  maxResponseBytes: number;
  requestId: string;
  interfaceKey: string;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  body: unknown;
  receivedAtMs: number;
  truncated: boolean;
}

export interface HttpTransport {
  request(request: TransportRequest): Promise<TransportResponse>;
}

export interface FetchTransportOptions {
  fetchImpl?: typeof fetch;
  /** 测试注入；默认 Date.now。 */
  clock?: () => number;
}

function parseBody(bodyText: string, truncated: boolean): unknown {
  if (truncated || bodyText.trim() === '') return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

/** 真实网络传输（只在 live + 已核验接口时使用）。 */
export class FetchTransport implements HttpTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;

  constructor(options: FetchTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    assertSafeHttpUrl(request.url);
    const signals: AbortSignal[] = [AbortSignal.timeout(request.timeoutMs)];
    if (request.signal) signals.push(request.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.bodyText,
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      throw toTransportError(error);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const truncated = buffer.byteLength > request.maxResponseBytes;
    const bodyText = (truncated ? buffer.subarray(0, request.maxResponseBytes) : buffer).toString('utf8');
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      headers,
      bodyText,
      body: parseBody(bodyText, truncated),
      receivedAtMs: this.clock(),
      truncated,
    };
  }
}

function toTransportError(error: unknown): unknown {
  if (error instanceof PddError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new PddError({
      code: 'timeout',
      message: 'HTTP 请求超时或被取消',
      errorClass: 'retryable',
      nextAction: 'retry_later',
      cause: error,
    });
  }
  return error;
}

/** 只允许 https；本机回放/测试允许 http://127.0.0.1 与 localhost。 */
export function assertSafeHttpUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PddError({
      code: 'config_error',
      message: `非法 URL：${rawUrl}`,
      errorClass: 'permanent',
      nextAction: 'contact_admin',
    });
  }
  const isLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new PddError({
      code: 'config_error',
      message: `仅允许 https（测试回放允许本机 http）：${url.protocol}//${url.host}`,
      errorClass: 'permanent',
      nextAction: 'contact_admin',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new PddError({
      code: 'config_error',
      message: 'URL 中不得内嵌凭据',
      errorClass: 'permanent',
      nextAction: 'contact_admin',
    });
  }
  if (url.hash !== '') {
    throw new PddError({
      code: 'config_error',
      message: 'URL 不得包含 fragment',
      errorClass: 'permanent',
      nextAction: 'contact_admin',
    });
  }
}
