/**
 * 规格 / 尺码表 / 成分 / 洗护 / 资质 单测 —— docs/19 的 L0/L1 规则。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALPHA_SIZE_ORDER,
  buildSpecAxes,
  normalizeColorCode,
  normalizeSizeCode,
  sizeOrderFor,
} from '../src/domain/spec.js';
import {
  checkRecommendRanges,
  checkSizeChartCoverage,
  requiredMeasuresFor,
  validateSizeChart,
} from '../src/domain/size-chart.js';
import { renderMaterialsText, validateMaterials } from '../src/domain/fabric.js';
import { validateCare } from '../src/domain/care.js';
import { evaluateQualification, qualificationAllowsPublish } from '../src/domain/qualification.js';

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

// ---------------- 规格 ----------------

test('尺码别名归一：2XL→XXL、3XL→XXXL、均码/自由码/F→ONE', () => {
  assert.equal(normalizeSizeCode('2xl').code, 'XXL');
  assert.equal(normalizeSizeCode('2XL').aliased, true);
  assert.equal(normalizeSizeCode('3XL').code, 'XXXL');
  assert.equal(normalizeSizeCode('均码').code, 'ONE');
  assert.equal(normalizeSizeCode('自由码').code, 'ONE');
  assert.equal(normalizeSizeCode('F').code, 'ONE');
  assert.equal(normalizeSizeCode('加大').code, 'XL');
  assert.equal(normalizeSizeCode('M').code, 'M');
  assert.equal(normalizeSizeCode('110').code, '110');
});

test('明确拒绝的尺码写法：6XL / FREE / 均码加大', () => {
  for (const bad of ['6XL', 'FREE', '均码加大', 'XXXL 加大']) {
    assert.equal(normalizeSizeCode(bad).code, null, `${bad} 应被拒绝`);
  }
});

test('尺码排序值：字母码取 docs/19 表，数字码返回 null（必须显式给）', () => {
  assert.equal(sizeOrderFor('M'), 50);
  assert.equal(sizeOrderFor('XXXL'), ALPHA_SIZE_ORDER.XXXL);
  assert.equal(sizeOrderFor('4XL'), 95);
  assert.equal(sizeOrderFor('ONE'), 0);
  assert.equal(sizeOrderFor('110'), null);
});

test('色卡编码：带连字符合法；无连字符兼容但标记 legacy；非法拒绝', () => {
  assert.deepEqual(normalizeColorCode('bk-0101'), { code: 'BK-0101', raw: 'bk-0101', legacy: false });
  assert.deepEqual(normalizeColorCode('BK0101'), { code: 'BK-0101', raw: 'BK0101', legacy: true });
  assert.equal(normalizeColorCode('#000000').code, null);
  assert.equal(normalizeColorCode('BK-1').code, null);
});

test('规格轴与矩阵：2 色 × 2 码 = 4 组合，颜色按编码、尺码按 size_order 排序', () => {
  const result = buildSpecAxes([
    { skuCode: 'SHIRT-W-WHT-L', colorId: 'WH-0001', colorName: '本白', sizeCode: 'L' },
    { skuCode: 'SHIRT-W-WHT-S', colorId: 'WH-0001', colorName: '本白', sizeCode: 'S' },
    { skuCode: 'SHIRT-W-BLU-M', colorId: 'BL-0102', colorName: '牛仔蓝', sizeCode: 'M' },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.axes.map((axis) => [axis.axis, axis.values.map((value) => value.value)]),
    [
      ['color', ['BL-0102', 'WH-0001']],
      ['size', ['S', 'M', 'L']],
    ],
  );
  assert.equal(result.combinationCount, 6);
  assert.equal(result.presentCount, 3);
  assert.equal(result.matrix.filter((cell) => cell.skuCode === null).length, 3);
  assert.equal(result.axes[0]?.values[0]?.platformValueId, null);
  assert.equal(result.axes[0]?.values[0]?.mappingStatus, 'draft');
});

test('规格重复组合：同一颜色同一尺码两个 SKU → SPEC_DUPLICATE', () => {
  const result = buildSpecAxes([
    { skuCode: 'SHIRT-W-WHT-M-1', colorId: 'WH-0001', colorName: '本白', sizeCode: 'M' },
    { skuCode: 'SHIRT-W-WHT-M-2', colorId: 'WH-0001', colorName: '本白', sizeCode: 'M' },
  ]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('SPEC_DUPLICATE'));
});

test('数字码缺 size_order：SPEC_SIZE_ORDER（smallint 0–99 与文档数字码的冲突显式暴露）', () => {
  const result = buildSpecAxes([{ skuCode: 'PANT-W-150', colorId: 'BK-0001', colorName: '黑', sizeCode: '150' }]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('SPEC_SIZE_ORDER'));

  const withOrder = buildSpecAxes([
    { skuCode: 'PANT-W-150', colorId: 'BK-0001', colorName: '黑', sizeCode: '150', sizeOrder: 50 },
  ]);
  assert.equal(withOrder.ok, true);
  assert.equal(withOrder.skus[0]?.sizeOrder, 50);
});

test('规格：非法 SKU 编码与非法色号都报错；空 SKU 列表阻断', () => {
  const bad = buildSpecAxes([{ skuCode: 'x', colorId: 'red', colorName: '', sizeCode: 'M' }]);
  assert.ok(codes(bad.issues).includes('SPEC_SKU_CODE'));
  assert.ok(codes(bad.issues).includes('SPEC_COLOR_CODE'));
  const empty = buildSpecAxes([]);
  assert.equal(empty.ok, false);
  assert.ok(codes(empty.issues).includes('SPEC_EMPTY'));
});

// ---------------- 尺码表 ----------------

const CHART_ROWS = [
  { skuSizeCode: 'S', measurements: { 衣长: 67, 胸围: 100, 肩宽: 45, 袖长: 59, 领围: 39 }, recommendHeightMin: 158, recommendHeightMax: 165, recommendWeightMin: 48, recommendWeightMax: 55 },
  { skuSizeCode: 'M', measurements: { 衣长: 69, 胸围: 104, 肩宽: 46, 袖长: 60, 领围: 40 }, recommendHeightMin: 165, recommendHeightMax: 172, recommendWeightMin: 55, recommendWeightMax: 63 },
];

test('尺码表合法：A0202 必测胸围/衣长齐全，返回按 size_order 排序', () => {
  const result = validateSizeChart(CHART_ROWS, { categoryCode: 'A0202' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.map((row) => row.skuSizeCode), ['S', 'M']);
  assert.equal(result.value?.[0]?.measurements.胸围, 100);
});

test('品类必测部位：A0202 → 胸围/衣长；细分码继承父级', () => {
  assert.deepEqual(requiredMeasuresFor('A0202'), ['胸围', '衣长']);
  assert.deepEqual(requiredMeasuresFor('A0202.001'), ['胸围', '衣长']);
  assert.deepEqual(requiredMeasuresFor('B0211'), ['腰围', '裤长']);
  assert.deepEqual(requiredMeasuresFor('Z9999'), []);
});

test('尺码表缺必测部位：SIZE_CHART_REQUIRED_MEASURE', () => {
  const result = validateSizeChart(
    [{ skuSizeCode: 'M', measurements: { 衣长: 69 } }],
    { categoryCode: 'A0202' },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('SIZE_CHART_REQUIRED_MEASURE'));
});

test('部位名不在 12 键词表 / 0.5 步进被拒', () => {
  const badKey = validateSizeChart(
    [{ skuSizeCode: 'M', measurements: { 胸宽: 50, 胸围: 104, 衣长: 69 } }],
    { categoryCode: 'A0202' },
  );
  assert.ok(codes(badKey.issues).includes('SIZE_CHART_MEASURE_KEY'));

  const badStep = validateSizeChart(
    [{ skuSizeCode: 'M', measurements: { 胸围: 104.3, 衣长: 69 } }],
    { categoryCode: 'A0202' },
  );
  assert.ok(codes(badStep.issues).includes('SIZE_CHART_MEASURE_VALUE'));
});

test('建议区间：min ≥ max 被拒；均码多行被拒；尺码编码非法被拒', () => {
  const wrongRange = validateSizeChart(
    [{ skuSizeCode: 'M', measurements: { 胸围: 104, 衣长: 69 }, recommendHeightMin: 170, recommendHeightMax: 170 }],
    { categoryCode: 'A0202' },
  );
  assert.ok(codes(wrongRange.issues).includes('SIZE_CHART_RECOMMEND_DIRECTION'));

  const oneSize = validateSizeChart(
    [
      { skuSizeCode: 'ONE', measurements: { 胸围: 104, 衣长: 69 }, sizeOrder: 0 },
      { skuSizeCode: 'ONE', measurements: { 胸围: 106, 衣长: 70 }, sizeOrder: 0 },
    ],
    { categoryCode: 'A0202', sizeSystem: 'one_size' },
  );
  assert.ok(codes(oneSize.issues).includes('SIZE_CHART_ONE_SIZE'));

  const badCode = validateSizeChart([{ skuSizeCode: '6XL', measurements: { 胸围: 104, 衣长: 69 } }], { categoryCode: 'A0202' });
  assert.ok(codes(badCode.issues).includes('SIZE_CHART_CODE'));
});

test('码集覆盖：SKU 有 XL 但尺码表没有 → SIZE_CHART_COVERAGE', () => {
  const chart = validateSizeChart(CHART_ROWS, { categoryCode: 'A0202' });
  assert.equal(chart.ok, true);
  const issues = checkSizeChartCoverage(chart.value ?? [], ['S', 'M', 'XL']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'SIZE_CHART_COVERAGE');
  assert.match(issues[0]!.actual, /XL/);
});

test('建议区间衔接：重叠/空档超出允许范围时告警（docs/19 §4）', () => {
  const overlap = validateSizeChart(
    [
      { skuSizeCode: 'S', measurements: { 胸围: 100, 衣长: 67 }, recommendHeightMin: 158, recommendHeightMax: 175 },
      { skuSizeCode: 'M', measurements: { 胸围: 104, 衣长: 69 }, recommendHeightMin: 170, recommendHeightMax: 177 },
    ],
    { categoryCode: 'A0202' },
  );
  assert.equal(overlap.ok, true);
  const overlapWarnings = checkRecommendRanges(overlap.value ?? []);
  assert.ok(overlapWarnings.some((issue) => issue.code === 'SIZE_CHART_RECOMMEND_OVERLAP'));

  const gap = validateSizeChart(
    [
      { skuSizeCode: 'S', measurements: { 胸围: 100, 衣长: 67 }, recommendHeightMin: 158, recommendHeightMax: 165 },
      { skuSizeCode: 'M', measurements: { 胸围: 104, 衣长: 69 }, recommendHeightMin: 172, recommendHeightMax: 179 },
    ],
    { categoryCode: 'A0202' },
  );
  const gapWarnings = checkRecommendRanges(gap.value ?? []);
  assert.ok(gapWarnings.some((issue) => issue.code === 'SIZE_CHART_RECOMMEND_GAP'));
});

// ---------------- 成分 ----------------

test('成分合法：合计 100、按占比降序，文本由数组生成', () => {
  const result = validateMaterials([
    { material: '棉', percent: 62, note: '主料' },
    { material: '聚酯纤维', percent: 33, note: '主料' },
    { material: '氨纶', percent: 5, note: '主料' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(renderMaterialsText(result.value ?? []), '棉62%、聚酯纤维33%、氨纶5%');
});

test('成分合计 99：FABRIC_SUM；俗称「涤纶」：FABRIC_ALIAS；9 条：FABRIC_COUNT', () => {
  const sum = validateMaterials([
    { material: '棉', percent: 60 },
    { material: '聚酯纤维', percent: 39 },
  ]);
  assert.ok(codes(sum.issues).includes('FABRIC_SUM'));

  const alias = validateMaterials([{ material: '涤纶', percent: 100 }]);
  assert.ok(codes(alias.issues).includes('FABRIC_ALIAS'));

  const tooMany = validateMaterials(
    Array.from({ length: 9 }, (_, index) => ({ material: index === 0 ? '棉' : '聚酯纤维', percent: index === 0 ? 20 : 10 })),
  );
  assert.ok(codes(tooMany.issues).includes('FABRIC_COUNT'));
});

test('成分百分比必须整数且在 1–100', () => {
  const result = validateMaterials([
    { material: '棉', percent: 62.5 },
    { material: '聚酯纤维', percent: 37.5 },
  ]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('FABRIC_PERCENT'));
});

// ---------------- 洗护 ----------------

const CARE = {
  wash: { code: 'W40' },
  bleach: { code: 'BNONE' },
  dry: { code: 'DHANG' },
  iron: { code: 'I150' },
  dryClean: { code: 'DCP' },
  note: '深浅色分开洗涤',
  source: 'supplier',
};

test('洗护五槽位合法：文字由码表生成', () => {
  const result = validateCare(CARE);
  assert.equal(result.ok, true);
  assert.equal(result.value?.wash.text, '40℃ 常规机洗');
  assert.equal(result.value?.wash.tempC, 40);
  assert.equal(result.value?.bleach.text, '不可漂白');
});

test('洗护缺槽位 / 码表外代码 / 来源为模型 均被拒', () => {
  const missing = validateCare({ ...CARE, dryClean: undefined });
  assert.equal(missing.ok, false);
  assert.ok(codes(missing.issues).includes('CARE_SLOT'));

  const badCode = validateCare({ ...CARE, iron: { code: 'I999' } });
  assert.ok(codes(badCode.issues).includes('CARE_CODE'));

  const modelSource = validateCare({ ...CARE, source: 'model' });
  assert.ok(codes(modelSource.issues).includes('CARE_SOURCE'));
});

test('「不可水洗」带水温：CARE_TEMP（docs/19 §6 规则 ③）', () => {
  const result = validateCare({ ...CARE, wash: { code: 'WNONE', tempC: 40 } });
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('CARE_TEMP'));
});

// ---------------- 资质 ----------------

const QUALIFICATION = {
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
      assetIds: ['0192f0a0-0000-7000-8000-0000000000a3'],
      status: 'approved',
    },
  ],
  checkedAt: '2026-10-01',
  checkedBy: '0192f0a0-0000-7000-8000-0000000000f1',
};

test('资质 valid：有效期 > 30 天，放行', () => {
  const result = evaluateQualification(QUALIFICATION, { asOf: '2026-10-21', requirementsKnown: true });
  assert.equal(result.status, 'valid');
  assert.equal(qualificationAllowsPublish(result.status), true);
  assert.equal(result.issues.length, 0);
});

test('资质 expiring：30 天内到期 → 告警但放行', () => {
  const result = evaluateQualification(
    { ...QUALIFICATION, reports: [{ ...QUALIFICATION.reports[0], validUntil: '2026-11-10' }] },
    { asOf: '2026-10-21', requirementsKnown: true },
  );
  assert.equal(result.status, 'expiring');
  assert.equal(qualificationAllowsPublish(result.status), true);
  assert.ok(codes(result.issues).includes('QUALIFICATION_EXPIRING'));
});

test('资质 expired：拦截', () => {
  const result = evaluateQualification(
    { ...QUALIFICATION, reports: [{ ...QUALIFICATION.reports[0], validUntil: '2026-09-30' }] },
    { asOf: '2026-10-21', requirementsKnown: true },
  );
  assert.equal(result.status, 'expired');
  assert.equal(qualificationAllowsPublish(result.status), false);
  assert.ok(codes(result.issues).includes('QUALIFICATION_EXPIRED'));
});

test('资质 unknown：平台要求未核验 → 直接拦截（docs/02 H1）', () => {
  const result = evaluateQualification(QUALIFICATION, { asOf: '2026-10-21', requirementsKnown: false });
  assert.equal(result.status, 'unknown');
  assert.equal(qualificationAllowsPublish(result.status), false);
  assert.deepEqual(codes(result.issues), ['QUALIFICATION_UNKNOWN']);
});

test('资质 missing：报告未审核通过 / 附件传 URL / 缺报告', () => {
  const pending = evaluateQualification(
    { ...QUALIFICATION, reports: [{ ...QUALIFICATION.reports[0], status: 'pending' }] },
    { asOf: '2026-10-21', requirementsKnown: true },
  );
  assert.equal(pending.status, 'missing');
  assert.ok(codes(pending.issues).includes('QUALIFICATION_MISSING'));

  const urlAsset = evaluateQualification(
    { ...QUALIFICATION, reports: [{ ...QUALIFICATION.reports[0], assetIds: ['https://example.com/a.png'] }] },
    { asOf: '2026-10-21', requirementsKnown: true },
  );
  assert.ok(codes(urlAsset.issues).includes('QUALIFICATION_ASSET'));

  const none = evaluateQualification({ ...QUALIFICATION, reports: [] }, { asOf: '2026-10-21', requirementsKnown: true });
  assert.equal(none.status, 'missing');
});
