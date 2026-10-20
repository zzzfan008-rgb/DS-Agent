/**
 * 录制回放（docs/01 §6.4、docs/15 §4）。
 *
 * fixture 结构**对齐 `tests/contract/lib/fixtures.mjs`** 的格式：
 *   { meta: { platform, endpoint, recorded_at, doc_version, recorder, synthetic, schema? },
 *     request: { method, path, query?, headers?, body? },
 *     response: { status, headers?, body?, delay_ms? },
 *     expected_error?: { internal, external } }
 *
 * 三条硬规则：
 * 1) 未取得沙箱前，仓库内 fixture 一律 `meta.synthetic=true`，只验证传输/错误映射链路，
 *    不冒充真实平台录制；
 * 2) 录制时脱敏（凭据、签名、timestamp/nonce、收件人 PII），落盘用 `<redacted:键名>`；
 * 3) 回放严格匹配：endpoint + method + path + query + body，不匹配即失败，
 *    绝不静默 fallback 到真实网络。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PddError } from '../errors.js';
import { canonicalJson } from '../util/canonical.js';
import { isoNow } from '../util/ids.js';
import { redactDeep, redactHeaders } from '../util/redact.js';
import type { HttpTransport, TransportRequest, TransportResponse } from './transport.js';

export interface ReplayFixtureMeta {
  platform: 'pdd' | '1688';
  endpoint: string;
  recorded_at: string;
  doc_version: string;
  recorder: string;
  synthetic: boolean;
  schema?: string;
}

export interface ReplayFixtureRequest {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ReplayFixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  delay_ms?: number;
}

export interface ReplayFixture {
  meta: ReplayFixtureMeta;
  request: ReplayFixtureRequest;
  response: ReplayFixtureResponse;
  expected_error?: { internal?: string; external?: string };
}

export interface LoadedFixture {
  file: string;
  fixture: ReplayFixture;
}

export function validateReplayFixture(value: unknown, file = '(inline)'): string[] {
  const errors: string[] = [];
  const fixture = value as Partial<ReplayFixture> | null;
  if (!fixture || typeof fixture !== 'object') return [`${file}: fixture 必须是对象`];
  const meta = fixture.meta;
  if (!meta || typeof meta !== 'object') {
    errors.push(`${file}: 缺少 meta`);
  } else {
    if (meta.platform !== 'pdd' && meta.platform !== '1688') errors.push(`${file}: meta.platform 必须是 pdd|1688`);
    if (typeof meta.endpoint !== 'string' || meta.endpoint.trim() === '') errors.push(`${file}: 缺少 meta.endpoint`);
    if (typeof meta.recorded_at !== 'string' || Number.isNaN(Date.parse(meta.recorded_at))) {
      errors.push(`${file}: meta.recorded_at 必须是 ISO8601`);
    }
    if (typeof meta.doc_version !== 'string' || meta.doc_version.trim() === '') errors.push(`${file}: 缺少 meta.doc_version`);
    if (typeof meta.recorder !== 'string' || meta.recorder.trim() === '') errors.push(`${file}: 缺少 meta.recorder`);
    if (typeof meta.synthetic !== 'boolean') errors.push(`${file}: meta.synthetic 必须是布尔值`);
  }
  const request = fixture.request;
  if (!request || typeof request !== 'object') {
    errors.push(`${file}: 缺少 request`);
  } else {
    if (typeof request.method !== 'string' || !/^[A-Z]+$/.test(request.method)) errors.push(`${file}: request.method 非法`);
    if (typeof request.path !== 'string' || !request.path.startsWith('/')) errors.push(`${file}: request.path 必须以 / 开头`);
    if (request.query !== undefined && (typeof request.query !== 'object' || Array.isArray(request.query))) {
      errors.push(`${file}: request.query 必须是对象`);
    }
    if (request.headers !== undefined && (typeof request.headers !== 'object' || Array.isArray(request.headers))) {
      errors.push(`${file}: request.headers 必须是对象`);
    }
  }
  const response = fixture.response;
  if (!response || typeof response !== 'object') {
    errors.push(`${file}: 缺少 response`);
  } else if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    errors.push(`${file}: response.status 非法`);
  }
  return errors;
}

async function walkJsonFiles(dir: string, relDir = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walkJsonFiles(dir, rel)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(rel);
  }
  return files;
}

/** 读取目录下全部 fixture；结构不合法直接抛错（不跳过，避免回放基线悄悄减少）。 */
export async function loadReplayFixtures(dir: string): Promise<LoadedFixture[]> {
  const files = await walkJsonFiles(dir);
  const loaded: LoadedFixture[] = [];
  for (const rel of files) {
    const file = path.join(dir, rel);
    const text = await readFile(file, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`fixture 不是合法 JSON：${file}（${(error as Error).message}）`);
    }
    const errors = validateReplayFixture(parsed, file);
    if (errors.length > 0) throw new Error(`fixture 结构非法：\n- ${errors.join('\n- ')}`);
    loaded.push({ file, fixture: parsed as ReplayFixture });
  }
  return loaded;
}

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) out[key] = value;
  return out;
}

function queriesEqual(actual: Record<string, string>, expected: Record<string, string | number | boolean> | undefined): boolean {
  const expectedEntries = Object.entries(expected ?? {}).map(([key, value]) => [key, String(value)] as const).sort(([a], [b]) => a.localeCompare(b));
  const actualEntries = Object.entries(actual).sort(([a], [b]) => a.localeCompare(b));
  return canonicalJson(actualEntries) === canonicalJson(expectedEntries);
}

function bodyOf(request: TransportRequest): unknown {
  if (request.bodyText.trim() === '') return undefined;
  try {
    return JSON.parse(request.bodyText);
  } catch {
    return request.bodyText;
  }
}

export function matchFixture(
  fixture: ReplayFixture,
  request: TransportRequest,
): boolean {
  if (fixture.meta.endpoint !== request.interfaceKey) return false;
  if (fixture.request.method !== request.method.toUpperCase()) return false;
  const url = new URL(request.url);
  if (url.pathname !== fixture.request.path) return false;
  if (!queriesEqual(queryOf(url), fixture.request.query)) return false;
  if (fixture.request.body !== undefined) {
    if (canonicalJson(bodyOf(request)) !== canonicalJson(fixture.request.body)) return false;
  }
  return true;
}

interface ReplayMatch {
  fixture: ReplayFixture;
  file: string;
}

export interface ReplayTransportOptions {
  fixtures: LoadedFixture[];
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 进程内回放：不绑定端口、不触网。 */
export class ReplayTransport implements HttpTransport {
  private readonly fixtures: LoadedFixture[];
  private readonly used = new Set<number>();
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ReplayTransportOptions) {
    this.fixtures = options.fixtures;
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  get usedCount(): number {
    return this.used.size;
  }

  get unusedCount(): number {
    return this.fixtures.length - this.used.size;
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const match = this.findMatch(request);
    if (!match) {
      const known = this.fixtures
        .filter((item) => item.fixture.meta.endpoint === request.interfaceKey)
        .map((item) => `${item.fixture.request.method} ${item.fixture.request.path}`);
      throw new PddError({
        code: 'replay_mismatch',
        message: `回放无匹配 fixture：${request.interfaceKey} ${request.method} ${new URL(request.url).pathname}`,
        errorClass: 'permanent',
        nextAction: 'fix_and_resubmit',
        requestId: request.requestId,
        detail: {
          interface_key: request.interfaceKey,
          method: request.method,
          known_routes: known,
          fixtures_loaded: this.fixtures.length,
        },
      });
    }
    if ((match.fixture.response.delay_ms ?? 0) > 0) await this.sleep(match.fixture.response.delay_ms ?? 0);
    return {
      status: match.fixture.response.status,
      headers: { ...(match.fixture.response.headers ?? {}) },
      bodyText: match.fixture.response.body === undefined ? '' : JSON.stringify(match.fixture.response.body),
      body: match.fixture.response.body,
      receivedAtMs: this.clock(),
      truncated: false,
    };
  }

  private findMatch(request: TransportRequest): ReplayMatch | null {
    for (let index = 0; index < this.fixtures.length; index += 1) {
      if (this.used.has(index)) continue;
      const item = this.fixtures[index];
      if (!item) continue;
      if (!matchFixture(item.fixture, request)) continue;
      this.used.add(index);
      return item;
    }
    return null;
  }
}

export interface RecordingTransportOptions {
  dir: string;
  /** 真实录制必须为 false；未取得沙箱前的链路测试用 true。 */
  synthetic: boolean;
  recorder?: string;
  clock?: () => number;
  /** 立即落盘。默认 true。 */
  save?: boolean;
}

/** 包一层真实/回放传输，把每次成功响应录成 fixture。 */
export class RecordingTransport implements HttpTransport {
  private readonly delegate: HttpTransport;
  private readonly dir: string;
  private readonly synthetic: boolean;
  private readonly recorder: string;
  private readonly clock: () => number;
  private readonly save: boolean;
  private readonly recordedFixtures: LoadedFixture[] = [];

  constructor(delegate: HttpTransport, options: RecordingTransportOptions) {
    this.delegate = delegate;
    this.dir = path.resolve(options.dir);
    this.synthetic = options.synthetic;
    this.recorder = options.recorder ?? 'dssaas-adapters-pdd';
    this.clock = options.clock ?? Date.now;
    this.save = options.save ?? true;
  }

  get recorded(): LoadedFixture[] {
    return [...this.recordedFixtures];
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    const response = await this.delegate.request(request);
    const fixture = this.toFixture(request, response);
    const endpointDir = path.join(this.dir, sanitizeEndpoint(fixture.meta.endpoint));
    const file = path.join(endpointDir, `${fixture.meta.recorded_at.replace(/[:.]/g, '-')}.json`);
    if (this.save) {
      await mkdir(endpointDir, { recursive: true });
      await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    this.recordedFixtures.push({ file, fixture });
    return response;
  }

  private toFixture(request: TransportRequest, response: TransportResponse): ReplayFixture {
    const url = new URL(request.url);
    return {
      meta: {
        platform: 'pdd',
        endpoint: request.interfaceKey,
        recorded_at: isoNow(this.clock()),
        doc_version: this.synthetic
          ? 'synthetic（docs/01 未取得接口文档；仅验证回放链路）'
          : 'docs/01 v0.1（待核验；真实录制需脱敏后入库）',
        recorder: this.recorder,
        synthetic: this.synthetic,
      },
      request: {
        method: request.method.toUpperCase(),
        path: url.pathname,
        query: queryOf(url),
        headers: redactHeaders(request.headers, 'fixture'),
        body: redactDeep(bodyOf(request), 'fixture'),
      },
      response: {
        status: response.status,
        headers: redactHeaders(response.headers, 'fixture'),
        body: redactDeep(response.body, 'fixture'),
      },
    };
  }
}

function sanitizeEndpoint(endpoint: string): string {
  const safe = endpoint.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe === '' ? 'unknown' : safe;
}

/** 批量落盘 fixture（用于把 RecordingTransport 录制的数组写到目标目录）。 */
export async function saveReplayFixtures(dir: string, fixtures: readonly LoadedFixture[]): Promise<void> {
  for (const item of fixtures) {
    const endpointDir = path.join(dir, sanitizeEndpoint(item.fixture.meta.endpoint));
    await mkdir(endpointDir, { recursive: true });
    const name = path.basename(item.file);
    await writeFile(path.join(endpointDir, name), `${JSON.stringify(item.fixture, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
