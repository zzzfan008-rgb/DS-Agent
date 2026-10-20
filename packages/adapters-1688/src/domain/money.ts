/**
 * 金额与数量的整数口径 —— docs/21 §1：一律整数分（`*_cents`），禁止浮点与已废止的微元口径。
 *
 * 1688 是 B2B：同一个 SKU 有「起批价 + 多档阶梯价 + 代发价」，全部用整数分表达，
 * 展示成「元」只在渲染层做，不参与任何计算。
 */

/** 单价上限（1,000,000 元 = 100,000,000 分）：超出视为录入错误而非真实批发价。 */
export const MAX_PRICE_CENTS = 100_000_000;

/** 数量上限（与 docs/06 §6.4 `min_qty.maximum = 99999` 对齐）。 */
export const MAX_QTY = 99_999;

/** 是否为合法的金额分（正安全整数且不超过上限）。 */
export function isPriceCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PRICE_CENTS;
}

/** 是否为合法的数量（正安全整数且不超过上限）。 */
export function isQty(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_QTY;
}

/**
 * 分 → 元字符串（展示用）。纯整数运算，避免 `cents / 100` 的浮点误差。
 * 例：`15800` → `"158.00"`；`1` → `"0.01"`。
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new TypeError(`金额必须是整数分，收到 ${String(cents)}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.trunc(abs / 100);
  const fen = abs % 100;
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`;
}

/** 分 → `¥158.00`（只用于文案与验收文档，不参与业务判断）。 */
export function displayCents(cents: number): string {
  return `¥${formatCents(cents)}`;
}

/** 元字符串/数字 → 分；仅供导入层与测试构造数据使用。 */
export function centsFromYuan(yuan: string | number): number {
  const text = String(yuan).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new TypeError(`元金额格式不合法：${text}`);
  const [integerPart = '0', fractionPart = ''] = text.split('.');
  const fen = Number(`${fractionPart}00`.slice(0, 2));
  return Number(integerPart) * 100 + fen;
}
