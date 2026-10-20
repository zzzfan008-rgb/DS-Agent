/**
 * M3 前端契约类型（以 t7/t8/t9 实际 API 返回为准；docs/13b §7 登记缺口）。
 * 金额一律整数分；时间 ISO8601；字段 snake_case。
 */

export type Platform = 'pdd' | '1688';
export type ProductStatus = 'draft' | 'active' | 'inactive' | 'archived';
export type Fit = 'slim' | 'regular' | 'loose' | 'oversize';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter' | 'all';
export type ContentType = 'title' | 'selling_points' | 'detail' | 'faq' | 'reply' | 'quote';
export type Tone = '专业' | '亲和' | '简洁' | '促销' | '批发';
export type Verdict = 'pass' | 'needs_revision' | 'reject' | 'escalate';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'blocker';

/* ------------------------------------------------------------------ */
/* 商品                                                                 */
/* ------------------------------------------------------------------ */

export interface PlatformState {
  status?: string | null;
  platform_state?: string | null;
  last_write_at?: string | null;
}

export interface ProductListItem {
  id: string;
  spu_code: string;
  name: string;
  category_code: string;
  fit: Fit | null;
  color_count: number;
  sku_count: number;
  status: ProductStatus;
  size_chart_version: number;
  updated_at: string;
  /** t28 后端聚合字段；当前可能缺省。 */
  platform_states?: Partial<Record<Platform, PlatformState | null>> | null;
  missing_fields?: string[] | null;
}

export interface ProductListData {
  items: ProductListItem[];
}

export interface ProductSku {
  id: string;
  sku_code: string;
  color_id: string;
  color_name: string;
  size_code: string;
  fabric_code: string | null;
  price_cents: number;
  list_price_cents: number | null;
  sale_price_cents: number | null;
  stock: number;
  min_order_qty: number;
}

export interface SizeChartRow {
  sku_size_code: string;
  version_no: number;
  size_order: number;
  effective_from: string;
  measurements: Record<string, number>;
  recommend_height_min: number | null;
  recommend_height_max: number | null;
  recommend_weight_min: number | null;
  recommend_weight_max: number | null;
}

export interface FabricMaterial {
  material: string;
  percent: number;
  note?: string | null;
}

export interface PlatformAttribute {
  platform: Platform | string;
  attr_path: string;
  internal_value: string;
  platform_value_id: string | null;
  status: string;
}

export interface ProductDetail {
  product: {
    id: string;
    spu_code: string;
    name: string;
    category_code: string;
    fit: Fit | null;
    description: string | null;
    status: ProductStatus;
    fact_version: number;
  };
  skus: ProductSku[];
  size_chart: SizeChartRow[];
  fabric: FabricMaterial[];
  attributes: PlatformAttribute[];
  media_summary: { counts: Record<string, number> };
}

export interface ProductCreateSkuInput {
  color_id: string;
  color_name?: string;
  size_code: string;
  price_cents: number;
  list_price_cents?: number;
  sale_price_cents?: number;
  stock_qty?: number;
  min_order_qty?: number;
}

export interface ProductCreateInput {
  spu_code: string;
  name: string;
  category_code: string;
  fit?: Fit;
  brand?: string;
  season?: Season;
  description?: string;
  skus: ProductCreateSkuInput[];
  fabric: {
    materials: Array<{ material: string; percent: number; note?: string; fiber_code?: string }>;
    fabric_code?: string;
    fabric_name?: string;
    role?: 'main' | 'lining' | 'trim' | 'accessory';
    source?: string;
  };
  size_chart: {
    version_no?: number;
    size_system?: 'alpha' | 'numeric' | 'height_weight' | 'one_size';
    effective_from: string;
    source?: string;
    fit_note?: string;
    items: Array<{
      sku_size_code: string;
      measurements: Record<string, number>;
      recommend_height_min?: number;
      recommend_height_max?: number;
      recommend_weight_min?: number;
      recommend_weight_max?: number;
    }>;
  };
}

export interface ImportResult {
  import_id: string;
  rows_total: number;
  rows_ok: number;
  rows_failed: Array<{ row: number; field: string; reason: string }>;
  warnings: string[];
  dry_run: boolean;
}

/* ------------------------------------------------------------------ */
/* 内容与判定                                                           */
/* ------------------------------------------------------------------ */

export interface ContentDraftCreateResponse {
  draft_id: string;
  content: string;
  fact_refs: string[];
  status: string;
  judgment_pending: boolean;
  facts_hash: string;
  model_call_id: string | null;
}

export interface ContentDraftListItem {
  id: string;
  content_type: ContentType;
  product_id: string;
  platform: Platform;
  status: string;
  verdict: string | null;
  updated_at: string;
  cost_cents: number;
}

export interface ContentDraftListData {
  items: ContentDraftListItem[];
}

export interface ContentDraftDetail {
  id: string;
  content_type: ContentType;
  content: string;
  title: string | null;
  platform: Platform;
  status: string;
  facts: { facts_hash?: string; items?: unknown[] } | null;
  fact_check: unknown;
  judge_id: string | null;
  risks: string[];
  judgments: Array<{
    id: string;
    status: string;
    verdict: string | null;
    severity: string | null;
    created_at: string;
  }>;
}

export interface L1Hit {
  rule_id: string;
  severity: Severity;
  field: string;
  span: [number, number];
  matched: string;
  suggestion: string;
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
}

export interface L2Result {
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

export interface JudgmentResponse {
  judgment_id: string;
  status: string;
  verdict: Verdict;
  severity: Severity;
  reason: string | null;
  repair_hint: string | null;
  evidence_refs: EvidenceRef[];
  rule_hits: L1Hit[];
  l1: L1Result;
  l2: L2Result | null;
  versions: { rule_set: string; lexicon: string; prompt: string };
  cost_cents: number;
  latency_ms: number;
  escalated: boolean;
  short_circuit?: string;
  facts_hash: string;
}

export interface ApprovalCreateResponse {
  id: string;
  status: string;
  level: 'A' | 'B' | 'C';
  target_hash: string;
  sla_due_at: string | null;
  expires_at: string;
  level_reasons: string[];
}

/* ------------------------------------------------------------------ */
/* 模型                                                                 */
/* ------------------------------------------------------------------ */

export type PriceBook = {
  text?: { input_per_1k_cents?: number; output_per_1k_cents?: number };
  image?: { per_image_cents?: number; per_megapixel_cents?: number };
  video?: { per_second_cents?: number };
  embed?: { per_1k_tokens_cents?: number };
};

export interface ProviderItem {
  id: string;
  kind: 'text' | 'image' | 'video' | 'embedding';
  name: string;
  base_url: string | null;
  credential_ref_masked: string;
  region: string | null;
  status: 'configuring' | 'active' | 'degraded' | 'disabled';
  version: number;
  connectivity: {
    ok: boolean;
    latency_ms: number | null;
    checked_at: string | null;
  };
  balance_cents: number | null;
}

export interface ModelItem {
  id: string;
  provider_id: string;
  external_model_id: string;
  display_name: string;
  capability: 'text' | 'image' | 'video' | 'embedding' | 'rerank';
  status: 'draft' | 'testing' | 'published' | 'suspended' | 'archived';
  price: PriceBook;
  price_version: number;
  rate_limit: Record<string, number | undefined>;
  published_at: string | null;
  visible: boolean;
  visible_reason?: string;
  version: number;
  notes?: string | null;
}

export interface RouteItem {
  id: string;
  scope_type: 'org' | 'role' | 'user';
  scope_role_id: string | null;
  scope_user_id: string | null;
  purpose: 'copy' | 'judge' | 'image' | 'video' | 'embed' | 'rerank';
  model_id: string;
  fallback_ids: string[];
  priority: number;
  quota: {
    rpm: number | null;
    tpm: number | null;
    concurrency: number | null;
    daily_calls: number | null;
    daily_cost_cents: number | null;
    monthly_cost_cents: number | null;
  };
  status: 'draft' | 'active' | 'paused' | 'retired';
  effective_from: string | null;
  effective_to: string | null;
  label: string | null;
  version: number;
}

export interface UsageGroup {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  images: number;
  video_seconds: number;
  cost_cents: number;
}

export interface UsageData {
  items: UsageGroup[];
  total_cents: number;
  group_by: 'model' | 'purpose' | 'day';
  from: string;
  to: string;
}

/* ------------------------------------------------------------------ */
/* 通用                                                                 */
/* ------------------------------------------------------------------ */

export interface ValidationIssue {
  code?: string;
  field?: string;
  message: string;
}

export interface ValidationDetail {
  issues?: ValidationIssue[];
  rows_failed?: Array<{ row: number; field: string; reason: string }>;
  field?: string;
  missing?: string[];
  blockers?: Array<{ model_id: string; reason: string }>;
  [key: string]: unknown;
}
