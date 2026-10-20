/**
 * 故障注入参考客户端（骨架）。
 *
 * 职责：
 *   1) 用 node:http 发起调用，区分「连接阶段超时 / 响应已开始后读超时 / 连接失败」；
 *   2) 按 docs/15 §5.2 与 docs/12 §4 把结果分类为 internal + external code；
 *   3) 提供可注入 clock 的重试执行器、死信队列与审计/提示账本。
 *
 * adapter（t4/t5）实现时应复用同一分类口径；本文件是测试基准，不是生产实现。
 */

import http from 'node:http';
import { validateSchema } from '../../contract/lib/schema.mjs';

const HTML_RE = /^\s*</;

function lowerHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

/** 发起 HTTP 调用；phase 用于区分超时阶段。 */
export function httpCall(url, options = {}) {
  const {
    method = 'POST',
    body,
    headers = {},
    connectTimeoutMs = 500,
    bodyTimeoutMs = 400,
  } = options;

  return new Promise((resolve) => {
    const target = new URL(url);
    let settled = false;
    let gotResponse = false;
    let phase = null;
    let res;
    let connectTimer;
    let bodyTimer;
    const chunks = [];

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(bodyTimer);
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try {
        parsed = bodyText ? JSON.parse(bodyText) : undefined;
      } catch {
        parsed = undefined;
      }
      resolve({
        method,
        url,
        phase: phase ?? (gotResponse ? 'response' : 'no_response'),
        gotResponse,
        status: res?.statusCode,
        headers: res ? lowerHeaders(res.headers) : {},
        bodyText,
        body: parsed,
        ...extra,
      });
    };

    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (response) => {
        res = response;
        gotResponse = true;
        clearTimeout(connectTimer);
        if (bodyTimeoutMs > 0) {
          bodyTimer = setTimeout(() => {
            phase = 'read_timeout';
            response.destroy();
            req.destroy();
            finish({ error: 'read timeout after headers' });
          }, bodyTimeoutMs);
        }
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          clearTimeout(bodyTimer);
          finish();
        });
        response.on('error', (error) => {
          clearTimeout(bodyTimer);
          finish({ error: error.message });
        });
      },
    );

    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        if (!gotResponse) {
          phase = 'connect_timeout';
          req.destroy();
          finish({ error: 'connect timeout' });
        }
      }, connectTimeoutMs);
    }

    req.on('error', (error) => {
      if (!gotResponse && !phase) phase = 'connect_error';
      finish({ error: error.message });
    });

    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function retryAfterMs(headers) {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/**
 * 结果分类：返回 { ok, internal, external, httpStatus, retryable, ... }。
 * @param {object} result httpCall 结果或测试注入的 { phase, ... }
 * @param {object} [options] { schema } — 平台响应 Schema（用于契约漂移检测）
 */
export function classifyResult(result, options = {}) {
  const headers = lowerHeaders(result.headers ?? {});
  const text = result.bodyText ?? '';

  if (result.phase === 'connect_timeout' || result.phase === 'connect_error') {
    return {
      ok: false,
      internal: 'retryable',
      external: 'upstream_5xx',
      httpStatus: 502,
      retryable: true,
      reason: result.phase,
    };
  }

  if (result.phase === 'read_timeout') {
    return {
      ok: false,
      internal: 'upstream_unknown',
      external: 'conflict',
      httpStatus: 409,
      detailSub: 'unknown',
      retryable: false,
      uncertain: true,
      reason: 'read_timeout_after_headers',
    };
  }

  const status = result.status ?? 0;
  if (status >= 500 && status <= 599) {
    return {
      ok: false,
      internal: 'retryable',
      external: 'upstream_5xx',
      httpStatus: 502,
      retryable: true,
      reason: `http_${status}`,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      internal: 'quota',
      external: 'quota',
      httpStatus: 429,
      retryable: true,
      retryAfterMs: retryAfterMs(headers),
      reason: 'rate_limited',
    };
  }
  if (status === 401) {
    const code = result.body?.errorCode ?? result.body?.error_code;
    return {
      ok: false,
      internal: code === '401' || /signature|签名/i.test(text) ? 'signature_invalid' : 'auth_expired',
      external: 'unauthorized',
      httpStatus: 401,
      retryable: false,
      reason: 'unauthorized',
    };
  }

  const contentType = String(headers['content-type'] ?? '');
  if (contentType.includes('text/html') || HTML_RE.test(text)) {
    return {
      ok: false,
      internal: 'upstream_invalid',
      external: 'upstream_5xx',
      httpStatus: 502,
      detailSub: 'invalid_response',
      retryable: false,
      alert: true,
      reason: 'html_response',
    };
  }

  if (options.schema) {
    const errors = validateSchema(result.body, options.schema);
    if (errors.length > 0) {
      return {
        ok: false,
        internal: 'contract_drift',
        external: 'upstream_5xx',
        httpStatus: 502,
        detailSub: 'contract_drift',
        retryable: false,
        alert: true,
        reason: errors.slice(0, 3).join('; '),
      };
    }
  }

  if (result.body && typeof result.body === 'object' && result.body.success === false) {
    const code = result.body.errorCode ?? result.body.error_code;
    if (code === '401' || /signature|签名/i.test(text)) {
      return {
        ok: false,
        internal: 'signature_invalid',
        external: 'unauthorized',
        httpStatus: 401,
        retryable: false,
        reason: 'signature_invalid',
      };
    }
    return {
      ok: false,
      internal: 'platform_reject',
      external: 'platform_reject',
      httpStatus: 422,
      retryable: false,
      reason: String(code ?? 'business_reject'),
    };
  }

  return { ok: true, internal: 'ok', external: null, httpStatus: status, retryable: false };
}

export class EffectLedger {
  constructor() {
    this.entries = [];
  }

  record(type, data = {}) {
    this.entries.push({ type, at: Date.now(), ...data });
  }

  count(type) {
    return this.entries.filter((entry) => entry.type === type).length;
  }

  find(type) {
    return this.entries.filter((entry) => entry.type === type);
  }
}

export class FakeClock {
  constructor(start = 0) {
    this.time = start;
    this.sleeps = [];
  }

  now() {
    return this.time;
  }

  async sleep(ms) {
    this.sleeps.push(ms);
    this.time += ms;
  }

  advance(ms) {
    this.time += ms;
  }
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** 平台队列状态：暂停 / 死信 / 可用时间。 */
export class PlatformQueue {
  constructor({ platform, clock = realClock, ledger = new EffectLedger() }) {
    this.platform = platform;
    this.clock = clock;
    this.ledger = ledger;
    this.pausedUntil = 0;
    this.deadLetter = [];
    this.state = 'idle';
  }

  pause(ms) {
    this.pausedUntil = this.clock.now() + Math.max(0, ms);
    this.state = 'paused';
    this.ledger.record('queue_paused', { platform: this.platform, until: this.pausedUntil });
  }

  markDeadLetter(item) {
    this.deadLetter.push(item);
    this.state = 'dead_letter';
    this.ledger.record('dead_letter', { platform: this.platform, ...item });
  }

  isPaused() {
    return this.clock.now() < this.pausedUntil;
  }

  status() {
    if (this.deadLetter.length > 0) return 'dead_letter';
    if (this.isPaused()) return 'paused';
    return this.state === 'ok' ? 'ok' : this.state;
  }
}

/**
 * 重试执行器。
 * @param {(ctx:{attempt:number})=>Promise<object>} call 返回 httpCall 结果
 */
export async function executeWithRetry(call, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 20,
    clock = realClock,
    ledger = new EffectLedger(),
    schema,
    queue,
  } = options;

  let attempts = 0;
  const delays = [];
  const history = [];
  let last;

  for (;;) {
    attempts += 1;
    const raw = await call({ attempt: attempts });
    const classification = classifyResult(raw, { schema });
    history.push({ attempt: attempts, classification });
    last = { raw, classification, attempts, delays, history };

    if (classification.ok) {
      ledger.record('audit', { result: 'ok', attempts, platform: queue?.platform });
      if (queue) queue.state = 'ok';
      return { ok: true, attempts, delays, history, ...last };
    }

    ledger.record('audit', {
      result: 'failed',
      internal: classification.internal,
      external: classification.external,
      attempts,
      platform: queue?.platform,
    });

    if (classification.alert) {
      ledger.record('alert', {
        internal: classification.internal,
        reason: classification.reason,
        platform: queue?.platform,
      });
    }

    const canRetry = classification.retryable && attempts <= maxRetries;
    if (!canRetry) {
      if (classification.retryable && queue) {
        queue.markDeadLetter({ attempts, internal: classification.internal, reason: classification.reason });
      }
      return { ok: false, attempts, delays, history, deadLetter: Boolean(classification.retryable), ...last };
    }

    const delay = classification.retryAfterMs ?? Math.min(2000, baseDelayMs * 2 ** (attempts - 1));
    delays.push(delay);
    ledger.record('retry_scheduled', {
      attempt: attempts,
      delay,
      internal: classification.internal,
      platform: queue?.platform,
    });
    if (queue && classification.retryAfterMs !== undefined) queue.pause(classification.retryAfterMs);
    await clock.sleep(delay);
  }
}

/** 按 docs/12 §4 生成对外错误信封（仅取测试需要的字段）。 */
export function toErrorEnvelope(classification, requestId = 'req_fault_test') {
  const envelope = {
    request_id: requestId,
    error: {
      code: classification.external,
      message: classification.reason ?? classification.internal,
    },
  };
  if (classification.detailSub) envelope.error.detail = { sub: classification.detailSub };
  if (classification.retryAfterMs !== undefined) envelope.retry_after_ms = classification.retryAfterMs;
  return envelope;
}

/** 用矩阵行渲染用户可见提示（{n} / {seconds} 占位）。 */
export function renderUserHint(row, params = {}) {
  return String(row.user_hint ?? '')
    .replace('{n}', String(params.n ?? ''))
    .replace('{seconds}', String(params.seconds ?? ''));
}
