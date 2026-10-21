/** 判断层公共类型（docs/08 §2/§3/§7）。 */

export type Platform = 'pdd' | '1688';
export const JUDGE_CONTENT_TYPES = [
  'title', 'selling_points', 'detail', 'faq', 'reply', 'quote',
] as const;
export type JudgeContentType = (typeof JUDGE_CONTENT_TYPES)[number];

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'blocker';
export type Verdict = 'pass' | 'needs_revision' | 'reject' | 'escalate';
export type JudgmentStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'needs_revision'
  | 'rejected'
  | 'escalated'
  | 'failed'
  | 'superseded';

export interface L1Hit {
  rule_id: string;
  severity: Severity;
  field: 'text';
  span: [number, number];
  matched: string;
  suggestion: string;
  /**
   * 命中词处于否定语境（如「不能承诺当天发货」）时为 true：
   * severity 已降级为 info，不计入 blocker；保留命中记录便于误报复核（docs/08 §5.3）。
   */
  negated?: boolean;
  /** 触发降级的否定标记原文（如「不能」「无法保证」），仅 negated=true 时存在。 */
  negation_marker?: string;
}

export interface L1Result {
  rule_set_version: string;
  lexicon_version: string;
  evaluated: number;
  skipped: string[];
  hits: L1Hit[];
  errors: Array<{ rule_id: string; message: string }>;
  duration_ms: number;
  blocked: boolean;
}

export interface EvidenceRef {
  doc_id: string;
  chunk_id: string;
  doc_version: number;
  quote: string;
  effective_from?: string | null;
  /** fact=主数据硬证据；kb=知识库软证据（政策/规则/FAQ）。 */
  source?: 'fact' | 'kb';
}

export interface L2Output {
  verdict: Verdict;
  severity: Severity;
  reason: string;
  repair_hint: string;
  evidence_refs: EvidenceRef[];
  claims?: Array<{ text: string; topic: string; supported: boolean }>;
  confidence?: number;
  checked_rule_ids?: string[];
  policy_topics?: string[];
}

export interface L2ValidationOk {
  ok: true;
  output: L2Output;
}

export interface L2ValidationFail {
  ok: false;
  reason:
    | 'schema_invalid'
    | 'missing_evidence'
    | 'unresolvable_evidence'
    | 'quote_mismatch'
    | 'low_confidence';
}

export type L2Validation = L2ValidationOk | L2ValidationFail;

export interface JudgeFacts {
  price_cents?: number;
  promo_price_cents?: number;
  min_price_cents?: number;
  price_tiers?: Array<{ min_qty: number; price_cents: number }>;
  stock?: number;
  composition?: Array<{ material: string; percent: number }>;
  measurements?: Record<string, number>;
  size_ranges?: Array<{
    size_code: string;
    height_min?: number;
    height_max?: number;
    weight_min?: number;
    weight_max?: number;
  }>;
  size_codes?: string[];
  sku_size_codes?: string[];
  policy_refs?: string[];
  lead_time_days?: number;
  category_code?: string;
}

export interface JudgeInput {
  platform: Platform;
  content_type: JudgeContentType;
  text: string;
  facts: JudgeFacts;
  as_of?: string;
}

export interface MergedVerdict {
  verdict: Verdict;
  severity: Severity;
  reason: string;
  repair_hint: string;
  evidence_refs: EvidenceRef[];
  short_circuit?: 'L1_BLOCKER' | 'NO_EVIDENCE' | 'L2_SKIPPED';
}

/** 规则集版本：行为变更必须升版本并重跑回归（docs/08 §12.1）。1.1.0 = 否定语境判定（t42）。 */
export const RULE_SET_VERSION = 'rules@1.1.0';
export const LEXICON_VERSION = 'lexicon@1.0.0';
export const JUDGE_PROMPT_VERSION = 'judge@1.0.0';

export function severityRank(severity: Severity): number {
  return { info: 0, low: 1, medium: 2, high: 3, blocker: 4 }[severity];
}

export function maxSeverity(...severities: Array<Severity | undefined>): Severity {
  let best: Severity = 'info';
  for (const severity of severities) {
    if (!severity) continue;
    if (severityRank(severity) > severityRank(best)) best = severity;
  }
  return best;
}
