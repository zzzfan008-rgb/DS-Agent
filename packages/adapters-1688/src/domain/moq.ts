/**
 * 1688 起批量（MOQ）与混批 —— docs/06 §4.2.2 `min_order_qty` + docs/02 §2.7#4。
 *
 * 事实边界：
 * - `product_sku.min_order_qty` 是**已落库**的列（`CHECK (min_order_qty >= 1)`）；
 * - `mix_batch_allowed`（混批）在 docs/02 §6.1 被要求建结构，但 docs/06 与 t1 迁移里
 *   **没有承载列** —— 本模块照实建模，并在持久化层标记 `TODO-1688-PERSIST-01`；
 * - 单位（件/套/手）的平台取值未核验，内部只用受控词表 `piece|set|dozen`。
 */

import { DomainValidationError } from '../errors.js';
import {
  asRecord,
  blocker,
  describeValue,
  failure,
  success,
  warning,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';
import { isQty } from './money.js';

/** 内部计量单位（平台侧取值未核验：docs/02 §2.7#1 的「件/套/手」只是候选）。 */
export const MOQ_UNITS = ['piece', 'set', 'dozen'] as const;
export type MoqUnit = (typeof MOQ_UNITS)[number];

export const MOQ_UNIT_LABEL: Record<MoqUnit, string> = {
  piece: '件',
  set: '套',
  dozen: '打',
};

/** 平台单位映射：**未核验**，仅为导出包提供一个稳定占位。 */
export function unitLabel(unit: MoqUnit): string {
  return MOQ_UNIT_LABEL[unit];
}

export interface Moq {
  /** 最小起订量（`product_sku.min_order_qty`）。 */
  minOrderQty: number;
  /** 下单步进：每次增减的数量（1 表示逐件）。 */
  stepQty: number;
  unit: MoqUnit;
  /** 混批：同一订单可否混合不同 SKU 凑起批量（无 DB 列，见 TODO-1688-PERSIST-01）。 */
  mixBatchAllowed: boolean;
  /** 单笔上限，`null` 表示不限。 */
  maxOrderQty: number | null;
}

export interface MoqValidateOptions {
  /** 默认单位，缺省 `piece`。 */
  defaultUnit?: MoqUnit;
}

function isUnit(value: unknown): value is MoqUnit {
  return typeof value === 'string' && (MOQ_UNITS as readonly string[]).includes(value);
}

/** 校验起批量结构；不通过抛 `DomainValidationError`。 */
export function validateMoq(raw: unknown, options: MoqValidateOptions = {}): ValidationResult<Moq> {
  const row = asRecord(raw);
  if (!row) {
    return failure([blocker('MOQ_TYPE', 'moq', '对象', describeValue(raw), '起批量必须是对象')]);
  }
  const issues: ValidationIssue[] = [];
  const minOrderQty = row.minOrderQty;
  const stepQty = row.stepQty ?? 1;
  const unit = row.unit ?? options.defaultUnit ?? 'piece';
  const mixBatchAllowed = row.mixBatchAllowed ?? false;
  const maxOrderQty = row.maxOrderQty ?? null;

  if (!isQty(minOrderQty)) {
    issues.push(
      blocker('MOQ_MIN_QTY', 'moq.min_order_qty', '1–99999 的整数', describeValue(minOrderQty), '起批量必须是正整数（0 或负数在 B2B 无意义）'),
    );
  }
  if (!isQty(stepQty)) {
    issues.push(
      blocker('MOQ_STEP_QTY', 'moq.step_qty', '1–99999 的整数', describeValue(stepQty), '下单步进必须是正整数'),
    );
  } else if (isQty(minOrderQty) && stepQty > minOrderQty) {
    issues.push(
      warning(
        'MOQ_STEP_LARGE',
        'moq.step_qty',
        `≤ ${minOrderQty}（起批量）`,
        describeValue(stepQty),
        '步进大于起批量时，起批量本身无法被下单命中（可能出现 2、7、12 这样的序列）',
      ),
    );
  }
  if (!isUnit(unit)) {
    issues.push(
      blocker('MOQ_UNIT', 'moq.unit', MOQ_UNITS.join('|'), describeValue(unit), '计量单位只允许内部受控值，禁止自由文本'),
    );
  }
  if (typeof mixBatchAllowed !== 'boolean') {
    issues.push(
      blocker('MOQ_MIX_BATCH', 'moq.mix_batch_allowed', '布尔', describeValue(mixBatchAllowed), '混批标记必须是布尔值'),
    );
  }
  if (maxOrderQty !== null) {
    if (!isQty(maxOrderQty)) {
      issues.push(
        blocker('MOQ_MAX_QTY', 'moq.max_order_qty', 'null 或正整数', describeValue(maxOrderQty), '单笔上限只允许 null 或正整数'),
      );
    } else if (isQty(minOrderQty) && maxOrderQty < minOrderQty) {
      issues.push(
        blocker('MOQ_MAX_QTY', 'moq.max_order_qty', `≥ ${minOrderQty}`, describeValue(maxOrderQty), '单笔上限不得小于起批量'),
      );
    }
  }

  if (issues.some((issue) => issue.severity === 'blocker') || !isQty(minOrderQty) || !isQty(stepQty) || !isUnit(unit)) {
    return failure(issues);
  }
  return success(
    {
      minOrderQty,
      stepQty,
      unit,
      mixBatchAllowed: mixBatchAllowed === true,
      maxOrderQty: maxOrderQty === null ? null : (maxOrderQty as number),
    },
    issues,
  );
}

export function assertMoq(raw: unknown, options: MoqValidateOptions = {}): Moq {
  const result = validateMoq(raw, options);
  if (!result.ok || result.value === null) throw new DomainValidationError('起批量', result.issues);
  return result.value;
}

export interface OrderableQty {
  /** 实际可下单数量（按起批量与步进向上取整）。 */
  qty: number;
  /** 是否因取整而调整（原请求量不是「起批量 + N×步进」）。 */
  adjusted: boolean;
  /** 是否低于起批量。 */
  belowMoq: boolean;
}

/**
 * B2B 下单量归整：`qty = minOrderQty + ceil((requested − minOrderQty) / stepQty) × stepQty`。
 * 低于起批量时返回 `belowMoq=true`（调用方应提示而不是静默加量）。
 */
export function orderableQty(moq: Pick<Moq, 'minOrderQty' | 'stepQty' | 'maxOrderQty'>, requested: number): OrderableQty {
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return { qty: moq.minOrderQty, adjusted: true, belowMoq: true };
  }
  if (requested < moq.minOrderQty) {
    return { qty: moq.minOrderQty, adjusted: true, belowMoq: true };
  }
  const step = moq.stepQty > 0 ? moq.stepQty : 1;
  const extra = requested - moq.minOrderQty;
  const rounded = moq.minOrderQty + Math.ceil(extra / step) * step;
  const capped = moq.maxOrderQty !== null ? Math.min(rounded, moq.maxOrderQty) : rounded;
  return { qty: capped, adjusted: capped !== requested, belowMoq: false };
}

/** 起批量与阶梯价首档的一致性：返回问题（导出器与写入门共用）。 */
export function checkMoqAgainstTiers(
  moq: Pick<Moq, 'minOrderQty'>,
  firstTierMinQty: number | null,
): ValidationIssue[] {
  if (firstTierMinQty === null) return [];
  if (firstTierMinQty === moq.minOrderQty) return [];
  return [
    blocker(
      'MOQ_TIER_MISMATCH',
      'moq.min_order_qty',
      String(firstTierMinQty),
      String(moq.minOrderQty),
      '起批量必须等于阶梯价首档 min_qty（docs/06 §6.4 x-rules），否则平台展示的起批价与起批量对不上',
    ),
  ];
}
