/**
 * 幂等键规范化（docs/11 §5.2）。
 *
 * 规则：
 * - 键按 UTF-8 码点升序；
 * - 删除 timestamp/nonce/sign/request_id/trace_id/retry_count/attempt；
 * - 金额/计数字段必须是整数分，由 zod/schema 与业务校验保证；canonical 层只要求有限数字，
 *   允许尺码测量等有限小数（JSON.stringify 语义）；
 * - 字符串 trim + NFC + 连续空白压一个空格；
 * - null/undefined/空字符串删除该键；
 * - 数组默认保序，集合语义字段由调用方显式排序。
 */
import { createHash } from 'node:crypto';

const VOLATILE_KEYS = new Set([
  'timestamp',
  'nonce',
  'sign',
  'signature',
  'request_id',
  'trace_id',
  'retry_count',
  'attempt',
]);

export function normalizeString(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > 20) throw new Error('canonicalValue: nesting too deep');
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalValue: non-finite number');
    // 有限小数合法：尺码测量支持 0.5cm 步进；金额整数由 schema/business 校验负责。
    return value === 0 ? 0 : value;
  }
  if (typeof value === 'string') {
    const normalized = normalizeString(value);
    return normalized === '' ? undefined : normalized;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => canonicalValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const normalized = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  throw new Error(`canonicalValue: unsupported type ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function computeBizKey(input: {
  orgId: number | bigint;
  workflowType: string;
  businessKey: string;
}): string {
  return sha256Hex(`wf|v1|${input.orgId}|${input.workflowType}|${normalizeString(input.businessKey)}`);
}

export function computeStepKey(input: {
  runId: string;
  stepName: string;
  stepInputHash: string;
}): string {
  return sha256Hex(`step|v1|${input.runId}|${input.stepName}|${input.stepInputHash}`);
}

export function computeWriteKey(input: {
  platform: string;
  action: string;
  payload: unknown;
}): string {
  return sha256Hex(`write|v1|${input.platform}|${input.action}|${canonicalJson(input.payload)}`);
}

export function computeMessageKey(input: {
  platform: string;
  conversationId: string;
  outboundBusinessKey: string;
}): string {
  return sha256Hex(
    `msg|v1|${input.platform}|${input.conversationId}|${normalizeString(input.outboundBusinessKey)}`,
  );
}

/** 供审计/审批使用的稳定对象哈希（不是幂等键）。 */
export function computeTargetHash(payload: unknown): string {
  return canonicalHash(payload);
}
