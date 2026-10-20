/**
 * 供应商 adapter（docs/07 §10；docs/04 §6.3）。
 *
 * - 文本：OpenAI-compatible HTTP（可指向 dsh-llm-pi-ai 的兼容网关；provider.base_url 可覆盖）；
 * - 图片/视频/嵌入：M1 先给 Mock adapter（真实厂商 adapter 在 M6 接入）；
 * - 凭据按请求传入，禁止缓存/记录明文；
 * - 错误分类：429/408/5xx/超时可降级；400/401/403/404 视为配置/参数错误，不降级。
 */
import type {
  Capability,
  ModelRow,
  ProviderKind,
  ProviderRow,
  Purpose,
  UsageActual,
} from './types.js';

export class AdapterError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AdapterError';
  }
}

export interface AdapterTestResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
}

export interface AdapterInvokeRequest {
  purpose: Purpose;
  model: ModelRow;
  provider: ProviderRow;
  params: Record<string, unknown>;
  credential: string | null;
  timeoutMs: number;
}

export interface AdapterResponse {
  text?: string;
  usage?: UsageActual;
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  test(provider: ProviderRow, credential: string | null): Promise<AdapterTestResult>;
  invoke(request: AdapterInvokeRequest): Promise<AdapterResponse>;
}

export type AdapterFactory = (provider: ProviderRow) => ProviderAdapter;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function classifyStatus(status: number): AdapterError {
  if (status === 408) return new AdapterError('timeout', status, true);
  if (status === 429) return new AdapterError('rate_limited', status, true);
  if (status >= 500) return new AdapterError('upstream_5xx', status, true);
  if (status === 401 || status === 403) {
    return new AdapterError('provider_unavailable', status, false, '凭据被供应商拒绝');
  }
  if (status === 404) return new AdapterError('model_not_found', status, false);
  if (status === 400 || status === 422) return new AdapterError('invalid_request', status, false);
  return new AdapterError('upstream_error', status, false);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AdapterError('timeout', null, true);
    }
    throw new AdapterError('network_error', null, true, '无法连接供应商');
  }
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly kind: ProviderKind = 'text';

  async test(provider: ProviderRow, credential: string | null): Promise<AdapterTestResult> {
    const started = Date.now();
    if (!provider.baseUrl) return { ok: false, latencyMs: 0, errorCode: 'base_url_missing' };
    if (!credential) return { ok: false, latencyMs: 0, errorCode: 'credential_missing' };
    try {
      const response = await fetchWithTimeout(
        joinUrl(provider.baseUrl, '/models'),
        {
          method: 'GET',
          headers: { authorization: `Bearer ${credential}`, accept: 'application/json' },
        },
        provider.timeoutMs,
      );
      const latencyMs = Date.now() - started;
      if (!response.ok) return { ok: false, latencyMs, errorCode: `http_${response.status}` };
      return { ok: true, latencyMs };
    } catch (error) {
      const adapterError = error instanceof AdapterError ? error : new AdapterError('network_error', null, true);
      return { ok: false, latencyMs: Date.now() - started, errorCode: adapterError.code };
    }
  }

  async invoke(request: AdapterInvokeRequest): Promise<AdapterResponse> {
    const { provider, model, params, credential, timeoutMs } = request;
    if (!provider.baseUrl) throw new AdapterError('base_url_missing', null, false);
    if (!credential) throw new AdapterError('credential_missing', null, false);
    if (provider.authScheme !== 'bearer' && provider.authScheme !== 'none') {
      throw new AdapterError('auth_scheme_unsupported', null, false);
    }

    const messages =
      Array.isArray(params.messages) && params.messages.length > 0
        ? params.messages
        : typeof params.prompt === 'string'
          ? [{ role: 'user', content: params.prompt }]
          : undefined;
    if (!messages) throw new AdapterError('invalid_request', null, false, '缺少 messages/prompt');

    const body: Record<string, unknown> = {
      model: model.externalModelId,
      messages,
    };
    for (const key of ['temperature', 'max_tokens', 'top_p', 'response_format']) {
      if (params[key] !== undefined) body[key] = params[key];
    }

    const response = await fetchWithTimeout(
      joinUrl(provider.baseUrl, '/chat/completions'),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!response.ok) throw classifyStatus(response.status);

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const text = payload.choices?.[0]?.message?.content;
    const usage: UsageActual = {
      inputTokens: payload.usage?.prompt_tokens,
      outputTokens: payload.usage?.completion_tokens,
      tokensSource: payload.usage ? 'provider_usage' : 'estimated',
    };
    return { text, usage, raw: payload };
  }
}

interface MockOptions {
  failures?: number;
  failureCode?: string;
  latencyMs?: number;
}

/** 图片/视频/嵌入的 M1 mock：确定性返回，便于测试路由、计量与记账。 */
export class MockAdapter implements ProviderAdapter {
  private failuresLeft: number;

  constructor(
    readonly kind: ProviderKind,
    private readonly options: MockOptions = {},
  ) {
    this.failuresLeft = options.failures ?? 0;
  }

  async test(): Promise<AdapterTestResult> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      return { ok: false, latencyMs: 1, errorCode: this.options.failureCode ?? 'mock_failure' };
    }
    return { ok: true, latencyMs: this.options.latencyMs ?? 1 };
  }

  async invoke(request: AdapterInvokeRequest): Promise<AdapterResponse> {
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new AdapterError(this.options.failureCode ?? 'upstream_5xx', 500, true);
    }
    const params = request.params;
    const count = typeof params.count === 'number' ? params.count : 1;
    const width = typeof params.width === 'number' ? params.width : 1024;
    const height = typeof params.height === 'number' ? params.height : 1024;
    const seconds =
      typeof params.duration_seconds === 'number'
        ? params.duration_seconds
        : typeof params.seconds === 'number'
          ? params.seconds
          : 5;

    const usageByKind: Record<ProviderKind, UsageActual> = {
      text: { inputTokens: 10, outputTokens: 5, tokensSource: 'provider_usage' },
      image: {
        imageCount: count,
        imagePixels: count * width * height,
        tokensSource: 'provider_usage',
      },
      video: { videoSeconds: seconds, tokensSource: 'provider_usage' },
      embedding: { inputTokens: 1000, tokensSource: 'provider_usage' },
    };
    return {
      text: `mock:${request.purpose}:${request.model.externalModelId}`,
      usage: usageByKind[this.kind],
      raw: { mock: true },
    };
  }
}

/** API 默认工厂：provider.extra.mock=true 时走 mock；文本走 OpenAI-compatible；其余 M1 mock。 */
export function createAdapterFactory(): AdapterFactory {
  const mocks: Partial<Record<ProviderKind, MockAdapter>> = {};
  return (provider: ProviderRow): ProviderAdapter => {
    if (provider.extra.mock === true || provider.kind !== 'text') {
      mocks[provider.kind] ??= new MockAdapter(provider.kind);
      return mocks[provider.kind]!;
    }
    return new OpenAICompatibleAdapter();
  };
}

export function capabilityForKind(kind: ProviderKind): Capability {
  return kind === 'embedding' ? 'embedding' : kind;
}
