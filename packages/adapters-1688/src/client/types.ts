/**
 * 传输层最小契约 —— 只做「发一个 HTTP 请求、拿回状态/头/体」，不解析平台语义。
 *
 * 为什么抽象：
 * - 契约录制回放要能在 transport 层拦截（docs/15 §4.2「在 undici 层拦截」），
 *   本包不绑定具体 HTTP 客户端，`fetch` 实现放在 `httpTransport()` 里；
 * - 回放期必须能**禁止真实网络**，所以测试用 `ReplayTransport` 替换实现即可；
 * - 时间与随机必须可注入，否则录制无法「固定 timestamp / nonce」（docs/15 §4.2.4）。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  /** `null` 表示无请求体（GET 常见）。 */
  body: string | null;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  /** `signal` 由调用方负责超时；transport 不应吞掉 AbortError。 */
  request(request: HttpRequest, options?: { signal?: AbortSignal }): Promise<HttpResponse>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RandomSource {
  /** [0,1) 均匀分布。 */
  next(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise((resolve) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      setTimeout(resolve, ms);
    }),
};

export const systemRandom: RandomSource = { next: () => Math.random() };

/** 基于全局 `fetch` 的默认 transport（Node 22+ 内置）。 */
export function httpTransport(defaultTimeoutMs = 15_000): Transport {
  return {
    async request(request, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), defaultTimeoutMs);
      if (options?.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === null ? {} : { body: request.body }),
          signal: controller.signal,
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        return { status: response.status, headers, body: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
