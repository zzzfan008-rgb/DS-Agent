/**
 * 样例数据 —— 只用于测试与 `scripts/generate-sample.ts` 生成上架包样例。
 *
 * 数据是**合成的**（不是客户真实商品），但字段严格按 docs/06 / docs/19 的结构：
 * 女式衬衫 A0202、2 色 × 3 码、3 档阶梯价、起批量 2、支持代发。
 */

import type { ListingPackageInput } from '../src/listing/package.js';

export const SAMPLE_PRODUCT_ID = '0192f0a0-0000-7000-8000-000000000001';
export const SAMPLE_CATEGORY_ID = '0192f0a0-0000-7000-8000-0000000000c1';
export const SAMPLE_MAIN_ASSET_ID = '0192f0a0-0000-7000-8000-0000000000a1';
export const SAMPLE_CHART_ASSET_ID = '0192f0a0-0000-7000-8000-0000000000a2';
export const SAMPLE_QUALIFICATION_ASSET_ID = '0192f0a0-0000-7000-8000-0000000000a3';

const TIERS = [
  { minQty: 2, maxQty: 49, priceCents: 15800 },
  { minQty: 50, maxQty: 199, priceCents: 14200 },
  { minQty: 200, maxQty: null, priceCents: 12800 },
];

const SKU_ROWS = [
  { code: 'WH-0001', name: '本白', skuPrefix: 'WHT' },
  { code: 'BL-0102', name: '牛仔蓝', skuPrefix: 'BLU' },
];

const SIZE_ROWS = [
  { code: 'S', suffix: 'S' },
  { code: 'M', suffix: 'M' },
  { code: 'L', suffix: 'L' },
];

export function sampleSkus() {
  return SKU_ROWS.flatMap((color) =>
    SIZE_ROWS.map((size) => ({
      skuCode: `SHIRT-W-${color.skuPrefix}-${size.suffix}`,
      colorId: color.code,
      colorName: color.name,
      sizeCode: size.code,
      priceCents: 15800,
      listPriceCents: 19800,
      salePriceCents: null,
      priceTiers: TIERS,
      minOrderQty: 2,
      leadTimeDays: 3,
      stockQty: 480,
      weightG: 320,
      status: 'active' as const,
    })),
  );
}

export const sampleListingInput: ListingPackageInput = {
  product: {
    id: SAMPLE_PRODUCT_ID,
    spuCode: 'SHIRT-W-2026-001',
    name: '女式纯棉翻领长袖衬衫',
    brand: 'DSSTUDIO',
    season: 'all',
    fit: 'regular',
    categoryCode: 'A0202',
    attributes: { 领型: '翻领', 袖长: '长袖', 厚薄: '常规' },
    qualification: {
      safetyCategory: 'B',
      executionStandard: 'GB/T 22849',
      fiberLabel: 'GB/T 29862',
      reports: [
        {
          type: '质检报告',
          reportNo: 'QT-2026-0001',
          issuer: '示例检测中心',
          issuedAt: '2026-01-10',
          validUntil: '2027-01-09',
          assetIds: [SAMPLE_QUALIFICATION_ASSET_ID],
          status: 'approved',
        },
      ],
      checkedAt: '2026-10-01',
      checkedBy: '0192f0a0-0000-7000-8000-0000000000f1',
    },
    careInstructions: {
      wash: { code: 'W40' },
      bleach: { code: 'BNONE' },
      dry: { code: 'DHANG' },
      iron: { code: 'I150' },
      dryClean: { code: 'DCP' },
      note: '深浅色分开洗涤',
      source: 'supplier',
    },
    mainAssetId: SAMPLE_MAIN_ASSET_ID,
    media: [
      { assetId: SAMPLE_MAIN_ASSET_ID, kind: 'main' },
      { assetId: '0192f0a0-0000-7000-8000-0000000000a4', kind: 'gallery' },
      { assetId: SAMPLE_CHART_ASSET_ID, kind: 'size_chart' },
    ],
  },
  fabric: {
    fabricCode: 'MAIN-01',
    fabricName: '主面料',
    role: 'main',
    materials: [
      { material: '棉', percent: 62, note: '主料' },
      { material: '聚酯纤维', percent: 33, note: '主料' },
      { material: '氨纶', percent: 5, note: '主料' },
    ],
  },
  sizeChart: {
    versionNo: 3,
    sizeSystem: 'alpha',
    rows: [
      {
        skuSizeCode: 'S',
        measurements: { 衣长: 67, 胸围: 100, 肩宽: 45, 袖长: 59, 领围: 39 },
        recommendHeightMin: 158,
        recommendHeightMax: 165,
        recommendWeightMin: 48,
        recommendWeightMax: 55,
      },
      {
        skuSizeCode: 'M',
        measurements: { 衣长: 69, 胸围: 104, 肩宽: 46, 袖长: 60, 领围: 40 },
        recommendHeightMin: 165,
        recommendHeightMax: 172,
        recommendWeightMin: 55,
        recommendWeightMax: 63,
      },
      {
        skuSizeCode: 'L',
        measurements: { 衣长: 71, 胸围: 108, 肩宽: 47.5, 袖长: 61, 领围: 41 },
        recommendHeightMin: 172,
        recommendHeightMax: 179,
        recommendWeightMin: 63,
        recommendWeightMax: 72,
      },
    ],
  },
  skus: sampleSkus(),
  moq: { minOrderQty: 2, stepQty: 1, unit: 'piece', mixBatchAllowed: true, maxOrderQty: null },
  dropship: {
    enabled: true,
    dropshipPriceCents: 16800,
    leadTimeDays: 2,
    returnAddressRef: 'addr:dropship-hz-01',
    stockSource: 'supplier',
    minOrderQty: 1,
  },
  platformCategory: {
    id: SAMPLE_CATEGORY_ID,
    externalCategoryId: null,
    name: '女士衬衫（示例类目）',
    isLeaf: true,
    requiredAttrs: [
      { attrPath: 'color', required: true },
      { attrPath: 'size', required: true },
      { attrPath: 'min_order_qty', required: true },
    ],
    qualificationRequirementsKnown: true,
  },
  // 全部映射未核验：不给 verifiedMappings，导出包必须因此被阻断。
  verifiedMappings: [],
};
