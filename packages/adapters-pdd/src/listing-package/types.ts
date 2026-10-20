/**
 * 上架包（CSV/Excel）类型定义。
 *
 * 定位：接口未获批/字段不支持时的**兜底路径**（docs/00 §8.1、ADR-0006），
 * 不是平台官方模板的复刻。平台后台导入模板的列名与必填列在 docs/01 §2.1
 * 仍为「待填」，因此本包使用 `pdd-backend-import-unverified-v0` 配置：
 * - 列名是内部规范列（不是平台契约）；
 * - manifest 显式 `verified:false` 与 TODO；
 * - 生成后必须人工在后台导入，并回填批次号、成功/失败条数、驳回原因与包哈希。
 */

export type ListingIssueSeverity = 'error' | 'warning';

export interface ListingPackageIssue {
  code: string;
  severity: ListingIssueSeverity;
  field: string;
  row?: number;
  message: string;
}

export interface ListingSkuInput {
  sku_id?: string;
  sku_code?: string;
  color_id: string;
  color_name?: string;
  size_code: string;
  fabric_id?: string;
  price_cents: number;
  list_price_cents?: number | null;
  sale_price_cents?: number | null;
  stock_qty: number;
}

export interface ListingSizeChartRowInput {
  sku_size_code: string;
  size_order?: number;
  measurements: Record<string, number>;
  recommend_height_min?: number;
  recommend_height_max?: number;
  recommend_weight_min?: number;
  recommend_weight_max?: number;
}

export interface ListingFabricItemInput {
  material: string;
  percent: number;
  note?: string;
  fiber_code?: string;
}

export interface ListingAttributeInput {
  attr_path: string;
  internal_value: string;
  platform_value_id?: string | null;
  extra?: Record<string, unknown>;
}

export interface ListingProductInput {
  product_id?: string;
  spu_code: string;
  name: string;
  category_code: string;
  fit?: string;
  description?: string;
  skus: ListingSkuInput[];
  size_chart: ListingSizeChartRowInput[];
  fabric: ListingFabricItemInput[];
  attributes?: ListingAttributeInput[];
  media?: { main?: string; gallery?: string[] };
  qualification?: {
    report_no?: string;
    safety_class?: string;
    brand?: string;
    manufacturer?: string;
  };
  /** `synthetic_sample` 用于仓库样例，避免被误当真实商品数据。 */
  data_origin?: 'synthetic_sample' | 'master_data' | 'platform_sync';
}

export interface NormalizedSku {
  sku_id: string;
  sku_code: string;
  color_id: string;
  color_name: string;
  size_code: string;
  size_order: number;
  fabric_id: string | null;
  price_cents: number;
  list_price_cents: number | null;
  sale_price_cents: number | null;
  stock_qty: number;
}

export interface NormalizedSizeRow {
  sku_size_code: string;
  size_order: number;
  measurements: Record<string, number>;
  recommend_height_min: number | null;
  recommend_height_max: number | null;
  recommend_weight_min: number | null;
  recommend_weight_max: number | null;
}

export interface NormalizedFabricItem {
  material: string;
  percent: number;
  note: string | null;
  fiber_code: string | null;
}

export interface NormalizedAttribute {
  attr_path: string;
  internal_value: string;
  platform_value_id: string | null;
}

export interface NormalizedListingProduct {
  product_id: string;
  spu_code: string;
  name: string;
  category_code: string;
  fit: string | null;
  description: string | null;
  skus: NormalizedSku[];
  size_chart: NormalizedSizeRow[];
  fabric: NormalizedFabricItem[];
  attributes: NormalizedAttribute[];
  media: { main: string | null; gallery: string[] };
  qualification: {
    report_no: string | null;
    safety_class: string | null;
    brand: string | null;
    manufacturer: string | null;
  };
  data_origin: string;
}

export interface TableRow {
  [column: string]: string | number | null;
}

export interface PackageTable {
  name: string;
  columns: string[];
  rows: TableRow[];
}

export interface ListingPackageProfile {
  id: string;
  version: string;
  verified: false;
  source_todo: string;
  notes: string[];
}

export interface ListingPackageFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ListingPackageManifest {
  schema_version: 'pdd-listing-package-v1';
  template_profile: ListingPackageProfile;
  generated_at: string;
  generator: { name: string; version: string };
  /** 兜底路径恒为 dry-run：不触达平台，只产出包。 */
  dry_run: true;
  data_origin: string;
  payload_hash: string;
  row_counts: {
    product: number;
    sku: number;
    size_chart: number;
    fabric: number;
    attributes: number;
  };
  files: ListingPackageFile[];
  warnings: ListingPackageIssue[];
  import_checklist: string[];
}

export interface ListingPackageResult {
  out_dir: string;
  manifest: ListingPackageManifest;
  tables: PackageTable[];
  issues: ListingPackageIssue[];
}
