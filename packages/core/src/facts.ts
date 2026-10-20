/** 事实信封（docs/06 §6.5）：canonical JSON + sha256 facts_hash，事实单一化的哈希锚点。 */
import { createHash } from 'node:crypto';

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

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

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
