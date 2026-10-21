/**
 * 拼多多真实 API 调用器（按官方文档实现）。
 *
 * 与 `PddClient` 的分工：
 * - `PddClient` 是**写路径**的完整客户端（写入门 S1–S9、限流、重试、留档、dry-run），
 *   它要求接口在注册表中「已核验」，未核验一律拒绝真实调用；
 * - 本文件是**读路径的连通性探针**：只做一件事——用真实签名打一次真实网关，
 *   把结果分类成可诊断的结论。它不写库、不重试、不参与审批。
 *
 * 为什么单独一个文件而不塞进 PddClient：
 * 探针需要能在「接口注册表还没填实」的阶段就跑通（否则永远无法验证签名是否正确），
 * 而 PddClient 的硬门设计上不允许这么做。两者职责不同，混在一起会让硬门出现例外。
 *
 * 官方依据（2026-10-21 抓取）：
 * - 网关 https://gw-api.pinduoduo.com/api/router
 * - POST + content-type: application/json，所有参数（含 sign）在 body
 * - 签名见 pdd-signer.ts
 */

import { buildPddRequestBody, PDD_GATEWAY, type PddSignableValue } from './pdd-signer.js';

/** 探针结果分类——每一种都对应明确的用户处置动作。 */
export type PddProbeOutcome =
  | 'ok'
  | 'credential_invalid'
  | 'signature_invalid'
  | 'token_invalid'
  | 'permission_denied'
  | 'unreachable'
  | 'unknown_error';

export interface PddProbeResult {
  outcome: PddProbeOutcome;
  /** 是否成功（只有 outcome==='ok' 时为 true）。 */
  ok: boolean;
  /** 面向用户的一句话结论（中文，可直接显示在界面上）。 */
  message: string;
  /** 建议的处置动作。 */
  nextAction: string;
  /** 拼多多返回的原始错误码/子码（若有），用于排查。 */
  errorCode: number | null;
  errorSubCode: string | null;
  errorMessage: string | null;
  /** HTTP 状态码（网络层失败为 null）。 */
  httpStatus: number | null;
  /** 耗时毫秒。 */
  elapsedMs: number;
  /** 请求的接口名与网关，便于用户核对。 */
  apiType: string;
  gateway: string;
  /** 服务端返回的原始响应体（截断，便于排查；不含请求凭据）。 */
  rawResponse: string | null;
}

export interface PddProbeOptions {
  clientId: string;
  clientSecret: string;
  accessToken?: string | null;
  /** 探针使用的接口；默认 `pdd.time.get`（最轻、无业务参数）。 */
  apiType?: string;
  /** 业务参数；`pdd.time.get` 无需参数。 */
  business?: Record<string, PddSignableValue>;
  timeoutMs?: number;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
  /** 测试注入点：固定时间戳。 */
  timestamp?: number;
}

/**
 * 拼多多错误码 → 处置建议。
 *
 * 来源分两类：
 * - **实测确认**（2026-10-21 用无效凭据真实调用 gw-api.pinduoduo.com 得到）：
 *   `10016` = client下线或者clientId不正确。
 * - **按语义归类**（官方错误码表需登录控制台查看，未获取到完整表）：10001/10002
 *   归签名类、10003 归 token 类、10004 归权限类。这些是常见约定，但**未逐条实测**，
 *   若真实返回的码与此不符，会落到 unknown_error 并保留原始码，不会误判成成功。
 */
const KNOWN_ERRORS: Record<number, { outcome: PddProbeOutcome; message: string; nextAction: string }> = {
  // 实测确认：clientId 无效/应用下线
  10016: {
    outcome: 'credential_invalid',
    message: 'clientId 不正确或应用已下线：请核对开放平台「应用详情」中的 client_id 是否填对',
    nextAction: 'recheck_client_id',
  },
  // 以下按语义归类（未实测）
  10001: {
    outcome: 'signature_invalid',
    message: '签名校验失败：请检查 client_secret 是否填写正确（注意首尾空格）',
    nextAction: 'recheck_client_secret',
  },
  10002: {
    outcome: 'signature_invalid',
    message: '签名校验失败：参数或 client_secret 不匹配',
    nextAction: 'recheck_client_secret',
  },
  10003: {
    outcome: 'token_invalid',
    message: 'access_token 无效或已过期（有效期 24 小时），请重新授权',
    nextAction: 'reauth',
  },
  10004: {
    outcome: 'permission_denied',
    message: '当前应用无此接口权限，请在开放平台申请对应权限',
    nextAction: 'apply_permission',
  },
};

function classifyError(errorCode: number | null, sub: string | null, msg: string | null): {
  outcome: PddProbeOutcome;
  message: string;
  nextAction: string;
} {
  if (errorCode !== null && KNOWN_ERRORS[errorCode]) return KNOWN_ERRORS[errorCode];

  // 未收录的码：按文案关键词兜底分类（不猜码值，只做提示语匹配）。
  const text = `${sub ?? ''} ${msg ?? ''}`.toLowerCase();
  if (text.includes('sign') || text.includes('签名')) {
    return {
      outcome: 'signature_invalid',
      message: `签名校验失败（平台返回：${msg ?? sub ?? '未知'}）`,
      nextAction: 'recheck_client_secret',
    };
  }
  if (text.includes('token') || text.includes('授权')) {
    return {
      outcome: 'token_invalid',
      message: `access_token 无效或已过期（平台返回：${msg ?? sub ?? '未知'}）`,
      nextAction: 'reauth',
    };
  }
  if (text.includes('permission') || text.includes('权限')) {
    return {
      outcome: 'permission_denied',
      message: `应用无此接口权限（平台返回：${msg ?? sub ?? '未知'}）`,
      nextAction: 'apply_permission',
    };
  }
  return {
    outcome: 'unknown_error',
    message: `平台返回未分类错误：${msg ?? sub ?? '未知'}（code=${errorCode ?? '无'}）`,
    nextAction: 'check_platform_error_doc',
  };
}

/**
 * 用真实签名打一次拼多多网关，返回可诊断结论。
 *
 * 设计原则：
 * - **绝不把失败包装成成功**；网络不通、签名错、token 过期都各自如实报告。
 * - 不重试：探针的目的是「现在这一刻通不通」，重试会掩盖真实问题。
 * - 不写库：由调用方（服务层）决定是否把结果落库。
 */
export async function probePddConnection(options: PddProbeOptions): Promise<PddProbeResult> {
  const apiType = options.apiType ?? 'pdd.time.get';
  const business = options.business ?? {};
  const startedAt = Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const { body } = buildPddRequestBody(apiType, business, {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    accessToken: options.accessToken ?? null,
    ...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
  });

  const base: Omit<PddProbeResult, 'outcome' | 'ok' | 'message' | 'nextAction' | 'elapsedMs'> = {
    errorCode: null,
    errorSubCode: null,
    errorMessage: null,
    httpStatus: null,
    apiType,
    gateway: PDD_GATEWAY,
    rawResponse: null,
  };

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchImpl(PDD_GATEWAY, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ...base,
      outcome: 'unreachable',
      ok: false,
      message: isAbort
        ? `请求超时（${timeoutMs}ms）：无法在限定时间内连上 ${PDD_GATEWAY}`
        : `网络不通：无法连接 ${PDD_GATEWAY}（${err instanceof Error ? err.message : String(err)}）`,
      nextAction: 'check_network_and_firewall',
      elapsedMs,
    };
  }

  const httpStatus = response.status;
  const text = await response.text().catch(() => '');
  const elapsedMs = Date.now() - startedAt;
  const rawResponse = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;

  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  // 拼多多成功响应形如 { "<api_type with dots→underscores>_response": { ... } }
  const errorResponse = (json as { error_response?: Record<string, unknown> } | null)?.error_response;
  if (errorResponse) {
    const errorCode = typeof errorResponse.error_code === 'number' ? errorResponse.error_code : null;
    const sub = typeof errorResponse.sub_code === 'string' ? errorResponse.sub_code : null;
    const msg = typeof errorResponse.error_msg === 'string' ? errorResponse.error_msg : null;
    const cls = classifyError(errorCode, sub, msg);
    return {
      ...base,
      outcome: cls.outcome,
      ok: false,
      message: cls.message,
      nextAction: cls.nextAction,
      errorCode,
      errorSubCode: sub,
      errorMessage: msg,
      httpStatus,
      elapsedMs,
      rawResponse,
    };
  }

  if (httpStatus >= 200 && httpStatus < 300 && json !== null) {
    return {
      ...base,
      outcome: 'ok',
      ok: true,
      message: `连接成功：${apiType} 返回正常（HTTP ${httpStatus}，耗时 ${elapsedMs}ms）`,
      nextAction: 'none',
      httpStatus,
      elapsedMs,
      rawResponse,
    };
  }

  return {
    ...base,
    outcome: 'unknown_error',
    ok: false,
    message: `平台返回无法解析的响应（HTTP ${httpStatus}）`,
    nextAction: 'check_platform_error_doc',
    httpStatus,
    elapsedMs,
    rawResponse,
  };
}
