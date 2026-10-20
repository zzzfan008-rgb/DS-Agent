/**
 * 规范化 JSON 与哈希工具。
 *
 * 规则对齐 docs/11 §5.2（幂等键规范化）：
 * - 对象键按码点升序；
 * - 字符串 trim + NFC + 连续空白压成一个空格；
 * - null / undefined / 空字符串在对象中删除；
 * - 数组保序；
 * - 整数不带小数点。
 *
 * 用途仅限适配层内部：签名材料摘要、fixture 请求匹配、上架包 payload_hash。
 * 平台写入门使用的正式 canonical 实现由 packages/core 提供（后续任务），
 * 二者规则一致，这里不反向依赖 core，避免 M1 阶段跨包耦合。
 */

import { createHash } from 'node:crypto';

function canonicalScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonicalJson: 非有限数值 ${String(value)}`);
    return Number.isInteger(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  return JSON.stringify(normalized);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => {
        const item = record[key];
        return item !== undefined && item !== null && item !== '';
      })
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return canonicalScalar(value);
  }
  throw new Error(`canonicalJson: 不支持的类型 ${typeof value}`);
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
