/** L2 判决的 JSON Schema、宽松解析与后置校验（docs/08 §7/§8）。 */
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { EvidenceRef, L2Output, L2Validation } from './types.js';
import { createFactEnvelope } from '@dssaas/core';

interface AjvLike {
  compile(schema: unknown): ValidateFunction;
  errors: ErrorObject[] | null;
}
const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (options?: Record<string, unknown>) => AjvLike;
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

export const JUDGMENT_V1 = {
  $id: 'https://dssaas.local/schema/judgment/v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'severity', 'reason', 'evidence_refs', 'repair_hint'],
  properties: {
    verdict: { enum: ['pass', 'needs_revision', 'reject', 'escalate'] },
    severity: { enum: ['info', 'low', 'medium', 'high', 'blocker'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    repair_hint: { type: 'string', minLength: 1, maxLength: 500 },
    evidence_refs: {
      type: 'array',
      maxItems: 8,
      items: { $ref: '#/$defs/evidence' },
    },
    claims: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'topic', 'supported'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 120 },
          topic: {
            enum: [
              'price', 'stock', 'composition', 'size', 'policy',
              'qualification', 'claim', 'platform_rule',
            ],
          },
          supported: { type: 'boolean' },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    checked_rule_ids: {
      type: 'array',
      maxItems: 60,
      items: { type: 'string', pattern: '^L1-[A-Z]{2,4}-[0-9]{3}$' },
    },
    policy_topics: {
      type: 'array',
      maxItems: 8,
      items: {
        enum: [
          'price', 'stock', 'composition', 'size', 'policy',
          'qualification', 'claim', 'platform_rule',
        ],
      },
    },
  },
  $defs: {
    evidence: {
      type: 'object',
      additionalProperties: false,
      required: ['doc_id', 'chunk_id', 'doc_version', 'quote'],
      properties: {
        doc_id: { type: 'string', minLength: 36, maxLength: 36 },
        chunk_id: { type: 'string', minLength: 1, maxLength: 128 },
        doc_version: { type: 'integer', minimum: 1 },
        quote: { type: 'string', minLength: 4, maxLength: 200 },
        effective_from: { type: ['string', 'null'] },
        source: { enum: ['fact', 'kb'] },
      },
    },
  },
} as const;

const validateSchema = ajv.compile(JUDGMENT_V1);

export function parseJsonLoose(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function compact(value: string): string {
  return value.replace(/\s/g, '');
}

export function validateL2Output(
  raw: string | unknown,
  evidence: EvidenceRef[],
  options: { requireCitation?: boolean } = {},
): L2Validation {
  const parsed = typeof raw === 'string' ? parseJsonLoose(raw) : raw;
  if (!parsed || !validateSchema(parsed)) {
    return { ok: false, reason: 'schema_invalid' };
  }
  const output = parsed as L2Output;

  if (output.verdict === 'pass' && !['info', 'low'].includes(output.severity)) {
    return { ok: false, reason: 'schema_invalid' };
  }
  if (typeof output.confidence === 'number' && output.confidence < 0.6) {
    return { ok: false, reason: 'low_confidence' };
  }

  const byChunk = new Map(evidence.map((item) => [item.chunk_id, item]));
  const validRefs: EvidenceRef[] = [];
  let quoteDrop = false;
  for (const ref of output.evidence_refs) {
    const source = byChunk.get(ref.chunk_id);
    if (!source || source.doc_id !== ref.doc_id || source.doc_version !== ref.doc_version) {
      continue;
    }
    if (!compact(source.quote).includes(compact(ref.quote))) {
      quoteDrop = true;
      continue;
    }
    validRefs.push(ref);
  }
  if (output.evidence_refs.length > 0 && validRefs.length === 0) {
    return { ok: false, reason: quoteDrop ? 'quote_mismatch' : 'unresolvable_evidence' };
  }
  if ((output.verdict === 'reject' || output.verdict === 'needs_revision') && validRefs.length === 0) {
    return { ok: false, reason: 'missing_evidence' };
  }
  if (options.requireCitation && validRefs.length === 0) {
    return { ok: false, reason: 'missing_evidence' };
  }
  return { ok: true, output: { ...output, evidence_refs: validRefs } };
}

export function escalateOutput(reason: string): L2Output {
  return {
    verdict: 'escalate',
    severity: 'high',
    reason: `L2 升级：${reason}`,
    repair_hint: '转 L3 人工复核',
    evidence_refs: [],
  };
}

/** 生成 FactEnvelope 的轻量校验辅助（供测试构造合法 facts）。 */
export function makeFacts(items: Parameters<typeof createFactEnvelope>[0], capturedAt?: string) {
  return createFactEnvelope(items, capturedAt);
}
