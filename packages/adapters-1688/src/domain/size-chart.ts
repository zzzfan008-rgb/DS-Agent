/**
 * 尺码表结构与测量校验 —— docs/19 §3、§4、§10（L0/L1）。
 *
 * 关键约束：
 * - `measurements` 只允许 docs/06 §6.1 的 12 个中文键；键名即口径（"胸宽""衣尺寸"一律拒绝）；
 * - 长度单位一律 cm、步进 0.5；值 > 0 且 ≤ 250；
 * - 按 `category_code` 校验品类必测部位（docs/19 §3.2 的 `L1-SIZE-003` 口径）；
 * - 建议身高/体重四字段必须成对出现且 `min < max`；
 * - `one_size` 整表只允许 1 行；
 * - 尺码码集必须覆盖所有 `active` SKU 的码集（`L1-SIZE-004`），由 `checkSizeChartCoverage`
 *   在导出器里与 SKU 一起判断。
 */

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
import { normalizeSizeCode, sizeOrderFor } from './spec.js';

/** docs/06 §6.1 / docs/19 §3 的 12 个部位键。 */
export const MEASUREMENT_KEYS = [
  '衣长',
  '胸围',
  '肩宽',
  '袖长',
  '腰围',
  '臀围',
  '下摆',
  '裙长',
  '裤长',
  '脚口',
  '大腿围',
  '领围',
] as const;

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

const MEASUREMENT_SET = new Set<string>(MEASUREMENT_KEYS);

/** 品类必测部位（docs/19 §3.2）。细分码 `A0101.001` 继承父级。 */
export const REQUIRED_MEASUREMENTS: Readonly<Record<string, readonly MeasurementKey[]>> = {
  A0101: ['胸围', '衣长'],
  A0202: ['胸围', '衣长'],
  B0211: ['腰围', '裤长'],
  C0221: ['胸围', '裙长'],
  D0232: ['胸围', '衣长'],
  E0201: ['胸围'],
  G0201: ['胸围', '衣长'],
};

export type SizeSystem = 'alpha' | 'numeric' | 'one_size';

export interface SizeChartRowInput {
  skuSizeCode: unknown;
  sizeOrder?: unknown;
  measurements: unknown;
  recommendHeightMin?: unknown;
  recommendHeightMax?: unknown;
  recommendWeightMin?: unknown;
  recommendWeightMax?: unknown;
  extraMeasures?: unknown;
}

export interface SizeChartRow {
  skuSizeCode: string;
  sizeOrder: number;
  measurements: Partial<Record<MeasurementKey, number>>;
  extraMeasures: Record<string, number>;
  recommendHeightMin: number | null;
  recommendHeightMax: number | null;
  recommendWeightMin: number | null;
  recommendWeightMax: number | null;
}

export interface SizeChartValidateOptions {
  categoryCode: string;
  sizeSystem?: SizeSystem;
}

/** 品类必测部位：先精确匹配，再退到 `.NNN` 前的父级码。 */
export function requiredMeasuresFor(categoryCode: string): readonly MeasurementKey[] {
  const exact = REQUIRED_MEASUREMENTS[categoryCode];
  if (exact) return exact;
  const parent = categoryCode.split('.')[0] ?? categoryCode;
  return REQUIRED_MEASUREMENTS[parent] ?? [];
}

function readOptionalInt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  return Number.isSafeInteger(num) ? num : Number.NaN;
}

/** 校验尺码表行集合。 */
export function validateSizeChart(
  rawRows: unknown,
  options: SizeChartValidateOptions,
): ValidationResult<SizeChartRow[]> {
  if (!Array.isArray(rawRows)) {
    return failure([blocker('SIZE_CHART_TYPE', 'size_chart', '数组', describeValue(rawRows), '尺码表必须是按尺码展开的数组')]);
  }
  if (rawRows.length === 0) {
    return failure([blocker('SIZE_CHART_EMPTY', 'size_chart', '≥1 行', '0 行', '没有尺码表无法上架（必测部位与建议区间都无来源）')]);
  }

  const issues: ValidationIssue[] = [];
  const rows: SizeChartRow[] = [];
  const sizeSystem: SizeSystem = options.sizeSystem ?? 'alpha';
  const required = requiredMeasuresFor(options.categoryCode);

  if (sizeSystem === 'one_size' && rawRows.length > 1) {
    issues.push(
      blocker('SIZE_CHART_ONE_SIZE', 'size_chart', '均码整表仅 1 行', `${rawRows.length} 行`, 'docs/19 §2：size_system=one_size 时整表只允许一行'),
    );
  }

  const seenOrders = new Map<number, string>();

  rawRows.forEach((raw, index) => {
    const row = asRecord(raw) as SizeChartRowInput | null;
    const field = `size_chart[${index}]`;
    if (!row) {
      issues.push(blocker('SIZE_CHART_TYPE', field, '对象', describeValue(raw), '尺码表行必须是对象'));
      return;
    }

    const size = normalizeSizeCode(row.skuSizeCode);
    if (size.code === null) {
      issues.push(
        blocker('SIZE_CHART_CODE', `${field}.sku_size_code`, 'docs/19 §2 词表内', describeValue(row.skuSizeCode), '尺码编码不在词表内'),
      );
      return;
    }

    let sizeOrder: number;
    const canonical = sizeOrderFor(size.code);
    const explicit = readOptionalInt(row.sizeOrder);
    if (Number.isNaN(explicit)) {
      issues.push(blocker('SIZE_CHART_ORDER', `${field}.size_order`, '0–99 的整数', describeValue(row.sizeOrder), 'size_order 必须是整数'));
      return;
    }
    if (canonical !== null) {
      sizeOrder = canonical;
      if (explicit !== null && explicit !== canonical) {
        issues.push(
          blocker(
            'SIZE_CHART_ORDER',
            `${field}.size_order`,
            String(canonical),
            String(explicit),
            `尺码 ${size.code} 的规范顺序是 ${canonical}（docs/19 §2 表）`,
          ),
        );
      }
    } else if (explicit === null) {
      issues.push(
        blocker('SIZE_CHART_ORDER', `${field}.size_order`, '显式 size_order', '缺失', '数字码必须显式给出 size_order'),
      );
      return;
    } else {
      sizeOrder = explicit;
    }
    if (sizeOrder < 0 || sizeOrder > 99) {
      issues.push(blocker('SIZE_CHART_ORDER', `${field}.size_order`, '0–99', String(sizeOrder), 'size_order 超出 smallint 约束'));
      return;
    }
    const duplicate = seenOrders.get(sizeOrder);
    if (duplicate) {
      issues.push(
        blocker('SIZE_CHART_ORDER', `${field}.size_order`, '同表唯一', `${sizeOrder}（已被 ${duplicate} 使用）`, 'size_order 决定展示顺序，同表必须唯一'),
      );
    }
    seenOrders.set(sizeOrder, size.code);

    const measurementsRaw = asRecord(row.measurements);
    if (!measurementsRaw) {
      issues.push(
        blocker('SIZE_CHART_MEASURE_KEY', `${field}.measurements`, '对象（12 个部位键）', describeValue(row.measurements), 'measurements 必须是对象'),
      );
      return;
    }
    const measurements: Partial<Record<MeasurementKey, number>> = {};
    for (const [key, value] of Object.entries(measurementsRaw)) {
      if (!MEASUREMENT_SET.has(key)) {
        issues.push(
          blocker('SIZE_CHART_MEASURE_KEY', `${field}.measurements.${key}`, MEASUREMENT_KEYS.join('|'), key, '部位名不在 12 键词表内（禁止同义名）'),
        );
        continue;
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        issues.push(blocker('SIZE_CHART_MEASURE_VALUE', `${field}.measurements.${key}`, '数字', describeValue(value), '测量值必须是数字'));
        continue;
      }
      if (num <= 0 || num > 250) {
        issues.push(blocker('SIZE_CHART_MEASURE_VALUE', `${field}.measurements.${key}`, '0 < 值 ≤ 250', String(num), '尺寸超出合理范围'));
        continue;
      }
      if (Math.round(num * 2) !== num * 2) {
        issues.push(
          blocker('SIZE_CHART_MEASURE_VALUE', `${field}.measurements.${key}`, '0.5 步进', String(num), '长度一律 cm 且 0.5 步进（docs/19 §3.1）'),
        );
        continue;
      }
      measurements[key as MeasurementKey] = num;
    }

    for (const key of required) {
      if (measurements[key] === undefined) {
        issues.push(
          blocker(
            'SIZE_CHART_REQUIRED_MEASURE',
            `${field}.measurements.${key}`,
            `类目 ${options.categoryCode} 必测：${required.join('、')}`,
            '缺失',
            '缺必测部位会被平台驳回（docs/19 §3.2 / L1-SIZE-003）',
          ),
        );
      }
    }

    const extraRaw = asRecord(row.extraMeasures) ?? {};
    const extraMeasures: Record<string, number> = {};
    for (const [key, value] of Object.entries(extraRaw)) {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) continue;
      if (key.length < 2 || key.length > 6) {
        issues.push(
          blocker('SIZE_CHART_EXTRA_KEY', `${field}.extra_measures.${key}`, '2–6 个汉字', key, 'extra_measures 键名长度受限（docs/19 §3.2）'),
        );
        continue;
      }
      extraMeasures[key] = num;
    }
    if (Object.keys(extraMeasures).length > 6) {
      issues.push(
        blocker('SIZE_CHART_EXTRA_KEY', `${field}.extra_measures`, '≤6 项', String(Object.keys(extraMeasures).length), 'extra_measures 最多 6 项'),
      );
    }

    const heightMin = readOptionalInt(row.recommendHeightMin);
    const heightMax = readOptionalInt(row.recommendHeightMax);
    const weightMin = readOptionalInt(row.recommendWeightMin);
    const weightMax = readOptionalInt(row.recommendWeightMax);
    const pairs: Array<[string, number | null, number | null]> = [
      ['recommend_height', heightMin, heightMax],
      ['recommend_weight', weightMin, weightMax],
    ];
    for (const [name, min, max] of pairs) {
      if (Number.isNaN(min) || Number.isNaN(max)) {
        issues.push(blocker('SIZE_CHART_RECOMMEND_PAIR', `${field}.${name}`, '整数或 null', '非整数', '建议区间必须是整数'));
        continue;
      }
      if ((min === null) !== (max === null)) {
        issues.push(
          blocker('SIZE_CHART_RECOMMEND_PAIR', `${field}.${name}`, '四字段成对出现', '只有一端', '建议区间必须 min/max 成对'),
        );
        continue;
      }
      if (min !== null && max !== null && min >= max) {
        issues.push(
          blocker('SIZE_CHART_RECOMMEND_DIRECTION', `${field}.${name}`, 'min < max', `${min} ≥ ${max}`, '建议区间上限必须大于下限'),
        );
      }
    }

    rows.push({
      skuSizeCode: size.code,
      sizeOrder,
      measurements,
      extraMeasures,
      recommendHeightMin: heightMin === null ? null : Number(heightMin),
      recommendHeightMax: heightMax === null ? null : Number(heightMax),
      recommendWeightMin: weightMin === null ? null : Number(weightMin),
      recommendWeightMax: weightMax === null ? null : Number(weightMax),
    });
  });

  if (issues.some((issue) => issue.severity === 'blocker')) return failure(issues);

  rows.sort((a, b) => a.sizeOrder - b.sizeOrder);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.sizeOrder <= rows[index - 1]!.sizeOrder) {
      issues.push(
        blocker(
          'SIZE_CHART_ORDER',
          'size_chart.size_order',
          '严格递增',
          `${rows[index - 1]!.sizeOrder} → ${rows[index]!.sizeOrder}`,
          '尺码表按 size_order 展示，必须严格递增',
        ),
      );
      break;
    }
  }
  return issues.some((issue) => issue.severity === 'blocker') ? failure(issues) : success(rows, issues);
}

/**
 * 建议区间衔接检查（docs/19 §4）：`min_{i+1} − max_i ∈ [−2,2]`。
 * - 负值 = 相邻码重叠（最多允许 3 个单位）；
 * - 正值 = 空档（最多允许 2 个单位）；
 * 超出即告警（不阻断上架，但会给出运营提示）。
 */
export function checkRecommendRanges(rows: readonly SizeChartRow[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sorted = [...rows].sort((a, b) => a.sizeOrder - b.sizeOrder);
  const dimensions = [
    ['height', 'recommend_height', 'recommendHeightMin', 'recommendHeightMax'],
    ['weight', 'recommend_weight', 'recommendWeightMin', 'recommendWeightMax'],
  ] as const;

  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1]!;
    const current = sorted[index]!;
    for (const [, fieldName, minKey, maxKey] of dimensions) {
      const prevMax = prev[maxKey];
      const currentMin = current[minKey];
      if (prevMax === null || currentMin === null) continue;
      const delta = currentMin - prevMax;
      if (delta < -3) {
        issues.push(
          warning(
            'SIZE_CHART_RECOMMEND_OVERLAP',
            `size_chart.${current.skuSizeCode}.${fieldName}`,
            '相邻码重叠 ≤ 3 个单位',
            `重叠 ${Math.abs(delta)}（${prev.skuSizeCode} 上限 ${prevMax} / ${current.skuSizeCode} 下限 ${currentMin}）`,
            '重叠过大时应统一话术为「重叠区建议选大一码」（docs/19 §4 重叠区口径）',
          ),
        );
      } else if (delta > 2) {
        issues.push(
          warning(
            'SIZE_CHART_RECOMMEND_GAP',
            `size_chart.${current.skuSizeCode}.${fieldName}`,
            '相邻码空档 ≤ 2 个单位',
            `空档 ${delta}（${prev.skuSizeCode} 上限 ${prevMax} / ${current.skuSizeCode} 下限 ${currentMin}）`,
            '空档过大会让部分体型没有推荐码（docs/19 §4 衔接规则）',
          ),
        );
      }
    }
  }
  return issues;
}

/**
 * 尺码表码集必须覆盖所有 active SKU 的码集（docs/19 §10 `BIZ-SIZE-001` / `L1-SIZE-004`）。
 * 返回缺失的 SKU 尺码码。
 */
export function checkSizeChartCoverage(
  chartRows: readonly SizeChartRow[],
  activeSkuSizeCodes: readonly string[],
): ValidationIssue[] {
  const chartCodes = new Set(chartRows.map((row) => row.skuSizeCode));
  const missing = [...new Set(activeSkuSizeCodes)].filter((code) => !chartCodes.has(code));
  if (missing.length === 0) return [];
  return [
    blocker(
      'SIZE_CHART_COVERAGE',
      'size_chart.sku_size_code',
      `覆盖全部 active SKU 的尺码：${[...chartCodes].join('、')}`,
      `缺少 ${missing.join('、')}`,
      '存在无尺码数据的 SKU，禁止生成上架包（docs/19 L1-SIZE-004）',
    ),
  ];
}
