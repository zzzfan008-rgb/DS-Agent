/**
 * 请求/响应留档（docs/01 §6.4 契约回归基线、docs/11 写入门审计证据）。
 *
 * 落盘格式：一次尝试一个 JSON 文件（**不是** jsonl，避免与 docs/15 §10 的边界规则冲突），
 * 路径 `<archiveDir>/<YYYY-MM-DD>/<call_id>-a<attempt>.json`，权限尽量 0o600。
 *
 * 脱敏：凭据、签名、timestamp/nonce、收件人 PII 一律替换为 `[REDACTED]`；
 * 同时保留原始请求/响应体的 sha256（不可逆），供后续对账与契约 diff 使用。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonical, sha256Hex } from '../util/canonical.js';
import { utcDay } from '../util/ids.js';
import { redactDeep, redactHeaders, redactJsonText } from '../util/redact.js';

export interface ArchivedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  body_sha256: string;
  truncated: boolean;
}

export interface CallArchiveRecord {
  schema_version: 'pdd-call-v1';
  call_id: string;
  request_id: string;
  interface_key: string;
  transport: 'dry_run' | 'http' | 'replay';
  attempt: number;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  request: {
    method: string | null;
    path: string | null;
    url: string | null;
    headers: Record<string, string>;
    body: unknown;
    body_sha256: string;
  };
  response?: ArchivedResponse;
  outcome: 'success' | 'failure' | 'dry_run';
  error?: {
    code: string;
    error_class: string;
    retryable: boolean;
    next_action: string;
    message: string;
    status?: number;
  };
  idempotency_key?: string | null;
  metadata?: Record<string, string>;
  redaction: 'archive-v1';
  notes?: string[];
}

export interface RequestArchiver {
  archive(record: CallArchiveRecord): Promise<string | null>;
}

export class NullArchiver implements RequestArchiver {
  async archive(): Promise<string | null> {
    return null;
  }
}

export interface JsonFileArchiverOptions {
  dir: string;
  /** 单个 JSON 文件最大字符数；超过则截断并标记。默认 1 MiB。 */
  maxFileChars?: number;
}

export class JsonFileArchiver implements RequestArchiver {
  private readonly dir: string;
  private readonly maxFileChars: number;

  constructor(options: JsonFileArchiverOptions) {
    this.dir = path.resolve(options.dir);
    this.maxFileChars = options.maxFileChars ?? 1024 * 1024;
  }

  async archive(record: CallArchiveRecord): Promise<string> {
    const day = utcDay(Date.parse(record.started_at));
    const dir = path.join(this.dir, day);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${record.call_id}-a${record.attempt}.json`);
    const payload = this.prepare(record);
    const text = JSON.stringify(payload, null, 2);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
    return file;
  }

  private prepare(record: CallArchiveRecord): CallArchiveRecord {
    const notes = [...(record.notes ?? [])];
    const requestBodyRedacted = redactDeep(record.request.body);
    let response = record.response;
    if (response) {
      response = {
        ...response,
        headers: redactHeaders(response.headers),
        body: redactDeep(response.body),
      };
    }
    const prepared: CallArchiveRecord = {
      ...record,
      request: {
        ...record.request,
        headers: redactHeaders(record.request.headers),
        body: requestBodyRedacted,
      },
      response,
      notes: notes.length > 0 ? notes : undefined,
    };
    const text = JSON.stringify(prepared);
    if (text.length <= this.maxFileChars) return prepared;
    // 超限：保留结构，截断 body 字段并显式标记，避免把大响应整个写盘。
    return {
      ...prepared,
      request: {
        ...prepared.request,
        body: { _truncated: true, body_sha256: prepared.request.body_sha256 },
      },
      response: prepared.response
        ? { ...prepared.response, body: { _truncated: true, body_sha256: prepared.response.body_sha256 } }
        : undefined,
      notes: [...notes, `archive_truncated_at_${this.maxFileChars}_chars`],
    };
  }
}

/** 构造请求体摘要：保留 sha256，正文已脱敏。 */
export function requestBodyDigest(body: unknown): { redacted: unknown; body_sha256: string } {
  return { redacted: redactDeep(body), body_sha256: hashCanonical(body) };
}

export function responseBodyDigest(bodyText: string, body: unknown): { redacted: unknown; body_sha256: string } {
  return { redacted: redactJsonText(bodyText), body_sha256: sha256Hex(bodyText) };
}
