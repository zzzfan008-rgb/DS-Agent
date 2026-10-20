/**
 * 上架包导出器单测 —— docs/19 三级校验门禁 + docs/02 H1/H2。
 *
 * 断言重点：
 * 1. 契约未核验 → `publishable=false` 且 `CONTRACT_UNVERIFIED` 必须出现在阻断项里；
 * 2. 映射未核验 → `PLAT-ATTR-002` 阻断（docs/19 L2）；
 * 3. 哈希确定：同输入同 generatedAt → 同 packageHash；
 * 4. JSON/CSV 可导出，CSV 是内部规范列且带 BOM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildListingPackage,
  renderListingPackageCsv,
  renderListingPackageJson,
} from '../src/listing/exporter.js';
import type { ListingPackageInput } from '../src/listing/package.js';
import { sampleListingInput, sampleSkus } from './sample-data.js';

const GENERATED_AT = '2026-10-21T02:00:00.000Z';

function cloneInput(mutate?: (input: ListingPackageInput) => void): ListingPackageInput {
  const input = structuredClone(sampleListingInput);
  mutate?.(input);
  return input;
}

const blockCodes = (blockers: { code: string }[]): string[] => blockers.map((issue) => issue.code);

test('样例包：结构完整、资质 valid、6 个 SKU、3 档阶梯价', () => {
  const draft = buildListingPackage(cloneInput(), { generatedAt: GENERATED_AT });
  assert.equal(draft.meta.platform, '1688');
  assert.equal(draft.meta.schemaVersion, '1688-listing-package/v0');
  assert.equal(draft.qualification.status, 'valid');
  assert.equal(draft.skus.length, 6);
  assert.equal(draft.spec.combinationCount, 6);
  assert.equal(draft.spec.presentCount, 6);
  assert.equal(draft.skus[0]?.priceTiers.length, 3);
  assert.equal(draft.skus[0]?.priceRange.display, '¥128.00–¥158.00');
  assert.equal(draft.fabric.materialsText, '棉62%、聚酯纤维33%、氨纶5%');
  assert.equal(draft.care?.wash.text, '40℃ 常规机洗');
  assert.equal(draft.dropship?.persisted, false);
});

test('签名/契约未核验：publishable=false 且阻断项含 CONTRACT_UNVERIFIED', () => {
  const draft = buildListingPackage(cloneInput(), { generatedAt: GENERATED_AT });
  assert.equal(draft.meta.publishable, false);
  assert.equal(draft.meta.contractVerified, false);
  assert.equal(draft.meta.templateVerified, false);
  const codes = blockCodes(draft.checks.blockers);
  assert.ok(codes.includes('CONTRACT_UNVERIFIED'), codes.join(','));
  assert.ok(codes.includes('PLAT-ATTR-002'), codes.join(','));
  assert.ok(draft.meta.openTodoIds.includes('TODO-1688-001'));
  assert.ok(
    draft.checks.warnings.some((issue) => issue.code === 'IMPORT_TEMPLATE_UNVERIFIED'),
    '必须提示导出 CSV 不是平台模板',
  );
});

test('哈希确定性与变更敏感：同输入同时间同哈希；改价后哈希变化', () => {
  const first = buildListingPackage(cloneInput(), { generatedAt: GENERATED_AT });
  const second = buildListingPackage(cloneInput(), { generatedAt: GENERATED_AT });
  assert.equal(first.packageHash, second.packageHash);
  assert.match(first.packageHash, /^[0-9a-f]{64}$/);

  const changed = buildListingPackage(
    cloneInput((input) => {
      input.skus = sampleSkus().map((sku, index) => (index === 0 ? { ...sku, priceCents: 15900 } : sku));
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.notEqual(first.packageHash, changed.packageHash);
});

test('资质要求未核验（H1）：qualification=unknown 且阻断', () => {
  const draft = buildListingPackage(
    cloneInput((input) => {
      input.platformCategory.qualificationRequirementsKnown = false;
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.equal(draft.qualification.status, 'unknown');
  assert.ok(blockCodes(draft.checks.blockers).includes('QUALIFICATION_UNKNOWN'));
  assert.ok(blockCodes(draft.checks.blockers).includes('PACKAGE_QUALIFICATION'));
});

test('尺码表缺 SKU 码集：SIZE_CHART_COVERAGE 阻断', () => {
  const draft = buildListingPackage(
    cloneInput((input) => {
      const chart = input.sizeChart.rows as Array<{ skuSizeCode: string }>;
      input.sizeChart.rows = chart.filter((row) => row.skuSizeCode !== 'L');
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.ok(blockCodes(draft.checks.blockers).includes('SIZE_CHART_COVERAGE'));
});

test('促销价高于售价：PACKAGE_SALE_PRICE 阻断', () => {
  const draft = buildListingPackage(
    cloneInput((input) => {
      const skus = sampleSkus();
      input.skus = skus.map((sku, index) => (index === 0 ? { ...sku, salePriceCents: 19900 } : sku));
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.ok(blockCodes(draft.checks.blockers).includes('PACKAGE_SALE_PRICE'));
});

test('起批量与阶梯价首档不一致：PRICE_TIER_FIRST_MOQ 阻断（逐 SKU 校验）', () => {
  const draft = buildListingPackage(
    cloneInput((input) => {
      const skus = sampleSkus();
      input.skus = skus.map((sku, index) =>
        index === 0
          ? { ...sku, minOrderQty: 3, priceTiers: [{ minQty: 2, maxQty: 49, priceCents: 15800 }, { minQty: 50, maxQty: null, priceCents: 14200 }] }
          : sku,
      );
    }),
    { generatedAt: GENERATED_AT },
  );
  const codes = draft.checks.blockers.map((issue) => issue.code);
  assert.ok(codes.includes('PRICE_TIER_FIRST_MOQ'), codes.join(','));
});

test('类目非叶子 / 缺主图 / 无 active SKU：均阻断', () => {
  const notLeaf = buildListingPackage(
    cloneInput((input) => {
      input.platformCategory.isLeaf = false;
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.ok(blockCodes(notLeaf.checks.blockers).includes('PACKAGE_CATEGORY_NOT_LEAF'));

  const noMain = buildListingPackage(
    cloneInput((input) => {
      input.product.mainAssetId = null;
      input.product.media = [];
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.ok(blockCodes(noMain.checks.blockers).includes('PACKAGE_MEDIA_MAIN'));

  const inactive = buildListingPackage(
    cloneInput((input) => {
      input.skus = sampleSkus().map((sku) => ({ ...sku, status: 'inactive' }));
    }),
    { generatedAt: GENERATED_AT },
  );
  assert.ok(blockCodes(inactive.checks.blockers).includes('PACKAGE_NO_ACTIVE_SKU'));
});

test('JSON 导出可解析；CSV 导出 6 行 + 表头 + BOM，阶梯价列展开', () => {
  const draft = buildListingPackage(cloneInput(), { generatedAt: GENERATED_AT });
  const json = renderListingPackageJson(draft);
  const parsed = JSON.parse(json) as typeof draft;
  assert.equal(parsed.packageHash, draft.packageHash);
  assert.ok(json.endsWith('\n'));

  const csv = renderListingPackageCsv(draft);
  assert.ok(csv.startsWith('\uFEFFspu_code,category_code'));
  const lines = csv.split('\r\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 7);
  assert.ok(lines[1]!.startsWith('SHIRT-W-2026-001,A0202,SHIRT-W-WHT-S'));
  assert.ok(lines[1]!.includes('2,15800'), '首档 min_qty/price 应展开为列');
});
