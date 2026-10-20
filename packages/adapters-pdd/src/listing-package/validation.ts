/**
 * 上架包硬事实校验（对齐 docs/19 尺码/成分规范、docs/21 §6 字段口径）。
 *
 * 只做确定性校验，不调用模型、不猜平台规则：
 * - 尺码词表封闭，别名归一（2XL→XXL、均码→ONE…），6XL/FREE/均码加大 一律拒绝；
 * - 成分百分比为整数且合计 100；
 * - 价格/库存为整数分/整数件；
 * - 每个 SKU 必须有对应尺码行；同 (color_id,size_code,fabric_id) 不得重复。
 *
 * 警告（不阻断导出）：资质未知、缺主图、尺码行未被 SKU 使用等。
 */

import type {
  ListingPackageIssue,
  ListingProductInput,
  NormalizedFabricItem,
  NormalizedListingProduct,
  NormalizedSizeRow,
  NormalizedSku,
} from './types.js';

export const ALLOWED_SIZE_CODES = [
  'XXXS',
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  '4XL',
  '5XL',
  'ONE',
] as const;

export const SIZE_ALIASES: Record<string, string> = {
  '2XL': 'XXL',
  '3XL': 'XXXL',
  加大: 'XL',
  加加大: 'XXL',
  特小: 'XS',
  均码: 'ONE',
  自由码: 'ONE',
  F: 'ONE',
  Free: 'ONE',
};

export const ALLOWED_MEASUREMENTS = [
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

export const ALLOWED_FITS = ['slim', 'regular', 'loose', 'oversize'] as const;

const CATEGORY_RE = /^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/;
const NUMERIC_SIZE_RE = /^[0-9]{2,3}$/;

export class ListingPackageValidationError extends Error {
  readonly issues: ListingPackageIssue[];

  constructor(issues: ListingPackageIssue[]) {
    const errors = issues.filter((issue) => issue.severity === 'error');
    super(`上架包校验失败（${errors.length} 个错误）：\n- ${errors.map((issue) => `${issue.code} @ ${issue.field}: ${issue.message}`).join('\n- ')}`);
    this.name = 'ListingPackageValidationError';
    this.issues = issues;
  }
}

export function normalizeSizeCode(raw: string): string | null {
  const trimmed = raw.normalize('NFC').trim();
  if (trimmed === '') return null;
  const alias = SIZE_ALIASES[trimmed] ?? SIZE_ALIASES[trimmed.toUpperCase()];
  if (alias) return alias;
  const upper = trimmed.toUpperCase();
  if ((ALLOWED_SIZE_CODES as readonly string[]).includes(upper)) return upper;
  if (NUMERIC_SIZE_RE.test(trimmed)) return trimmed;
  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function pushIssue(
  issues: ListingPackageIssue[],
  code: string,
  severity: ListingPackageIssue['severity'],
  field: string,
  message: string,
  row?: number,
): void {
  issues.push({ code, severity, field, message, ...(row !== undefined ? { row } : {}) });
}

function normalizeMeasurements(
  measurements: Record<string, number>,
  issues: ListingPackageIssue[],
  row: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(measurements)) {
    if (!(ALLOWED_MEASUREMENTS as readonly string[]).includes(key)) {
      pushIssue(issues, 'measurement_key_invalid', 'error', `size_chart[${row}].measurements.${key}`, `部位键 "${key}" 不在 docs/19 §3 的 12 个允许键内`, row);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      pushIssue(issues, 'measurement_value_invalid', 'error', `size_chart[${row}].measurements.${key}`, `测量值必须是正数，实际 ${String(value)}`, row);
      continue;
    }
    if (Math.abs(value * 2 - Math.round(value * 2)) > 1e-9) {
      pushIssue(issues, 'measurement_step_invalid', 'error', `size_chart[${row}].measurements.${key}`, `测量值必须按 0.5cm 步进，实际 ${value}`, row);
      continue;
    }
    out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    pushIssue(issues, 'measurement_empty', 'error', `size_chart[${row}].measurements`, '尺码行至少需要一个有效测量值', row);
  }
  return out;
}

function checkRecommendPair(
  min: number | undefined,
  max: number | undefined,
  label: string,
  issues: ListingPackageIssue[],
  row: number,
): [number | null, number | null] {
  const hasMin = min !== undefined;
  const hasMax = max !== undefined;
  if (hasMin !== hasMax) {
    pushIssue(issues, 'recommend_pair_incomplete', 'error', `size_chart[${row}]`, `${label} 的 min/max 必须成对出现（docs/19 §4）`, row);
    return [min ?? null, max ?? null];
  }
  if (!hasMin && !hasMax) return [null, null];
  if (typeof min !== 'number' || typeof max !== 'number' || min > max) {
    pushIssue(issues, 'recommend_range_invalid', 'error', `size_chart[${row}]`, `${label} 区间非法：min=${String(min)} max=${String(max)}`, row);
    return [min ?? null, max ?? null];
  }
  return [min, max];
}

export function validateAndNormalizeProduct(input: ListingProductInput): {
  product: NormalizedListingProduct;
  issues: ListingPackageIssue[];
} {
  const issues: ListingPackageIssue[] = [];

  const spu = typeof input.spu_code === 'string' ? input.spu_code.trim() : '';
  if (spu === '') pushIssue(issues, 'missing_required_field', 'error', 'spu_code', 'spu_code 必填');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '') pushIssue(issues, 'missing_required_field', 'error', 'name', '商品名必填');
  const category = typeof input.category_code === 'string' ? input.category_code.trim() : '';
  if (!CATEGORY_RE.test(category)) {
    pushIssue(issues, 'category_code_invalid', 'error', 'category_code', `category_code 必须匹配 ${CATEGORY_RE.source}（docs/19 §3.2），实际 "${category}"`);
  }
  const fit = typeof input.fit === 'string' && input.fit.trim() !== '' ? input.fit.trim() : null;
  if (fit !== null && !(ALLOWED_FITS as readonly string[]).includes(fit)) {
    pushIssue(issues, 'fit_invalid', 'error', 'fit', `fit 只能是 ${ALLOWED_FITS.join('|')}，实际 "${fit}"`);
  }

  /* ---------------- size chart ---------------- */
  const sizeChart: NormalizedSizeRow[] = [];
  const sizeSeen = new Set<string>();
  const rawSizeChart = Array.isArray(input.size_chart) ? input.size_chart : [];
  rawSizeChart.forEach((row, index) => {
    const normalized = typeof row.sku_size_code === 'string' ? normalizeSizeCode(row.sku_size_code) : null;
    if (normalized === null) {
      pushIssue(issues, 'size_code_invalid', 'error', `size_chart[${index}].sku_size_code`, `尺码编码 "${String(row.sku_size_code)}" 不在封闭词表内（docs/19 §2）`, index + 1);
      return;
    }
    if (sizeSeen.has(normalized)) {
      pushIssue(issues, 'size_code_duplicate', 'error', `size_chart[${index}].sku_size_code`, `尺码 ${normalized} 在尺码表中重复`, index + 1);
      return;
    }
    sizeSeen.add(normalized);
    const measurements = row.measurements && typeof row.measurements === 'object' ? row.measurements : {};
    const [heightMin, heightMax] = checkRecommendPair(row.recommend_height_min, row.recommend_height_max, '建议身高', issues, index + 1);
    const [weightMin, weightMax] = checkRecommendPair(row.recommend_weight_min, row.recommend_weight_max, '建议体重', issues, index + 1);
    sizeChart.push({
      sku_size_code: normalized,
      size_order: isPositiveInt(row.size_order) ? row.size_order : index + 1,
      measurements: normalizeMeasurements(measurements, issues, index + 1),
      recommend_height_min: heightMin,
      recommend_height_max: heightMax,
      recommend_weight_min: weightMin,
      recommend_weight_max: weightMax,
    });
  });
  if (sizeChart.length === 0) {
    pushIssue(issues, 'size_chart_empty', 'error', 'size_chart', '尺码表至少需要一行（docs/19 §2）');
  }
  if (sizeChart.some((row) => row.sku_size_code === 'ONE') && (sizeChart.length !== 1 || rawSizeChart.length !== 1)) {
    pushIssue(issues, 'one_size_multiple_rows', 'error', 'size_chart', 'ONE（均码）时尺码表只能有 1 行（docs/19 §2）');
  }
  const sizeOrders = sizeChart.map((row) => row.size_order);
  if (new Set(sizeOrders).size !== sizeOrders.length) {
    pushIssue(issues, 'size_order_duplicate', 'error', 'size_chart', 'size_order 必须唯一（docs/19 §2）');
  }

  /* ---------------- SKUs ---------------- */
  const skus: NormalizedSku[] = [];
  const skuSeen = new Set<string>();
  const skuCodes = new Set<string>();
  const rawSkus = Array.isArray(input.skus) ? input.skus : [];
  rawSkus.forEach((sku, index) => {
    const row = index + 1;
    const colorId = typeof sku.color_id === 'string' ? sku.color_id.trim() : '';
    if (colorId === '') pushIssue(issues, 'missing_required_field', 'error', `skus[${index}].color_id`, 'color_id 必填', row);
    const sizeCode = typeof sku.size_code === 'string' ? normalizeSizeCode(sku.size_code) : null;
    if (sizeCode === null) {
      pushIssue(issues, 'size_code_invalid', 'error', `skus[${index}].size_code`, `SKU 尺码 "${String(sku.size_code)}" 不在封闭词表内`, row);
      return;
    }
    if (!isPositiveInt(sku.price_cents)) {
      pushIssue(issues, 'invalid_price', 'error', `skus[${index}].price_cents`, `price_cents 必须是正整数（分），实际 ${String(sku.price_cents)}`, row);
    }
    if (sku.list_price_cents !== undefined && sku.list_price_cents !== null && !isPositiveInt(sku.list_price_cents)) {
      pushIssue(issues, 'invalid_price', 'error', `skus[${index}].list_price_cents`, `list_price_cents 必须是正整数（分），实际 ${String(sku.list_price_cents)}`, row);
    }
    if (sku.sale_price_cents !== undefined && sku.sale_price_cents !== null) {
      if (!isPositiveInt(sku.sale_price_cents)) {
        pushIssue(issues, 'invalid_price', 'error', `skus[${index}].sale_price_cents`, `sale_price_cents 必须是正整数（分），实际 ${String(sku.sale_price_cents)}`, row);
      } else if (isPositiveInt(sku.price_cents) && sku.sale_price_cents > sku.price_cents) {
        pushIssue(issues, 'sale_price_above_price', 'error', `skus[${index}].sale_price_cents`, `促销价 ${sku.sale_price_cents} 不能高于售价 ${sku.price_cents}`, row);
      }
    }
    if (!isNonNegativeInt(sku.stock_qty)) {
      pushIssue(issues, 'invalid_stock', 'error', `skus[${index}].stock_qty`, `stock_qty 必须是非负整数，实际 ${String(sku.stock_qty)}`, row);
    }
    const fabricId = typeof sku.fabric_id === 'string' && sku.fabric_id.trim() !== '' ? sku.fabric_id.trim() : null;
    const tuple = `${colorId}|${sizeCode}|${fabricId ?? ''}`;
    if (skuSeen.has(tuple)) {
      pushIssue(issues, 'duplicate_sku', 'error', `skus[${index}]`, `SKU 组合重复：color_id=${colorId} size=${sizeCode} fabric=${fabricId ?? '-'}`, row);
      return;
    }
    skuSeen.add(tuple);
    if (!sizeSeen.has(sizeCode)) {
      pushIssue(issues, 'size_chart_missing', 'error', `skus[${index}].size_code`, `SKU 尺码 ${sizeCode} 在尺码表中不存在`, row);
    }
    const skuCode =
      typeof sku.sku_code === 'string' && sku.sku_code.trim() !== ''
        ? sku.sku_code.trim()
        : `${spu || 'SPU'}-${colorId || 'COLOR'}-${sizeCode}`;
    if (skuCodes.has(skuCode)) {
      pushIssue(issues, 'sku_code_duplicate', 'error', `skus[${index}].sku_code`, `sku_code 重复：${skuCode}`, row);
    }
    skuCodes.add(skuCode);
    skus.push({
      sku_id: typeof sku.sku_id === 'string' && sku.sku_id.trim() !== '' ? sku.sku_id.trim() : `sku_${index + 1}`,
      sku_code: skuCode,
      color_id: colorId,
      color_name: typeof sku.color_name === 'string' && sku.color_name.trim() !== '' ? sku.color_name.trim() : colorId,
      size_code: sizeCode,
      size_order: sizeChart.find((item) => item.sku_size_code === sizeCode)?.size_order ?? index + 100,
      fabric_id: fabricId,
      price_cents: isPositiveInt(sku.price_cents) ? sku.price_cents : 0,
      list_price_cents: isPositiveInt(sku.list_price_cents) ? sku.list_price_cents : null,
      sale_price_cents: isPositiveInt(sku.sale_price_cents) ? sku.sale_price_cents : null,
      stock_qty: isNonNegativeInt(sku.stock_qty) ? sku.stock_qty : 0,
    });
  });
  if (skus.length === 0) pushIssue(issues, 'sku_empty', 'error', 'skus', '至少需要一个 SKU');

  const usedSizes = new Set(skus.map((sku) => sku.size_code));
  for (const row of sizeChart) {
    if (!usedSizes.has(row.sku_size_code)) {
      pushIssue(issues, 'size_without_sku', 'warning', 'size_chart', `尺码 ${row.sku_size_code} 没有对应 SKU，导入后可能是空规格`, undefined);
    }
  }

  /* ---------------- fabric ---------------- */
  const fabric: NormalizedFabricItem[] = [];
  const rawFabric = Array.isArray(input.fabric) ? input.fabric : [];
  let percentSum = 0;
  rawFabric.forEach((item, index) => {
    const material = typeof item.material === 'string' ? item.material.trim() : '';
    if (material === '') pushIssue(issues, 'fabric_material_empty', 'error', `fabric[${index}].material`, '材质名称必填', index + 1);
    if (!Number.isInteger(item.percent) || item.percent <= 0 || item.percent > 100) {
      pushIssue(issues, 'fabric_percent_invalid', 'error', `fabric[${index}].percent`, `成分百分比必须是 1..100 的整数，实际 ${String(item.percent)}`, index + 1);
    } else {
      percentSum += item.percent;
    }
    fabric.push({
      material,
      percent: item.percent,
      note: typeof item.note === 'string' && item.note.trim() !== '' ? item.note.trim() : null,
      fiber_code: typeof item.fiber_code === 'string' && item.fiber_code.trim() !== '' ? item.fiber_code.trim() : null,
    });
  });
  if (fabric.length === 0) {
    pushIssue(issues, 'fabric_missing', 'error', 'fabric', '面料成分必填（docs/19 §3、平台上架资质要求）');
  } else if (percentSum !== 100) {
    pushIssue(issues, 'fabric_sum_invalid', 'error', 'fabric', `成分百分比合计必须为 100，实际 ${percentSum}`);
  }

  /* ---------------- attributes / media / qualification ---------------- */
  const attributes = (Array.isArray(input.attributes) ? input.attributes : [])
    .filter((item) => typeof item?.attr_path === 'string' && item.attr_path.trim() !== '')
    .map((item) => ({
      attr_path: item.attr_path.trim(),
      internal_value: typeof item.internal_value === 'string' ? item.internal_value.trim() : String(item.internal_value ?? ''),
      platform_value_id:
        typeof item.platform_value_id === 'string' && item.platform_value_id.trim() !== '' ? item.platform_value_id.trim() : null,
    }));
  if (attributes.length === 0) {
    pushIssue(issues, 'attributes_empty', 'warning', 'attributes', '未提供平台属性映射；导入前需补齐类目必填属性（docs/19 §10 L2）');
  }

  const main = typeof input.media?.main === 'string' && input.media.main.trim() !== '' ? input.media.main.trim() : null;
  if (main === null) {
    pushIssue(issues, 'media_main_missing', 'warning', 'media.main', '缺主图；导入前需补主图且必须为实拍（docs/00 §1.3）');
  }
  const gallery = (input.media?.gallery ?? []).filter((item): item is string => typeof item === 'string' && item.trim() !== '');

  const qualification = {
    report_no: textOrNull(input.qualification?.report_no),
    safety_class: textOrNull(input.qualification?.safety_class),
    brand: textOrNull(input.qualification?.brand),
    manufacturer: textOrNull(input.qualification?.manufacturer),
  };
  if (Object.values(qualification).every((value) => value === null)) {
    pushIssue(
      issues,
      'qualification_unknown',
      'warning',
      'qualification',
      '资质未知（质检报告/安全类别/品牌/生产商）：按 docs/01 G1 不得进入上架草稿；导入前必须补齐',
    );
  }

  const product: NormalizedListingProduct = {
    product_id: typeof input.product_id === 'string' && input.product_id.trim() !== '' ? input.product_id.trim() : `product_${spu || 'unknown'}`,
    spu_code: spu,
    name,
    category_code: category,
    fit,
    description: textOrNull(input.description),
    skus,
    size_chart: sizeChart,
    fabric,
    attributes,
    media: { main, gallery },
    qualification,
    data_origin: input.data_origin ?? 'master_data',
  };
  return { product, issues };
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 有 error 级别的 issue 即视为不可导出。 */
export function hasBlockingIssues(issues: readonly ListingPackageIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}
