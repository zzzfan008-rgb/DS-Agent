/** 事实信封（docs/06 §6.5）：canonical JSON + sha256 facts_hash，事实单一化的哈希锚点。 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './idempotency/canonical.js';

export interface FactItem {
  key: string;
  value: string | number | boolean;
  unit?: string;
  source: 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier' | 'kb';
  source_table: string;
  source_id: string;
  source_version: number;
  effective_from?: string | null;
  quote?: string | null;
}

export interface FactEnvelope {
  facts_version: 1;
  captured_at: string;
  items: FactItem[];
  facts_hash: string;
}

/**
 * 规范化与哈希**只允许一个实现**：统一走 `idempotency/canonical.ts`。
 * 曾经这里有一份独立实现（排序但不剥 volatile 字段），与幂等键的规范化语义不同，
 * 会导致同一逻辑负载在 facts_hash 与 idempotency_key 两处算出不同值。
 */

/** 哈希输入按 (key, source_table, source_id) 排序，避免数组顺序造成 facts_hash 抖动。 */
export function computeFactsHash(input: {
  facts_version: number;
  captured_at: string;
  items: unknown[];
}): string {
  const items = [...input.items].sort((left, right) => {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    return `${a.key}|${a.source_table}|${a.source_id}`.localeCompare(
      `${b.key}|${b.source_table}|${b.source_id}`,
    );
  });
  return createHash('sha256')
    .update(
      canonicalJson({
        facts_version: input.facts_version,
        items,
      }),
      'utf8',
    )
    .digest('hex');
}

export function createFactEnvelope(items: FactItem[], capturedAt: string = new Date().toISOString()): FactEnvelope {
  return {
    facts_version: 1,
    captured_at: capturedAt,
    items,
    facts_hash: computeFactsHash({ facts_version: 1, captured_at: capturedAt, items }),
  };
}

export function findFact(envelope: FactEnvelope, key: string): FactItem | undefined {
  return envelope.items.find((item) => item.key === key);
}

export function factsForJudge(envelope: FactEnvelope): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const item of envelope.items) {
    map[item.key] = item.value;
  }
  return map;
}
