/**
 * docs/12 §4 统一错误码表的只读解析器。
 * 用途：契约测试断言 error-map 的 external code 不漂移出文档词表。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_12 = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/12-接口契约与数据模型.md',
);

/** @returns {Promise<Map<string, { http: number, retryable: string }>>} */
export async function loadDocErrorCodes() {
  const text = await readFile(DOCS_12, 'utf8');
  const section = text.split('## 4. 统一错误码与 HTTP 映射')[1];
  if (!section) throw new Error('docs/12 §4 未找到错误码表');
  const table = section.split('\n---')[0];
  const codes = new Map();
  for (const line of table.split('\n')) {
    const match = line.match(/^\|\s*`([a-z0-9_]+)`\s*\|\s*(\d{3})\s*\|\s*([^|]+)\|/);
    if (match) codes.set(match[1], { http: Number(match[2]), retryable: match[3].trim() });
  }
  if (codes.size === 0) throw new Error('docs/12 §4 错误码表解析为空');
  return codes;
}
