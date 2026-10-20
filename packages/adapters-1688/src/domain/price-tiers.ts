/**
 * 1688 阶梯价 / 起批价 / 区间价 —— `PriceTiersV1`（docs/06 §6.4）+ 判定规则 H2（docs/02 §2.7）。
 *
 * 为什么这个模块是本包的核心：
 * 1688 是 B2B，同一件货的价格是「一个区间 + 一组阶梯」，不是单一数字。若主数据只存
 * 一个 `price_cents`，上架必错（docs/02 §0 结论 2）。因此本模块把**平台无关的价格结构**
 * 定义死，并把 docs/06 §6.4 的 `x-rules` 从注释变成可执行校验：
 *
 * | 规则 | 说明 | 错误码 |
 * |---|---|---|
 * | 1–5 档 | `maxItems: 5`，不允许空（1688 上架至少一档） | `PRICE_TIER_COUNT` |
 * | `min_qty` 严格递增、不重复 | 档位按量升序 | `PRICE_TIER_ORDER` |
 * | `price_cents` 随 `min_qty` 单调不增 | 量大价低，允许持平 | `PRICE_TIER_MONOTONIC` |
 * | 首档 `min_qty == product_sku.min_order_qty` | 起批价即首档价 | `PRICE_TIER_FIRST_MOQ` |
 * | 区间不重叠、不留空档 | 相邻档位首尾相接 | `PRICE_TIER_OVERLAP` / `PRICE_TIER_GAP` |
 * | `max_qty` 为空仅末档可为 | 最高档开放（无上限） | `PRICE_TIER_OPEN_END` / `PRICE_TIER_CLOSED_LAST` |
 *
 * 区间价（展示值）由档位推导，不单独存储：`min = 末档价`、`max = 首档价`，
 * 推导前必须先通过上面的校验（否则区间价没有意义）。
 */

import { createHash } from 'node:crypto';
import { DomainValidationError } from '../errors.js';
import {
  asRecord,
  blocker,
  describeValue,
  failure,
  success,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';
import { displayCents, isPriceCents, isQty } from './money.js';

/** docs/06 §6.4：`maxItems: 5`。 */
export const PRICE_TIER_MAX_COUNT = 5;

/** 校验规则 ID（与 docs/02 判定规则 H2 的 `PRICE_TIER_*` 命名一致）。 */
export const PRICE_TIER_RULE_IDS = [
  'PRICE_TIER_TYPE',
  'PRICE_TIER_COUNT',
  'PRICE_TIER_MIN_QTY',
  'PRICE_TIER_PRICE',
  'PRICE_TIER_MAX_QTY',
  'PRICE_TIER_ORDER',
  'PRICE_TIER_OPEN_END',
  'PRICE_TIER_CLOSED_LAST',
  'PRICE_TIER_OVERLAP',
  'PRICE_TIER_GAP',
  'PRICE_TIER_MONOTONIC',
  'PRICE_TIER_FIRST_MOQ',
  'PRICE_TIER_BELOW_MOQ',
] as const;

export type PriceTierRuleId = (typeof PRICE_TIER_RULE_IDS)[number];

/** 一档阶梯价：`minQty..maxQty`（含端点）区间内单价为 `priceCents`。 */
export interface PriceTier {
  minQty: number;
  /** `null` 表示无上限，仅末档允许（docs/06 §6.4）。 */
  maxQty: number | null;
  priceCents: number;
}

export interface PriceTierValidateOptions {
  /** `product_sku.min_order_qty`：传入则校验首档 `minQty` 必须等于它。 */
  minOrderQty?: number;
  /** 是否允许空数组（拼多多专用 SKU 允许 `[]`；1688 上架不允许）。默认 `false`。 */
  allowEmpty?: boolean;
}

export interface RawPriceTier {
  minQty?: unknown;
  maxQty?: unknown;
  priceCents?: unknown;
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * 校验阶梯价。返回规范化后的档位（保留输入顺序、不做静默排序/补全）。
 *
 * 刻意**不自动补 `maxQty`**：平台字段语义未核验（docs/02 §2.7#2），自动补值会让
 * 「数据缺失」看起来像「数据正确」，违背 `docs/19` 铁律 6（平台值不猜）。
 */
export function validatePriceTiers(
  raw: unknown,
  options: PriceTierValidateOptions = {},
): ValidationResult<PriceTier[]> {
  if (!Array.isArray(raw)) {
    return failure([
      blocker('PRICE_TIER_TYPE', 'price_tiers', '数组（[{min_qty, max_qty, price_cents}]）', describeValue(raw), 'price_tiers 必须是数组'),
    ]);
  }

  const issues: ValidationIssue[] = [];

  if (raw.length === 0) {
    if (options.allowEmpty) return success([], []);
    return failure([
      blocker('PRICE_TIER_COUNT', 'price_tiers', '1–5 档', '0 档', '1688 商品至少需要一档阶梯价（首档即起批价）'),
    ]);
  }
  if (raw.length > PRICE_TIER_MAX_COUNT) {
    issues.push(
      blocker(
        'PRICE_TIER_COUNT',
        'price_tiers',
        `≤ ${PRICE_TIER_MAX_COUNT} 档`,
        `${raw.length} 档`,
        '档位数量超出 docs/06 §6.4 上限，请合并档位',
      ),
    );
  }

  const parsed: PriceTier[] = [];
  raw.forEach((item, index) => {
    const row = asRecord(item);
    const field = `price_tiers[${index}]`;
    if (!row) {
      issues.push(blocker('PRICE_TIER_TYPE', field, '对象', describeValue(item), '档位必须是对象'));
      return;
    }
    const minQty = row.minQty;
    const priceCents = row.priceCents;
    const maxQty = row.maxQty;

    if (!isQty(minQty)) {
      issues.push(
        blocker('PRICE_TIER_MIN_QTY', `${field}.min_qty`, '1–99999 的整数', describeValue(minQty), 'min_qty 必须是正整数（件数）'),
      );
    }
    if (!isPriceCents(priceCents)) {
      issues.push(
        blocker('PRICE_TIER_PRICE', `${field}.price_cents`, '正整数分（≤1,000,000 元）', describeValue(priceCents), '单价一律整数分，禁止元/浮点'),
      );
    }
    if (!isNullish(maxQty) && !isQty(maxQty)) {
      issues.push(
        blocker('PRICE_TIER_MAX_QTY', `${field}.max_qty`, 'null 或 1–99999 的整数', describeValue(maxQty), 'max_qty 只允许 null 或正整数'),
      );
    }
    if (isQty(maxQty) && isQty(minQty) && maxQty < minQty) {
      issues.push(
        blocker('PRICE_TIER_MAX_QTY', `${field}.max_qty`, `≥ ${minQty}`, describeValue(maxQty), 'max_qty 不得小于 min_qty'),
      );
    }

    if (isQty(minQty) && isPriceCents(priceCents) && (isNullish(maxQty) || isQty(maxQty))) {
      parsed.push({ minQty, maxQty: isNullish(maxQty) ? null : maxQty, priceCents });
    }
  });

  // 结构错误优先：数值不合法时继续做单调/区间判断只会产生噪声。
  if (issues.length > 0 || parsed.length !== raw.length) {
    return failure(issues);
  }

  const lastIndex = parsed.length - 1;
  parsed.forEach((tier, index) => {
    const field = `price_tiers[${index}]`;
    if (index < lastIndex && tier.maxQty === null) {
      issues.push(
        blocker('PRICE_TIER_OPEN_END', `${field}.max_qty`, '非末档必须有上限', 'null', '只有末档允许无上限（开放式最高档）'),
      );
    }
    if (index === lastIndex && tier.maxQty !== null) {
      issues.push(
        blocker('PRICE_TIER_CLOSED_LAST', `${field}.max_qty`, 'null（无上限）', describeValue(tier.maxQty), '最高档必须开放，否则超过 max_qty 的订单无价可依'),
      );
    }
  });

  for (let index = 1; index < parsed.length; index += 1) {
    const prev = parsed[index - 1]!;
    const current = parsed[index]!;
    const field = `price_tiers[${index}]`;

    if (current.minQty <= prev.minQty) {
      issues.push(
        blocker(
          'PRICE_TIER_ORDER',
          `${field}.min_qty`,
          `> ${prev.minQty}`,
          describeValue(current.minQty),
          'min_qty 必须严格递增且不得重复（档位顺序即业务顺序，不自动排序）',
        ),
      );
      continue;
    }

    if (prev.maxQty !== null) {
      if (prev.maxQty >= current.minQty) {
        issues.push(
          blocker(
            'PRICE_TIER_OVERLAP',
            `${field}.min_qty`,
            `≥ ${prev.maxQty + 1}`,
            describeValue(current.minQty),
            `第 ${index} 档与第 ${index + 1} 档区间重叠（上一档上限 ${prev.maxQty}）`,
          ),
        );
      } else if (prev.maxQty + 1 < current.minQty) {
        issues.push(
          blocker(
            'PRICE_TIER_GAP',
            `${field}.min_qty`,
            `${prev.maxQty + 1}`,
            describeValue(current.minQty),
            `第 ${index} 档与第 ${index + 1} 档之间有空档（${prev.maxQty + 1}–${current.minQty - 1} 无价）`,
          ),
        );
      }
    }

    if (current.priceCents > prev.priceCents) {
      issues.push(
        blocker(
          'PRICE_TIER_MONOTONIC',
          `${field}.price_cents`,
          `≤ ${prev.priceCents}（上一档单价）`,
          describeValue(current.priceCents),
          '量大价不得更高：price_cents 必须随 min_qty 单调不增',
        ),
      );
    }
  }

  if (options.minOrderQty !== undefined && parsed.length > 0) {
    const first = parsed[0]!;
    if (first.minQty !== options.minOrderQty) {
      issues.push(
        blocker(
          'PRICE_TIER_FIRST_MOQ',
          'price_tiers[0].min_qty',
          String(options.minOrderQty),
          describeValue(first.minQty),
          '首档 min_qty 必须等于 product_sku.min_order_qty（起批价与起批量必须一致）',
        ),
      );
    }
  }

  if (issues.length > 0) return failure(issues);
  return success(parsed, []);
}

/** 校验并返回档位；不通过抛 `DomainValidationError`（供导出器/写入门使用）。 */
export function assertPriceTiers(raw: unknown, options: PriceTierValidateOptions = {}): PriceTier[] {
  const result = validatePriceTiers(raw, options);
  if (!result.ok || result.value === null) throw new DomainValidationError('阶梯价', result.issues);
  return result.value;
}

/** 是否为单调不增的价格序列（用于区间价推导前的前置断言）。 */
export function isPriceMonotonic(tiers: readonly PriceTier[]): boolean {
  for (let index = 1; index < tiers.length; index += 1) {
    if (tiers[index]!.priceCents > tiers[index - 1]!.priceCents) return false;
  }
  return true;
}

export interface PriceRange {
  /** 区间下限（末档价，量最大时最便宜）。 */
  minCents: number;
  /** 区间上限（首档价，起批价）。 */
  maxCents: number;
  /** 展示文案，如 `¥128.00–¥158.00`；单一价时只显示一个。 */
  display: string;
  isFlat: boolean;
}

/**
 * 由已校验的档位推导「区间价」（docs/02 §2.7#3：区间价是展示值，多由档位自动计算）。
 * 必须传入已通过 `validatePriceTiers` 的档位；否则抛 `DomainValidationError`。
 */
export function computePriceRange(tiers: readonly PriceTier[]): PriceRange {
  if (tiers.length === 0) {
    throw new DomainValidationError('区间价', [
      blocker('PRICE_TIER_COUNT', 'price_tiers', '≥1 档', '0 档', '没有档位无法推导区间价'),
    ]);
  }
  if (!isPriceMonotonic(tiers)) {
    throw new DomainValidationError('区间价', [
      blocker('PRICE_TIER_MONOTONIC', 'price_tiers', '价格单调不增', '存在后档更贵', '先修正档位再推导区间价'),
    ]);
  }
  let minCents = tiers[0]!.priceCents;
  let maxCents = tiers[0]!.priceCents;
  for (const tier of tiers) {
    if (tier.priceCents < minCents) minCents = tier.priceCents;
    if (tier.priceCents > maxCents) maxCents = tier.priceCents;
    // 区间端点由档位覆盖范围决定：首档 minQty 起批，末档无上限。
  }
  const isFlat = minCents === maxCents;
  return {
    minCents,
    maxCents,
    isFlat,
    display: isFlat ? displayCents(minCents) : `${displayCents(minCents)}–${displayCents(maxCents)}`,
  };
}

export interface ResolvedTierPrice {
  priceCents: number;
  tierIndex: number;
  tier: PriceTier;
}

/**
 * 按采购量取单价：`qty` 落在哪一档就取哪一档。
 * 低于起批量时返回 `PRICE_TIER_BELOW_MOQ`（而不是悄悄按首档算）。
 */
export function resolveTierPrice(
  tiers: readonly PriceTier[],
  qty: number,
): ValidationResult<ResolvedTierPrice> {
  if (!Number.isSafeInteger(qty) || qty < 1) {
    return failure([
      blocker('PRICE_TIER_BELOW_MOQ', 'qty', '≥1 的整数', describeValue(qty), '采购量必须是正整数'),
    ]);
  }
  if (tiers.length === 0) {
    return failure([blocker('PRICE_TIER_COUNT', 'price_tiers', '≥1 档', '0 档', '没有任何档位')]);
  }
  const first = tiers[0]!;
  if (qty < first.minQty) {
    return failure([
      blocker(
        'PRICE_TIER_BELOW_MOQ',
        'qty',
        `≥ ${first.minQty}（起批量）`,
        describeValue(qty),
        '低于起批量不下单；B2B 不允许按低于起批量的数量成交',
      ),
    ]);
  }
  let index = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i]!;
    if (qty >= tier.minQty && (tier.maxQty === null || qty <= tier.maxQty)) {
      index = i;
      break;
    }
    if (qty > tier.minQty) index = i;
  }
  const tier = tiers[index]!;
  return success({ priceCents: tier.priceCents, tierIndex: index, tier });
}

/** 档位指纹：用于幂等键、上架包哈希与 `listing.price_tiers` 快照比对。 */
export function priceTiersDigest(tiers: readonly PriceTier[]): string {
  const canonical = JSON.stringify(tiers.map((tier) => [tier.minQty, tier.maxQty, tier.priceCents]));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 供日志/验收文档使用的短摘要。 */
export function describePriceTiers(tiers: readonly PriceTier[]): string {
  return tiers
    .map((tier) => `${tier.minQty}${tier.maxQty === null ? '+' : `-${tier.maxQty}`}件=${displayCents(tier.priceCents)}`)
    .join('，');
}
