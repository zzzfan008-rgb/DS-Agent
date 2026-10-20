/**
 * 平台错误 → 内部失败分类 → docs/12 §4 对外错误码。
 * 回放测试用它断言错误 fixture 的映射与 docs/12 词表一致。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../error-map.json');

export async function loadErrorMap() {
  return JSON.parse(await readFile(MAP_FILE, 'utf8'));
}

function matchStatus(expected, actual) {
  if (typeof expected === 'number') return actual === expected;
  if (expected === '5xx') return actual >= 500 && actual <= 599;
  if (expected === '4xx') return actual >= 400 && actual <= 499;
  return false;
}

function bodyCodeOf(body) {
  if (!body || typeof body !== 'object') return undefined;
  return body.error_code ?? body.errorCode;
}

function matches(entry, response) {
  const match = entry.match ?? {};
  if (match.http_status !== undefined && !matchStatus(match.http_status, response.status)) return false;
  if (match['body.success'] !== undefined) {
    const actual = response.body && typeof response.body === 'object' ? response.body.success : undefined;
    if (actual !== match['body.success']) return false;
  }
  if (match.body_error_code_in !== undefined) {
    if (!match.body_error_code_in.includes(bodyCodeOf(response.body))) return false;
  }
  return true;
}

/** @returns {{entry:object, reason:string}|null} */
export function resolveError(errorMap, platform, response) {
  const entries = errorMap.platforms?.[platform] ?? [];
  for (const entry of entries) {
    if (matches(entry, response)) return { entry, reason: entry.id };
  }
  return null;
}
