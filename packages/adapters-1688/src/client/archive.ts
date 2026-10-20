/**
 * 请求/响应留档 —— docs/02 §三、docs/15 §4.2、docs/20（凭据与存储边界）。
 *
 * 为什么必须留档：
 * - 1688 侧「改价 / 换主图 / 下架」等动作不可回滚，出事只能靠报文对账（docs/00 §9.3）；
 * - 契约漂移排查需要「当时到底发了什么、平台回了什么」（docs/15 §4.4）；
 * - 留档本身是**脱敏后**的：签名、令牌、时间戳、nonce、手机号、地址、昵称、店铺名
 *   一律替换为占位符（docs/15 §4.2.3），否则等于把凭据写进日志。
 *
 * 与本包的边界：留档只写「一请求一文件」的结构化 JSON，不落数据库；
 * 生产环境由 worker 把归档目录同步到对象存储（docs/20 备份矩阵）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HttpRequest, HttpResponse } from './types.js';

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** 需要脱敏的键名（大小写不敏感；含 `_`/`-` 变体）。 */
export const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^app[_-]?key$/i,
  /^app[_-]?secret$/i,
  /secret/i,
  /^sign$/i,
  /^signature$/i,
  /^sign[_-]?method$/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /^token$/i,
  /password/i,
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^timestamp$/i,
  /^ts$/i,
  /^nonce$/i,
  /^x-request-id$/i,
];

/** 中国大陆手机号（录制 fixture 时也要脱敏）。 */
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

export function isSensitiveKey(key: string): boolean {
  // 平台可能用 `x-app-key` 之类的前缀，匹配前先去掉 `x-`。
  const normalized = key.replace(/^x-/i, '');
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** header 脱敏。 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key) ? REDACTION_PLACEHOLDER : value.replace(PHONE_RE, REDACTION_PLACEHOLDER);
  }
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTION_PLACEHOLDER;
  if (typeof value === 'string') return value.replace(PHONE_RE, REDACTION_PLACEHOLDER);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTION_PLACEHOLDER : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 请求体脱敏：JSON 逐键脱敏；form/其它文本按 `key=value` 与手机号做替换。
 * 返回 `null` 表示原本无 body。
 */
export function redactBody(body: string | null): string | null {
  if (body === null) return null;
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactValue(JSON.parse(trimmed)));
    } catch {
      // 落回文本处理
    }
  }
  return body
    .replace(PHONE_RE, REDACTION_PLACEHOLDER)
    .replace(/(^|[&\s])([A-Za-z0-9_.-]+)=([^&\s]*)/g, (match, lead: string, key: string) =>
      isSensitiveKey(key) ? `${lead}${key}=${REDACTION_PLACEHOLDER}` : match,
    );
}

export interface ArchivedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** 脱敏后的 body 长度（便于定位截断问题）。 */
  bodyBytes: number | null;
}

export interface ArchivedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: number;
}

export interface ArchiveEntry {
  requestId: string;
  operation: string;
  attempt: number;
  occurredAt: string;
  durationMs: number;
  request: ArchivedRequest;
  response: ArchivedResponse | null;
  error: { code: string; message: string; retryable: boolean } | null;
  meta: {
    signerId: string | null;
    redacted: true;
    /** 契约版本占位；核验后写平台文档版本/公告号（docs/15 §4.2.5）。 */
    contractVersion: string | null;
  };
}

export interface ArchiveSink {
  write(entry: ArchiveEntry): Promise<void>;
}

/** URL 脱敏：query 中的签名/时间戳/nonce 等易变参数替换为占位符。 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSensitiveKey(key)) {
        parsed.searchParams.set(key, REDACTION_PLACEHOLDER);
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url.replace(/([?&])([A-Za-z0-9_.-]+)=([^&]*)/g, (match, lead: string, key: string) =>
      isSensitiveKey(key) ? `${lead}${key}=${REDACTION_PLACEHOLDER}` : match,
    );
  }
}

/** 归档请求（已脱敏）。 */
export function archiveRequest(request: HttpRequest): ArchivedRequest {
  const body = redactBody(request.body);
  return {
    method: request.method,
    url: redactUrl(request.url),
    headers: redactHeaders(request.headers),
    body,
    bodyBytes: body === null ? null : Buffer.byteLength(body, 'utf8'),
  };
}

/** 归档响应（截断保护：单条响应体最多保留 64 KiB）。 */
export function archiveResponse(response: HttpResponse, maxBytes = 64 * 1024): ArchivedResponse {
  const truncated =
    Buffer.byteLength(response.body, 'utf8') > maxBytes
      ? `${Buffer.from(response.body, 'utf8').subarray(0, maxBytes).toString('utf8')}…[truncated]`
      : response.body;
  return {
    status: response.status,
    headers: redactHeaders(response.headers),
    body: redactBody(truncated) ?? '',
    bodyBytes: Buffer.byteLength(response.body, 'utf8'),
  };
}

/** 内存归档（测试/单测用）。 */
export class MemoryArchiveSink implements ArchiveSink {
  readonly entries: ArchiveEntry[] = [];

  async write(entry: ArchiveEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** 目录归档：一请求一 JSON 文件，文件名含时间与 attempt，便于 grep 与按序回放。 */
export class DirectoryArchiveSink implements ArchiveSink {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async write(entry: ArchiveEntry): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const stamp = entry.occurredAt.replaceAll(':', '-').replaceAll('.', '-');
    const safeOperation = entry.operation.replaceAll(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(this.directory, `${stamp}__${safeOperation}__a${entry.attempt}__${entry.requestId}.json`);
    await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  }
}

/** 显式空归档：**只允许**用于纯校验/干跑；真实调用必须注入持久 sink。 */
export const NOOP_ARCHIVE_SINK: ArchiveSink = {
  async write(): Promise<void> {
    return;
  },
};
