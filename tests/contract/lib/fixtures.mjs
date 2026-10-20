/**
 * 契约 fixture 加载、结构校验、脱敏校验与哈希。
 *
 * 目录约定（docs/15 §4.2）：
 *   tests/contract/fixtures/<platform>/<endpoint>/<recorded_at>.json
 *
 * fixture 结构：
 * {
 *   "meta": { platform, endpoint, recorded_at, doc_version, recorder, synthetic, schema },
 *   "request": { method, path, query, headers, body },
 *   "response": { status, headers, body },
 *   "expected_error"?: { internal, external }   // 错误映射用例
 * }
 *
 * 本目录的示例 fixture 标记 `synthetic:true`：平台接口文档尚未取得（docs/01/02 结论），
 * 仅用于验证回放器/脱敏/Schema 校验链路；t4/t5 拿到沙箱后按同格式替换为真实录制。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLATFORMS = new Set(['pdd', '1688']);
const REDACTED_RE = /^(<redacted:[a-z0-9_]+>|__REDACTED__)$/i;
const SENSITIVE_KEYS = new Set([
  'app_key',
  'appkey',
  'sign',
  'access_token',
  'timestamp',
  'nonce',
  'phone',
  'mobile',
  'receiver_address',
  'buyer_nick',
  'shop_name',
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fixtureHash(fixture) {
  return sha256(canonicalJson(fixture));
}

async function walk(dir, relDir = '') {
  let entries;
  try {
    entries = await readdir(path.join(dir, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(dir, rel)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(rel);
  }
  return files.sort();
}

async function loadJson(file) {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`fixture 不是合法 JSON：${file}（${error.message}）`);
  }
}

/** 校验单条 fixture 的结构与脱敏规则，返回错误列表。 */
export function validateFixture(fixture, { file = '(inline)' } = {}) {
  const errors = [];
  const meta = fixture?.meta;
  if (!meta || typeof meta !== 'object') return [`${file}: 缺少 meta`];
  if (!PLATFORMS.has(meta.platform)) errors.push(`${file}: meta.platform 必须是 pdd|1688`);
  if (!meta.endpoint) errors.push(`${file}: 缺少 meta.endpoint`);
  if (!meta.recorded_at || Number.isNaN(Date.parse(meta.recorded_at))) {
    errors.push(`${file}: meta.recorded_at 必须是 ISO8601`);
  }
  if (!meta.doc_version) errors.push(`${file}: 缺少 meta.doc_version`);
  if (!meta.recorder) errors.push(`${file}: 缺少 meta.recorder`);
  if (typeof meta.synthetic !== 'boolean') errors.push(`${file}: meta.synthetic 必须是布尔值`);

  const request = fixture?.request;
  const response = fixture?.response;
  if (!request || typeof request !== 'object') errors.push(`${file}: 缺少 request`);
  if (!response || typeof response !== 'object') errors.push(`${file}: 缺少 response`);
  if (request) {
    if (!/^[A-Z]+$/.test(request.method ?? '')) errors.push(`${file}: request.method 非法`);
    if (!String(request.path ?? '').startsWith('/')) errors.push(`${file}: request.path 必须以 / 开头`);
    if (request.query !== undefined && (typeof request.query !== 'object' || Array.isArray(request.query))) {
      errors.push(`${file}: request.query 必须是对象`);
    }
    if (request.body !== undefined && typeof request.body !== 'string' && typeof request.body !== 'object') {
      errors.push(`${file}: request.body 必须是对象或字符串`);
    }
    if (/access_token=/i.test(request.path ?? '')) errors.push(`${file}: request.path 含明文 access_token`);
  }
  if (response) {
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      errors.push(`${file}: response.status 非法`);
    }
    if (response.headers !== undefined && (typeof response.headers !== 'object' || Array.isArray(response.headers))) {
      errors.push(`${file}: response.headers 必须是对象`);
    }
  }

  // 脱敏：敏感键若出现，值必须是占位符
  const scan = (value, pointer) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => scan(item, `${pointer}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        if (typeof child === 'string' && !REDACTED_RE.test(child)) {
          errors.push(`${file}: ${pointer}.${key} 未脱敏（应为 <redacted:...>）`);
        }
      }
      scan(child, `${pointer}.${key}`);
    }
  };
  scan(request?.query, 'request.query');
  scan(request?.headers, 'request.headers');
  scan(request?.body, 'request.body');

  return errors;
}

/** 加载全部 fixture：返回 [{ file, fixture }] */
export async function loadFixtures(root = path.join(CONTRACT_ROOT, 'fixtures')) {
  const files = await walk(root);
  const fixtures = [];
  for (const rel of files) {
    const file = path.join(root, rel);
    const fixture = await loadJson(file);
    fixtures.push({ file: path.relative(CONTRACT_ROOT, file).replaceAll('\\', '/'), fixture });
  }
  return fixtures;
}

/** 加载 schema 文件（相对 CONTRACT_ROOT）。 */
export async function loadSchema(schemaId) {
  const file = path.join(CONTRACT_ROOT, schemaId);
  return { file: schemaId, schema: await loadJson(file) };
}

/** 按 meta.schema 为 fixture 找 schema；未声明则返回 null。 */
export async function loadFixtureSchema(fixture) {
  if (!fixture?.meta?.schema) return null;
  return loadSchema(fixture.meta.schema);
}
