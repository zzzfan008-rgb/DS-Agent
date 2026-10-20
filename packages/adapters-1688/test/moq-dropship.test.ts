/**
 * 起批量 / 混批 / 代发 单测 —— docs/02 §2.7#4/#5、docs/06 §4.2.2、判定规则 H3。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOQ_UNITS,
  checkMoqAgainstTiers,
  orderableQty,
  validateMoq,
} from '../src/domain/moq.js';
import {
  DROPSHIP_FIELD_MAP,
  DROPSHIP_TODO_IDS,
  validateDropship,
} from '../src/domain/dropship.js';
import { DomainValidationError } from '../src/errors.js';
import { assertMoq } from '../src/domain/moq.js';

const codes = (issues: { code: string }[]): string[] => issues.map((issue) => issue.code);

test('起批量合法：默认值补全（step=1、unit=piece、mix=false、max=null）', () => {
  const result = validateMoq({ minOrderQty: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    minOrderQty: 2,
    stepQty: 1,
    unit: 'piece',
    mixBatchAllowed: false,
    maxOrderQty: null,
  });
});

test('起批量为 0/负数/小数：MOQ_MIN_QTY', () => {
  for (const bad of [0, -3, 1.5, '2']) {
    const result = validateMoq({ minOrderQty: bad });
    assert.equal(result.ok, false, `minOrderQty=${String(bad)} 应被拒绝`);
    assert.ok(codes(result.issues).includes('MOQ_MIN_QTY'));
  }
});

test('步进非法：MOQ_STEP_QTY；步进大于起批量：仅告警 MOQ_STEP_LARGE', () => {
  assert.equal(validateMoq({ minOrderQty: 2, stepQty: 0 }).ok, false);
  const large = validateMoq({ minOrderQty: 2, stepQty: 5 });
  assert.equal(large.ok, true);
  assert.ok(codes(large.issues).includes('MOQ_STEP_LARGE'));
  assert.equal(large.issues[0]?.severity, 'warning');
});

test('单位与混批类型：MOQ_UNIT / MOQ_MIX_BATCH', () => {
  const badUnit = validateMoq({ minOrderQty: 1, unit: '手' });
  assert.equal(badUnit.ok, false);
  assert.ok(codes(badUnit.issues).includes('MOQ_UNIT'));
  const badMix = validateMoq({ minOrderQty: 1, mixBatchAllowed: 'yes' });
  assert.equal(badMix.ok, false);
  assert.ok(codes(badMix.issues).includes('MOQ_MIX_BATCH'));
  assert.equal(MOQ_UNITS.length, 3);
});

test('单笔上限小于起批量：MOQ_MAX_QTY', () => {
  const result = validateMoq({ minOrderQty: 10, maxOrderQty: 5 });
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('MOQ_MAX_QTY'));
});

test('orderableQty：向上取整到「起批量 + N×步进」，低于起批量时标记 belowMoq', () => {
  const moq = { minOrderQty: 5, stepQty: 5, maxOrderQty: null };
  assert.deepEqual(orderableQty(moq, 3), { qty: 5, adjusted: true, belowMoq: true });
  assert.deepEqual(orderableQty(moq, 5), { qty: 5, adjusted: false, belowMoq: false });
  assert.deepEqual(orderableQty(moq, 7), { qty: 10, adjusted: true, belowMoq: false });
  assert.deepEqual(orderableQty(moq, 10), { qty: 10, adjusted: false, belowMoq: false });
  assert.deepEqual(orderableQty({ ...moq, maxOrderQty: 8 }, 7), { qty: 8, adjusted: true, belowMoq: false });
});

test('起批量与阶梯价首档一致性：一致无问题，不一致报 MOQ_TIER_MISMATCH', () => {
  assert.deepEqual(checkMoqAgainstTiers({ minOrderQty: 2 }, 2), []);
  const issues = checkMoqAgainstTiers({ minOrderQty: 3 }, 2);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, 'MOQ_TIER_MISMATCH');
  assert.deepEqual(checkMoqAgainstTiers({ minOrderQty: 3 }, null), []);
});

test('assertMoq：失败抛 DomainValidationError', () => {
  assert.throws(() => assertMoq({ minOrderQty: 0 }), DomainValidationError);
});

test('代发启用：合法条款通过，且带 TODO 列表', () => {
  const result = validateDropship({
    enabled: true,
    dropshipPriceCents: 16800,
    leadTimeDays: 2,
    returnAddressRef: 'addr:dropship-hz-01',
    stockSource: 'supplier',
    minOrderQty: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value?.enabled, true);
  assert.deepEqual(result.value?.todos, DROPSHIP_TODO_IDS);
});

test('代发未启用却带代发字段：DROPSHIP_DISABLED_FIELDS（防止隐藏代发价）', () => {
  const result = validateDropship({
    enabled: false,
    dropshipPriceCents: 16800,
    leadTimeDays: 2,
    returnAddressRef: 'addr:x-01',
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes('DROPSHIP_DISABLED_FIELDS'));
});

test('代发必填与范围：价格/时效/库存口径', () => {
  const missing = validateDropship({ enabled: true, leadTimeDays: 2, returnAddressRef: 'addr:x-01', stockSource: 'self' });
  assert.equal(missing.ok, false);
  assert.ok(codes(missing.issues).includes('DROPSHIP_PRICE'));

  const tooSlow = validateDropship({
    enabled: true,
    dropshipPriceCents: 100,
    leadTimeDays: 61,
    returnAddressRef: 'addr:x-01',
    stockSource: 'self',
  });
  assert.ok(codes(tooSlow.issues).includes('DROPSHIP_LEAD_TIME'));

  const badStock = validateDropship({
    enabled: true,
    dropshipPriceCents: 100,
    leadTimeDays: 2,
    returnAddressRef: 'addr:x-01',
    stockSource: 'third-party',
  });
  assert.ok(codes(badStock.issues).includes('DROPSHIP_STOCK_SOURCE'));
});

test('退货地址只接受引用键：明文地址被拒（PII 不得进入上架包）', () => {
  for (const bad of ['浙江省杭州市余杭区某某路 1 号', 'https://example.com/addr', 'addr:', '']) {
    const result = validateDropship({
      enabled: true,
      dropshipPriceCents: 100,
      leadTimeDays: 2,
      returnAddressRef: bad,
      stockSource: 'self',
    });
    assert.equal(result.ok, false, `地址 ${bad} 应被拒绝`);
    assert.ok(codes(result.issues).includes('DROPSHIP_RETURN_REF'));
  }
});

test('代发字段映射表：平台字段一律 null + TODO id（不猜字段名）', () => {
  assert.ok(DROPSHIP_FIELD_MAP.length >= 6);
  for (const row of DROPSHIP_FIELD_MAP) {
    assert.equal(row.platformField, null, `${row.internalField} 不得填猜测的平台字段名`);
    assert.match(row.todoId, /^TODO-1688-/);
  }
});
