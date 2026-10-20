/**
 * 确定性 JSON 与哈希 —— 上架包 diff、幂等键、请求指纹共用的最小工具。
 *
 * 为什么需要「确定性」：上架包与幂等键必须**同内容同哈希**，否则同一份数据
 * 换个键顺序就会生成新的 packageHash / 幂等键，导致重复写与重复审批。
 */

import { createHash } from 'node:crypto';

/** 稳定 JSON：对象键按字典序，数组保序。 */
export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = walk(record[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/** sha256(canonicalJson(value)) 的十六进制摘要。 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** 字符串 sha256。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
