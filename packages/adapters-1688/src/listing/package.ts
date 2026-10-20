/**
 * 上架包（内部规范化包）的类型与哈希 —— 1688 侧。
 *
 * 定位：这是**平台无关的内部中间产物**，不是 1688 后台的 Excel 模板。
 * 平台模板列名未核验（`TODO-1688-010`），所以包内 `templateVerified=false`，
 * 真正的模板适配要等 `docs/02 §2.1#6` 回填后另写一个 `TemplateAdapter`。
 *
 * 用途：
 * 1. 把「商品 + 成分 + 尺码表 + SKU + 阶梯价 + 起批量 + 代发 + 映射」收敛成一个
 *    可 review、可 diff、可哈希的 JSON；
 * 2. 作为写入门 dry-run 的输入（`POST /listings/publish mode=dry_run`）；
 * 3. 作为契约录制回放与黄金集的稳定基线。
 */

import { canonicalJson, sha256Hex } from '../json.js';
import type { AttributeMappingRow } from '../mapping/attributes.js';
import type { CareInstructions } from '../domain/care.js';
import type { DropshipTerms } from '../domain/dropship.js';
import type { Moq } from '../domain/moq.js';
import type { MaterialRow } from '../domain/fabric.js';
import type { PriceRange, PriceTier } from '../domain/price-tiers.js';
import type { SizeChartRow } from '../domain/size-chart.js';
import type { SpecAxis, SpecMatrixCell } from '../domain/spec.js';
import type { QualificationStatus } from '../domain/qualification.js';
import type { TodoId } from '../todo.js';
import type { ValidationIssue } from '../validation.js';

export const LISTING_PACKAGE_SCHEMA_VERSION = '1688-listing-package/v0' as const;

export interface MediaRef {
  assetId: string;
  kind: 'main' | 'gallery' | 'size_chart' | 'video';
  /** 只允许受控 URL（MinIO 预签名/内网），导出包默认不带外链。 */
  url?: string | null;
}

export interface ListingSkuInput {
  skuCode: unknown;
  colorId: unknown;
  colorName: unknown;
  sizeCode: unknown;
  sizeOrder?: unknown;
  priceCents: unknown;
  listPriceCents?: unknown;
  salePriceCents?: unknown;
  costCents?: unknown;
  priceTiers: unknown;
  minOrderQty?: unknown;
  leadTimeDays?: unknown;
  stockQty?: unknown;
  weightG?: unknown;
  status?: unknown;
}

export interface ListingPackageInput {
  product: {
    id?: string | null;
    spuCode: string;
    name: string;
    brand?: string | null;
    season?: string | null;
    fit?: string | null;
    categoryCode: string;
    attributes?: Record<string, string | number | boolean>;
    qualification: unknown;
    careInstructions: unknown;
    mainAssetId?: string | null;
    media?: MediaRef[];
  };
  fabric: {
    fabricCode: string;
    fabricName: string;
    role: 'main' | 'lining' | 'accessory' | 'decoration';
    materials: unknown;
  };
  sizeChart: {
    versionNo: number;
    sizeSystem: 'alpha' | 'numeric' | 'one_size';
    rows: unknown;
  };
  skus: unknown[];
  moq?: unknown;
  dropship?: unknown;
  platformCategory: {
    id: string | null;
    externalCategoryId?: string | null;
    name?: string | null;
    isLeaf: boolean;
    requiredAttrs?: Array<{ attrPath: string; required: boolean }>;
    qualificationRequirementsKnown?: boolean;
  };
  /** 已核验的映射索引（可选；缺省全部为 draft）。 */
  verifiedMappings?: Array<{
    key: string;
    platformValueId: string | null;
    platformValueName: string | null;
    status: 'draft' | 'verified' | 'stale';
  }>;
}

export interface ListingPackageSku {
  skuCode: string;
  colorId: string;
  colorName: string;
  sizeCode: string;
  sizeOrder: number;
  status: 'active' | 'inactive';
  priceCents: number;
  listPriceCents: number | null;
  salePriceCents: number | null;
  priceTiers: PriceTier[];
  priceRange: PriceRange;
  minOrderQty: number;
  leadTimeDays: number | null;
  stockQty: number | null;
  weightG: number | null;
}

export interface ListingPackageDraft {
  meta: {
    schemaVersion: typeof LISTING_PACKAGE_SCHEMA_VERSION;
    platform: '1688';
    generatedAt: string;
    /** 契约是否已核验；本字段为 false 时任何真实写都必须拒绝。 */
    contractVerified: false;
    /** 平台导入模板是否已核验（TODO-1688-010）。 */
    templateVerified: false;
    openTodoIds: TodoId[];
    publishable: boolean;
  };
  product: {
    productId: string | null;
    spuCode: string;
    name: string;
    brand: string | null;
    season: string | null;
    fit: string | null;
    categoryCode: string;
    attributes: Record<string, string | number | boolean>;
    mainAssetId: string | null;
  };
  fabric: {
    fabricCode: string;
    fabricName: string;
    role: string;
    materials: MaterialRow[];
    materialsText: string;
  };
  sizeChart: {
    versionNo: number;
    sizeSystem: 'alpha' | 'numeric' | 'one_size';
    unit: 'cm';
    rows: SizeChartRow[];
  };
  spec: {
    axes: SpecAxis[];
    matrix: SpecMatrixCell[];
    combinationCount: number;
    presentCount: number;
  };
  skus: ListingPackageSku[];
  moq: Moq | null;
  dropship: (DropshipTerms & { persisted: boolean }) | null;
  attributes: AttributeMappingRow[];
  qualification: {
    status: QualificationStatus;
    nextExpiry: string | null;
    daysToExpiry: number | null;
    requirementsKnown: boolean;
  };
  care: (CareInstructions & { lines: string[] }) | null;
  media: {
    mainAssetId: string | null;
    assets: MediaRef[];
    sizeChartAssetId: string | null;
  };
  platformCategory: {
    id: string | null;
    externalCategoryId: string | null;
    name: string | null;
    isLeaf: boolean;
    requiredAttrs: Array<{ attrPath: string; required: boolean }>;
  };
  checks: {
    blockers: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  /** 规范化哈希（不含 generatedAt / hash 自身）。 */
  packageHash: string;
}

/** 稳定 JSON 的再导出（上架包与客户端共用 `src/json.ts` 的实现）。 */
export { canonicalJson };

/** 上架包哈希：sha256(canonicalJson(除 meta.generatedAt / packageHash 外的全部字段))。 */
export function hashListingPackage(draft: Omit<ListingPackageDraft, 'packageHash'>): string {
  const { meta, ...rest } = draft;
  const payload = { ...rest, meta: { ...meta, generatedAt: null } };
  return sha256Hex(canonicalJson(payload));
}

/** 便于人读的一行摘要（日志/验收文档）。 */
export function describeListingPackage(draft: ListingPackageDraft): string {
  const active = draft.skus.filter((sku) => sku.status === 'active').length;
  return [
    `${draft.meta.platform}:${draft.product.spuCode}`,
    `${active} 个 active SKU`,
    `${draft.spec.combinationCount} 个组合（实存 ${draft.spec.presentCount}）`,
    `资质=${draft.qualification.status}`,
    `阻断=${draft.checks.blockers.length}`,
    `publishable=${draft.meta.publishable}`,
  ].join(' · ');
}
