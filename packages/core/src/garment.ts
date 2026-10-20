/**
 * 服装强类型校验（docs/06 §6；docs/19 §10 的三级校验 L0/L1 中可离线做的部分）。
 *
 * 纯函数：不访问 DB/网络；API/worker/前端表单共用同一实现。
 * 返回结构统一 {code, field, message, expected?, actual?}，便于 422 detail 直接展示。
 */
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import {
  FABRIC_COMPOSITION_V1,
  FACT_ENVELOPE_V1,
  PLATFORM_ATTRIBUTE_MAPPING_V1,
  PRICE_TIERS_V1,
  SIZE_CHART_V1,
} from './schema/garment.js';
import {
  FIBER_NAMES,
  MEASUREMENT_KEYS,
  isValidCategoryCode,
  normalizeFiberName,
  normalizeSizeCode,
  requiredMeasurements,
  sizeOrderFor,
} from './vocab/garment.js';
import { computeFactsHash } from './facts.js';

interface AjvLike {
  validateSchema(schema: unknown): boolean;
  compile(schema: unknown): ValidateFunction;
  errors: ErrorObject[] | null;
}

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (options?: Record<string, unknown>) => AjvLike;
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validators = new Map<string, ValidateFunction>();

export interface ValidationIssue {
  code: string;
  field: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ValidationResult<T = unknown> {
  ok: boolean;
  issues: ValidationIssue[];
  value?: T;
}

function compile(key: string, schema: unknown): ValidateFunction {
  const cached = validators.get(key);
  if (cached) return cached;
  const validator = ajv.compile(schema);
  validators.set(key, validator);
  return validator;
}

function ajvIssues(errors: ErrorObject[] | null | undefined, prefix: string, code: string): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    code,
    field: `${prefix}${error.instancePath || '/'}`,
    message: error.message ?? 'invalid',
    expected: error.params,
    actual: error.data,
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCmValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 250;
}

// ------------------------------------------------------------
// 尺码表
// ------------------------------------------------------------

export interface SizeChartInput {
  version_no?: number;
  size_system: 'alpha' | 'numeric' | 'height_weight' | 'one_size';
  unit: 'cm';
  effective_from: string;
  effective_to?: string | null;
  source: 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier';
  fit_note?: string;
  sizes: Array<Record<string, unknown>>;
}

/** 归一：2XL→XXL、均码→ONE；缺 size_order 时按词表补。 */
export function normalizeSizeChartInput(input: unknown): SizeChartInput {
  const raw = isPlainObject(input) ? input : {};
  const sizes = Array.isArray(raw.sizes) ? raw.sizes : [];
  const normalized = sizes.map((entry) => {
    const size = isPlainObject(entry) ? { ...entry } : {};
    const code = typeof size.sku_size_code === 'string'
      ? normalizeSizeCode(size.sku_size_code)
      : typeof size.size_code === 'string'
        ? normalizeSizeCode(size.size_code)
        : '';
    delete size.size_code;
    const order =
      typeof size.size_order === 'number' ? size.size_order : sizeOrderFor(code);
    return {
      ...size,
      sku_size_code: code,
      size_order: order,
      measurements: isPlainObject(size.measurements) ? size.measurements : {},
    };
  });
  return {
    version_no: typeof raw.version_no === 'number' ? raw.version_no : 1,
    size_system: (raw.size_system as SizeChartInput['size_system']) ?? 'alpha',
    unit: 'cm',
    effective_from: String(raw.effective_from ?? '').slice(0, 10),
    effective_to: raw.effective_to === null || raw.effective_to === undefined
      ? null
      : String(raw.effective_to).slice(0, 10),
    source: (raw.source as SizeChartInput['source']) ?? 'manual',
    ...(typeof raw.fit_note === 'string' ? { fit_note: raw.fit_note } : {}),
    sizes: normalized,
  };
}

export function validateSizeChart(
  input: unknown,
  options: { categoryCode?: string } = {},
): ValidationResult<SizeChartInput> {
  const normalized = normalizeSizeChartInput(input);
  const issues: ValidationIssue[] = [];
  const validate = compile('size-chart-v1', SIZE_CHART_V1);
  if (!validate(normalized)) {
    issues.push(...ajvIssues(validate.errors, 'size_chart', 'SCHEMA-001'));
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(normalized.effective_from) || Number.isNaN(Date.parse(normalized.effective_from))) {
    issues.push({ code: 'SCHEMA-001', field: 'effective_from', message: '生效日期必须是 ISO8601 日期' });
  }
  if (normalized.effective_to && Number.isNaN(Date.parse(normalized.effective_to))) {
    issues.push({ code: 'SCHEMA-001', field: 'effective_to', message: '失效日期必须是 ISO8601 日期' });
  }
  if (normalized.effective_to && Date.parse(normalized.effective_to) <= Date.parse(normalized.effective_from)) {
    issues.push({ code: 'BIZ-SIZE-004', field: 'effective_to', message: 'effective_to 必须晚于 effective_from' });
  }
  if (normalized.size_system === 'one_size' && normalized.sizes.length !== 1) {
    issues.push({ code: 'SCHEMA-002', field: 'sizes', message: 'one_size 尺码表只能有 1 行' });
  }
  if (options.categoryCode && !isValidCategoryCode(options.categoryCode)) {
    issues.push({ code: 'SCHEMA-001', field: 'category_code', message: '类目编码格式非法' });
  }

  const codes = new Set<string>();
  const orders = new Set<number>();
  for (let index = 0; index < normalized.sizes.length; index += 1) {
    const size = normalized.sizes[index]!;
    const prefix = `sizes[${index}]`;
    const sizeCode = String(size.sku_size_code ?? '');
    const sizeOrder = Number(size.size_order ?? 0);
    if (codes.has(sizeCode)) {
      issues.push({ code: 'SCHEMA-002', field: `${prefix}.sku_size_code`, message: `尺码重复：${sizeCode}` });
    }
    codes.add(sizeCode);
    if (orders.has(sizeOrder)) {
      issues.push({ code: 'BIZ-SIZE-003', field: `${prefix}.size_order`, message: 'size_order 必须唯一' });
    }
    orders.add(sizeOrder);

    const measurements = size.measurements as Record<string, unknown>;
    for (const [part, value] of Object.entries(measurements)) {
      if (!(MEASUREMENT_KEYS as readonly string[]).includes(part)) {
        issues.push({ code: 'SCHEMA-003', field: `${prefix}.measurements.${part}`, message: `部位名不在 12 键词表：${part}` });
      }
      if (!isCmValue(value)) {
        issues.push({ code: 'SCHEMA-003', field: `${prefix}.measurements.${part}`, message: '测量值必须 >0、≤250 且 0.5 步进' });
      } else if (Math.round(Number(value) * 2) !== Number(value) * 2) {
        issues.push({ code: 'SCHEMA-003', field: `${prefix}.measurements.${part}`, message: '测量值必须 0.5 步进' });
      }
    }

    const required = options.categoryCode ? requiredMeasurements(options.categoryCode) : [];
    const missing = required.filter((part) => measurements[part] === undefined);
    if (missing.length > 0) {
      issues.push({
        code: 'BIZ-SIZE-002',
        field: `${prefix}.measurements`,
        message: `缺少品类必测部位：${missing.join('、')}`,
        expected: missing,
      });
    }

    const hMin = size.recommend_height_min;
    const hMax = size.recommend_height_max;
    const wMin = size.recommend_weight_min;
    const wMax = size.recommend_weight_max;
    if ((hMin === undefined) !== (hMax === undefined)) {
      issues.push({ code: 'BIZ-SIZE-003', field: `${prefix}`, message: '身高区间必须成对出现' });
    }
    if ((wMin === undefined) !== (wMax === undefined)) {
      issues.push({ code: 'BIZ-SIZE-003', field: `${prefix}`, message: '体重区间必须成对出现' });
    }
    if (typeof hMin === 'number' && typeof hMax === 'number' && hMax <= hMin) {
      issues.push({ code: 'BIZ-SIZE-003', field: `${prefix}.recommend_height_max`, message: '身高区间上限必须大于下限' });
    }
    if (typeof wMin === 'number' && typeof wMax === 'number' && wMax <= wMin) {
      issues.push({ code: 'BIZ-SIZE-003', field: `${prefix}.recommend_weight_max`, message: '体重区间上限必须大于下限' });
    }
  }

  // 按 size_order 排序检查建议区间单调与衔接
  const sorted = [...normalized.sizes].sort((a, b) => Number(a.size_order) - Number(b.size_order));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    for (const [minKey, maxKey] of [
      ['recommend_height_min', 'recommend_height_max'],
      ['recommend_weight_min', 'recommend_weight_max'],
    ] as const) {
      const prevMax = previous[maxKey];
      const currentMin = current[minKey];
      if (typeof prevMax === 'number' && typeof currentMin === 'number') {
        if (currentMin <= prevMax - 2 || currentMin > prevMax + 2) {
          issues.push({
            code: 'BIZ-SIZE-003',
            field: `sizes[${index}].${minKey}`,
            message: '相邻码建议区间空档/重叠过大',
            actual: { previous_max: prevMax, current_min: currentMin },
          });
        }
      }
      const prevMin = previous[minKey];
      const currentMax = current[maxKey];
      if (
        typeof prevMin === 'number' &&
        typeof prevMax === 'number' &&
        typeof currentMin === 'number' &&
        typeof currentMax === 'number'
      ) {
        if (currentMin <= prevMin || currentMax <= prevMax) {
          issues.push({
            code: 'BIZ-SIZE-003',
            field: `sizes[${index}]`,
            message: '按 size_order 建议区间必须严格递增',
          });
        }
      }
    }
  }
  if (normalized.sizes.length > 1) {
    const heights = sorted
      .map((size) => size.recommend_height_min)
      .filter((value): value is number => typeof value === 'number');
    const weights = sorted
      .map((size) => size.recommend_weight_min)
      .filter((value): value is number => typeof value === 'number');
    if (heights.length >= 2 && heights[heights.length - 1]! - heights[0]! < 20) {
      issues.push({ code: 'BIZ-SIZE-003', field: 'sizes', message: '建议身高覆盖跨度过窄（<20cm）' });
    }
    if (weights.length >= 2 && weights[weights.length - 1]! - weights[0]! < 15) {
      issues.push({ code: 'BIZ-SIZE-003', field: 'sizes', message: '建议体重覆盖跨度过窄（<15kg）' });
    }
  }

  return issues.length === 0
    ? { ok: true, issues: [], value: normalized }
    : { ok: false, issues };
}

// ------------------------------------------------------------
// 面料成分
// ------------------------------------------------------------

export interface FabricMaterial {
  material: string;
  percent: number;
  note?: string;
  fiber_code?: string;
}

export function normalizeFabricComposition(input: unknown): FabricMaterial[] {
  const list = Array.isArray(input) ? input : [];
  return list.map((entry) => {
    const item = isPlainObject(entry) ? entry : {};
    return {
      ...(typeof item.material === 'string' ? { material: normalizeFiberName(item.material) } : {}),
      ...(typeof item.percent === 'number' ? { percent: item.percent } : {}),
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      ...(typeof item.fiber_code === 'string' ? { fiber_code: item.fiber_code } : {}),
    } as FabricMaterial;
  });
}

export function validateFabricComposition(input: unknown): ValidationResult<FabricMaterial[]> {
  const normalized = normalizeFabricComposition(input);
  const issues: ValidationIssue[] = [];
  const validate = compile('fabric-v1', FABRIC_COMPOSITION_V1);
  if (!validate(normalized)) {
    issues.push(...ajvIssues(validate.errors, 'fabric', 'SCHEMA-001'));
  }
  const sum = normalized.reduce(
    (total, item) => total + (typeof item.percent === 'number' ? item.percent : 0),
    0,
  );
  if (sum !== 100) {
    issues.push({
      code: 'SCHEMA-004',
      field: 'fabric',
      message: '成分百分比合计必须等于 100',
      expected: 100,
      actual: sum,
    });
  }
  const names = new Set<string>();
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index]!;
    if (!(FIBER_NAMES as readonly string[]).includes(item.material)) {
      issues.push({
        code: 'BIZ-FAB-001',
        field: `fabric[${index}].material`,
        message: `纤维名称不在标准词表：${item.material}`,
      });
    }
    if (names.has(item.material)) {
      issues.push({
        code: 'SCHEMA-004',
        field: `fabric[${index}].material`,
        message: `纤维重复：${item.material}`,
      });
    }
    names.add(item.material);
  }
  for (let index = 1; index < normalized.length; index += 1) {
    if ((normalized[index]!.percent ?? 0) > (normalized[index - 1]!.percent ?? 0)) {
      issues.push({
        code: 'SCHEMA-004',
        field: `fabric[${index}].percent`,
        message: '成分必须按占比降序排列',
      });
    }
  }
  return issues.length === 0 ? { ok: true, issues: [], value: normalized } : { ok: false, issues };
}

export function fabricText(materials: FabricMaterial[]): string {
  return materials.map((item) => `${item.material}${item.percent}%`).join('、');
}

// ------------------------------------------------------------
// 平台属性映射
// ------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePlatformAttributeMapping(input: unknown): ValidationResult<Record<string, unknown>> {
  const value = isPlainObject(input) ? { ...input } : {};
  const issues: ValidationIssue[] = [];
  const validate = compile('pam-v1', PLATFORM_ATTRIBUTE_MAPPING_V1);
  if (!validate(value)) {
    issues.push(...ajvIssues(validate.errors, 'mapping', 'SCHEMA-001'));
  }
  for (const key of ['platform_category_id', 'product_id', 'sku_id'] as const) {
    const id = value[key];
    if (typeof id === 'string' && !UUID_RE.test(id)) {
      issues.push({ code: 'SCHEMA-005', field: `mapping.${key}`, message: '必须是 UUID' });
    }
  }
  if (value.attr_type === 'range') {
    const extra = isPlainObject(value.extra) ? value.extra : {};
    if (typeof extra.min !== 'number' || typeof extra.max !== 'number' || extra.max <= extra.min) {
      issues.push({ code: 'SCHEMA-005', field: 'mapping.extra', message: 'range 映射必须带合法 min/max' });
    }
  }
  if ((value.attr_type === 'enum' || value.attr_type === 'multi_enum') && !value.platform_value_id) {
    issues.push({ code: 'SCHEMA-005', field: 'mapping.platform_value_id', message: 'enum 映射必须有 platform_value_id' });
  }
  if (value.status === 'verified' && !value.platform_value_id && value.attr_type !== 'text') {
    issues.push({ code: 'SCHEMA-005', field: 'mapping.platform_value_id', message: 'verified 映射必须有平台值' });
  }
  return issues.length === 0
    ? { ok: true, issues: [], value }
    : { ok: false, issues };
}

// ------------------------------------------------------------
// 事实信封 / 阶梯价
// ------------------------------------------------------------

export function validateFactEnvelope(input: unknown): ValidationResult<Record<string, unknown>> {
  const value = isPlainObject(input) ? { ...input } : {};
  const issues: ValidationIssue[] = [];
  const validate = compile('fact-v1', FACT_ENVELOPE_V1);
  if (!validate(value)) {
    issues.push(...ajvIssues(validate.errors, 'facts', 'SCHEMA-001'));
  }
  if (typeof value.facts_hash === 'string' && value.facts_hash.length === 64) {
    const expected = computeFactsHash({
      facts_version: Number(value.facts_version ?? 1),
      captured_at: String(value.captured_at ?? ''),
      items: Array.isArray(value.items) ? value.items : [],
    });
    if (expected !== value.facts_hash) {
      issues.push({
        code: 'INVALID-FACT-001',
        field: 'facts.facts_hash',
        message: 'facts_hash 与事实内容不一致（事实已变更）',
        expected,
        actual: value.facts_hash,
      });
    }
  }
  return issues.length === 0 ? { ok: true, issues: [], value } : { ok: false, issues };
}

export interface PriceTier {
  min_qty: number;
  price_cents: number;
  max_qty?: number | null;
}

export function validatePriceTiers(input: unknown, minOrderQty = 1): ValidationResult<PriceTier[]> {
  const list = Array.isArray(input) ? input : [];
  const issues: ValidationIssue[] = [];
  const validate = compile('price-tiers-v1', PRICE_TIERS_V1);
  if (!validate(list)) {
    issues.push(...ajvIssues(validate.errors, 'price_tiers', 'SCHEMA-001'));
  }
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1] as PriceTier;
    const current = list[index] as PriceTier;
    if (current.min_qty <= previous.min_qty) {
      issues.push({ code: 'BIZ-PRC-004', field: `price_tiers[${index}].min_qty`, message: 'min_qty 必须严格递增' });
    }
    if (current.price_cents > previous.price_cents) {
      issues.push({ code: 'BIZ-PRC-004', field: `price_tiers[${index}].price_cents`, message: 'price_cents 必须单调不增' });
    }
  }
  if (list.length > 0 && (list[0] as PriceTier).min_qty !== minOrderQty) {
    issues.push({
      code: 'BIZ-PRC-004',
      field: 'price_tiers[0].min_qty',
      message: '首档 min_qty 必须等于 min_order_qty',
      expected: minOrderQty,
      actual: (list[0] as PriceTier).min_qty,
    });
  }
  return issues.length === 0 ? { ok: true, issues: [], value: list as PriceTier[] } : { ok: false, issues };
}
