/**
 * 阶梯价 / 起批价 / 区间价 单测 —— docs/06 §6.4 x-rules + docs/02 判定规则 H2。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRICE_TIER_MAX_COUNT,
  computePriceRange,
  describePriceTiers,
  isPriceMonotonic,
  priceTiersDigest,
  resolveTierPrice,
  validatePriceTiers,
} from '../src/domain/price-tiers.js';
import type { PriceTier } from '../src/domain/price-tiers.js';
import { centsFromYuan, displayCents, formatCents } from '../src/domain/money.js';
import { DomainValidationError } from '../src/errors.js';
import { assertPriceTiers } from '../src/domain/price-tiers.js';

const VALID: PriceTier[] = [
  { minQty: 2, maxQty: 49, priceCents: 15800 },
  { minQty: 50, maxQty: 199, priceCents: 14200 },
  { minQty: 200, maxQty: null, priceCents: 12800 },
];

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

test('合法三档：通过且原样返回（不自动补 max_qty、不排序）', () => {
  const result = validatePriceTiers(VALID, { minOrderQty: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, VALID);
});

test('合法五档（上限）：通过', () => {
  const five: PriceTier[] = [
    { minQty: 1, maxQty: 9, priceCents: 1000 },
    { minQty: 10, maxQty: 49, priceCents: 950 },
    { minQty: 50, maxQty: 199, priceCents: 900 },
    { minQty: 200, maxQty: 999, priceCents: 850 },
    { minQty: 1000, maxQty: null, priceCents: 800 },
  ];
  assert.equal(five.length, PRICE_TIER_MAX_COUNT);
  assert.equal(validatePriceTiers(five, { minOrderQty: 1 }).ok, true);
});

test('空数组：默认拒绝，allowEmpty 时放行', () => {
  const rejected = validatePriceTiers([], {});
  assert.equal(rejected.ok, false);
  assert.deepEqual(codes(rejected.issues), ['PRICE_TIER_COUNT']);
  assert.equal(validatePriceTiers([], { allowEmpty: true }).ok, true);
});

test('超过 5 档：拒绝', () => {
  const six = Array.from({ length: 6 }, (_, index) => ({
    minQty: index * 10 + 1,
    maxQty: index === 5 ? null : index * 10 + 10,
    priceCents: 1000 - index * 10,
  }));
  const result = validatePriceTiers(six, {});
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_COUNT'));
});

test('min_qty 重复/倒退：PRICE_TIER_ORDER', () => {
  const result = validatePriceTiers(
    [
      { minQty: 10, maxQty: 20, priceCents: 1000 },
      { minQty: 10, maxQty: null, priceCents: 900 },
    ],
    {},
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_ORDER'));
});

test('区间重叠：PRICE_TIER_OVERLAP（上一档上限 49，下一档从 40 开始）', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: 49, priceCents: 15800 },
      { minQty: 40, maxQty: null, priceCents: 15000 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_OVERLAP'));
});

test('区间留空档：PRICE_TIER_GAP（49 之后从 60 开始）', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: 49, priceCents: 15800 },
      { minQty: 60, maxQty: null, priceCents: 15000 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_GAP'));
});

test('价格随量上升：PRICE_TIER_MONOTONIC', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: 49, priceCents: 15000 },
      { minQty: 50, maxQty: null, priceCents: 15800 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_MONOTONIC'));
});

test('价格持平：允许（单调不增）', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: 49, priceCents: 15000 },
      { minQty: 50, maxQty: null, priceCents: 15000 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, true);
});

test('末档必须有上限为 null：PRICE_TIER_CLOSED_LAST', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: 49, priceCents: 15800 },
      { minQty: 50, maxQty: 99, priceCents: 15000 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_CLOSED_LAST'));
});

test('非末档无上限：PRICE_TIER_OPEN_END', () => {
  const result = validatePriceTiers(
    [
      { minQty: 2, maxQty: null, priceCents: 15800 },
      { minQty: 50, maxQty: null, priceCents: 15000 },
    ],
    { minOrderQty: 2 },
  );
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_OPEN_END'));
});

test('首档 min_qty 与起批量不一致：PRICE_TIER_FIRST_MOQ', () => {
  const result = validatePriceTiers(VALID, { minOrderQty: 5 });
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ['PRICE_TIER_FIRST_MOQ']);
});

test('金额/数量类型错误：一次性报全 PRICE_TIER_MIN_QTY / PRICE / MAX_QTY', () => {
  const result = validatePriceTiers(
    [
      { minQty: 0, maxQty: -1, priceCents: 12.5 },
      { minQty: '50', maxQty: null, priceCents: 0 },
    ],
    {},
  );
  assert.equal(result.ok, false);
  const list = codes(result.issues);
  assert.ok(list.includes('PRICE_TIER_MIN_QTY'));
  assert.ok(list.includes('PRICE_TIER_PRICE'));
  assert.ok(list.includes('PRICE_TIER_MAX_QTY'));
});

test('max_qty 小于 min_qty：PRICE_TIER_MAX_QTY', () => {
  const result = validatePriceTiers([{ minQty: 100, maxQty: 50, priceCents: 1000 }], {});
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('PRICE_TIER_MAX_QTY'));
});

test('非数组：PRICE_TIER_TYPE', () => {
  const result = validatePriceTiers({ minQty: 1 }, {});
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ['PRICE_TIER_TYPE']);
});

test('resolveTierPrice：边界值与低于起批量', () => {
  const at1 = resolveTierPrice(VALID, 2);
  assert.equal(at1.ok, true);
  assert.equal(at1.value?.priceCents, 15800);
  assert.equal(at1.value?.tierIndex, 0);

  const at49 = resolveTierPrice(VALID, 49);
  assert.equal(at49.value?.priceCents, 15800);

  const at50 = resolveTierPrice(VALID, 50);
  assert.equal(at50.value?.priceCents, 14200);
  assert.equal(at50.value?.tierIndex, 1);

  const at199 = resolveTierPrice(VALID, 199);
  assert.equal(at199.value?.priceCents, 14200);

  const at200 = resolveTierPrice(VALID, 200);
  assert.equal(at200.value?.priceCents, 12800);

  const huge = resolveTierPrice(VALID, 99_999);
  assert.equal(huge.value?.priceCents, 12800);

  const below = resolveTierPrice(VALID, 1);
  assert.equal(below.ok, false);
  assert.deepEqual(codes(below.issues), ['PRICE_TIER_BELOW_MOQ']);
});

test('区间价由档位推导：min=末档价、max=首档价；单一价时省略区间文案', () => {
  const range = computePriceRange(VALID);
  assert.equal(range.minCents, 12800);
  assert.equal(range.maxCents, 15800);
  assert.equal(range.isFlat, false);
  assert.equal(range.display, `${displayCents(12800)}–${displayCents(15800)}`);

  const flat = computePriceRange([
    { minQty: 1, maxQty: 9, priceCents: 9900 },
    { minQty: 10, maxQty: null, priceCents: 9900 },
  ]);
  assert.equal(flat.isFlat, true);
  assert.equal(flat.display, displayCents(9900));
});

test('区间价推导前必须单调，否则抛 DomainValidationError', () => {
  const broken: PriceTier[] = [
    { minQty: 1, maxQty: 9, priceCents: 1000 },
    { minQty: 10, maxQty: null, priceCents: 1200 },
  ];
  assert.equal(isPriceMonotonic(broken), false);
  assert.throws(() => computePriceRange(broken), DomainValidationError);
});

test('指纹稳定：同内容同哈希，改一个分也不同', () => {
  const first = priceTiersDigest(VALID);
  const second = priceTiersDigest(structuredClone(VALID));
  assert.equal(first, second);
  const changed = priceTiersDigest([...VALID.slice(0, 2), { minQty: 200, maxQty: null, priceCents: 12700 }]);
  assert.notEqual(first, changed);
});

test('describePriceTiers / 金额格式化：整数分不产生浮点误差', () => {
  assert.equal(
    describePriceTiers(VALID),
    '2-49件=¥158.00，50-199件=¥142.00，200+件=¥128.00',
  );
  assert.equal(formatCents(1), '0.01');
  assert.equal(formatCents(15800), '158.00');
  assert.equal(centsFromYuan('158.00'), 15800);
  assert.equal(centsFromYuan(0.1), 10);
});

test('assertPriceTiers：失败抛 DomainValidationError 并携带问题列表', () => {
  try {
    assertPriceTiers([{ minQty: 1, maxQty: null, priceCents: 1000 }], { minOrderQty: 2 });
    assert.fail('应当抛错');
  } catch (error) {
    assert.ok(error instanceof DomainValidationError);
    assert.equal(error.issues[0]?.code, 'PRICE_TIER_FIRST_MOQ');
  }
});
