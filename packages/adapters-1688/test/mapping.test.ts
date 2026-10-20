/**
 * 平台属性映射单测 —— docs/19 §9/§11、docs/06 §4.2.6。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecAxes } from '../src/domain/spec.js';
import {
  DEFAULT_ATTR_PATHS,
  MAPPING_CSV_HEADERS,
  buildAttributeMappings,
  renderMappingCsv,
  type VerifiedMappingIndex,
} from '../src/mapping/attributes.js';

const SPECS = buildSpecAxes([
  { skuCode: 'SHIRT-W-WHT-S', colorId: 'WH-0001', colorName: '本白', sizeCode: 'S', minOrderQty: 2 },
  { skuCode: 'SHIRT-W-WHT-M', colorId: 'WH-0001', colorName: '本白', sizeCode: 'M', minOrderQty: 2 },
  { skuCode: 'SHIRT-W-BLU-S', colorId: 'BL-0102', colorName: '牛仔蓝', sizeCode: 'S', minOrderQty: 3 },
  { skuCode: 'SHIRT-W-BLU-M', colorId: 'BL-0102', colorName: '牛仔蓝', sizeCode: 'M', minOrderQty: 3 },
]);

function build(verified?: VerifiedMappingIndex) {
  return buildAttributeMappings({
    platformCategoryId: '0192f0a0-0000-7000-8000-0000000000c1',
    productId: '0192f0a0-0000-7000-8000-000000000001',
    spuCode: 'SHIRT-W-2026-001',
    specs: SPECS,
    materialsText: '棉62%、聚酯纤维33%、氨纶5%',
    mixBatchAllowed: true,
    verified,
  });
}

test('映射行覆盖 color/size/material/min_order_qty/mix_batch/spu_code', () => {
  const result = build();
  const paths = [...new Set(result.rows.map((row) => row.attrPath))].sort();
  assert.deepEqual(paths, ['color', 'material', 'min_order_qty', 'mix_batch', 'size', 'spu_code']);
  assert.deepEqual(result.unverifiedPaths, paths);
  // 2 色 + 2 码 + 1 成分 + 4 个 SKU 起批量 + 1 混批 + 1 货号
  assert.equal(result.rows.length, 11);
});

test('平台值未核验：全部 draft、platform_value_id=null、带 TODO id', () => {
  const result = build();
  for (const row of result.rows) {
    assert.equal(row.status, 'draft');
    assert.equal(row.platformValueId, null);
    assert.equal(row.platform, '1688');
    assert.ok(row.todoIds.length > 0, `${row.attrPath} 必须有 TODO`);
  }
  assert.ok(result.issues.some((issue) => issue.code === 'PLAT-ATTR-002'));
});

test('混批与代发：无主数据列的行标记 persisted=false（TODO-1688-PERSIST-01）', () => {
  const result = build();
  const mix = result.rows.find((row) => row.attrPath === 'mix_batch');
  assert.ok(mix);
  assert.equal(mix.internalField, null);
  assert.equal(mix.persisted, false);
  assert.equal(mix.internalValue, 'true');
  assert.ok(mix.todoIds.includes('TODO-1688-PERSIST-01'));
  assert.ok(result.rows.filter((row) => row.attrPath !== 'mix_batch').every((row) => row.persisted));
});

test('已核验映射索引可把行升级为 verified，但未覆盖的路径仍是 draft', () => {
  const map = new Map([
    ['color:WH-0001', { platformValueId: '90001', platformValueName: '本白', status: 'verified' as const }],
    ['size:S', { platformValueId: '770001', platformValueName: 'S码', status: 'verified' as const }],
    ['size:M', { platformValueId: '770002', platformValueName: 'M码', status: 'verified' as const }],
  ]);
  const result = build({ get: (key) => map.get(key) });
  const wh = result.rows.find((row) => row.attrPath === 'color' && row.internalValue === 'WH-0001');
  assert.equal(wh?.status, 'verified');
  assert.equal(wh?.platformValueId, '90001');
  const blu = result.rows.find((row) => row.attrPath === 'color' && row.internalValue === 'BL-0102');
  assert.equal(blu?.status, 'draft');
  assert.ok(result.unverifiedPaths.includes('color'));
  assert.ok(!result.unverifiedPaths.includes('size'));
});

test('类目缺失：给 PLAT-ATTR-003 告警（映射必须有类目作用域）', () => {
  const result = buildAttributeMappings({
    platformCategoryId: null,
    productId: null,
    spuCode: 'SHIRT-W-2026-001',
    specs: SPECS,
    materialsText: null,
    mixBatchAllowed: false,
  });
  assert.ok(result.issues.some((issue) => issue.code === 'PLAT-ATTR-003'));
  assert.equal(result.rows.some((row) => row.attrPath === 'material'), false);
});

test('映射 CSV 表头与 docs/19 §11 完全一致，且可转义引号', () => {
  assert.deepEqual(
    [...MAPPING_CSV_HEADERS],
    [
      'platform',
      'platform_category_id',
      'attr_path',
      'attr_type',
      'internal_field',
      'internal_value',
      'platform_value_id',
      'platform_value_name',
      'extra',
      'status',
      'source',
    ],
  );
  const csv = renderMappingCsv([
    {
      platform: '1688',
      platformCategoryId: 'cat',
      productId: null,
      skuId: null,
      attrPath: 'material',
      attrType: 'text',
      internalField: 'fabric_composition.materials',
      internalValue: '棉62%、聚酯纤维33%、氨纶5%',
      platformValueId: null,
      platformValueName: '棉62%、"精梳"',
      extra: { display_divisor: 1 },
      status: 'draft',
      source: 'manual',
      todoIds: ['TODO-1688-009'],
      persisted: true,
    },
  ]);
  assert.ok(csv.startsWith('\uFEFFplatform,platform_category_id'));
  assert.ok(csv.includes('"棉62%、""精梳"""'), csv);
  assert.equal(csv.split('\r\n').filter(Boolean).length, 2);
});

test('属性路径都是 docs/19 §9 的提示值（可被字典快照覆盖）', () => {
  assert.equal(DEFAULT_ATTR_PATHS.minOrderQty, 'min_order_qty');
  assert.equal(DEFAULT_ATTR_PATHS.mixBatch, 'mix_batch');
});
