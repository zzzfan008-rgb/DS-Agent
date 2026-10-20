/**
 * 规格（颜色 × 尺码）与 1688 规格属性映射 —— docs/19 §1、§2、§9。
 *
 * 做什么：
 * 1. 把 SKU 列表归一成「规格轴」：颜色按 `color_id` 排序、尺码按 `size_order` 排序；
 * 2. 把 SKU 排成「颜色 × 尺码」矩阵，缺组合不报错（服装不可能全码都备货），
 *    但重复组合（同一颜色同一尺码两个 SKU）必须报错；
 * 3. 尺码别名归一（`2XL→XXL`、`均码→ONE`）与非法码拒绝（`6XL`/`FREE`/`均码加大`）；
 * 4. 输出平台映射值占位：**平台色卡 id / 尺码 id 一律为 null**（`TODO-1688-006/009`），
 *    状态恒为 `draft`，禁止进入发布报文（docs/19 §0.2 铁律 5）。
 */

import {
  asRecord,
  blocker,
  describeValue,
  warning,
  type ValidationIssue,
} from '../validation.js';

/** 字母码的规范顺序（docs/19 §2；`XXXS/XXS` 的 order 为本包补充，与 XS=30 连续）。 */
export const ALPHA_SIZE_ORDER: Readonly<Record<string, number>> = {
  XXXS: 10,
  XXS: 20,
  XS: 30,
  S: 40,
  M: 50,
  L: 60,
  XL: 70,
  XXL: 80,
  XXXL: 90,
  '4XL': 95,
  '5XL': 99,
};

/** 均码单独一档（`size_system='one_size'`）。 */
export const ONE_SIZE_ORDER = 0;

/** 别名归一（docs/19 §2，导入层职责）。 */
export const SIZE_ALIASES: Readonly<Record<string, string>> = {
  '2XL': 'XXL',
  '3XL': 'XXXL',
  加大: 'XL',
  加加大: 'XXL',
  特小: 'XS',
  均码: 'ONE',
  自由码: 'ONE',
  F: 'ONE',
};

/** 明确拒绝的历史写法（docs/19 §2：无法入库）。 */
export const REJECTED_SIZE_CODES: readonly string[] = ['6XL', '7XL', 'FREE', '均码加大'];

const ALPHA_SET = new Set(Object.keys(ALPHA_SIZE_ORDER));
const NUMERIC_RE = /^[0-9]{2,3}$/;
const COLOR_RE = /^[A-Z]{2}-[0-9]{4}$/;
const LEGACY_COLOR_RE = /^[A-Z]{2}[0-9]{4}$/;

export interface SizeCodeResolution {
  /** 归一后的规范码；非法时为 `null`。 */
  code: string | null;
  /** 原值（发生归一/拒绝时用于提示）。 */
  raw: string;
  /** 是否发生别名归一。 */
  aliased: boolean;
}

/** 尺码码归一：去空格、大写、别名替换、正则校验（docs/19 §2）。 */
export function normalizeSizeCode(raw: unknown): SizeCodeResolution {
  if (typeof raw !== 'string') return { code: null, raw: describeValue(raw), aliased: false };
  const trimmed = raw.trim().toUpperCase();
  const aliasedCode = SIZE_ALIASES[trimmed] ?? SIZE_ALIASES[raw.trim()];
  if (aliasedCode) {
    return { code: aliasedCode, raw, aliased: true };
  }
  if (ALPHA_SET.has(trimmed) || trimmed === 'ONE' || NUMERIC_RE.test(trimmed)) {
    return { code: trimmed, raw, aliased: false };
  }
  return { code: null, raw, aliased: false };
}

/** 尺码排序值；数字码必须由尺码表显式给出（docs/19 与 smallint 0–99 的冲突见 README）。 */
export function sizeOrderFor(code: string): number | null {
  if (code === 'ONE') return ONE_SIZE_ORDER;
  if (Object.hasOwn(ALPHA_SIZE_ORDER, code)) return ALPHA_SIZE_ORDER[code]!;
  return null;
}

export interface ColorCodeResolution {
  code: string | null;
  raw: string;
  /** 历史无连字符编码：只读兼容，新数据禁止（docs/19 §1）。 */
  legacy: boolean;
}

/** 内部色卡编码归一：`BK-0101` 合法；`BK0101` 兼容但告警。 */
export function normalizeColorCode(raw: unknown): ColorCodeResolution {
  if (typeof raw !== 'string') return { code: null, raw: describeValue(raw), legacy: false };
  const trimmed = raw.trim().toUpperCase();
  if (COLOR_RE.test(trimmed)) return { code: trimmed, raw, legacy: false };
  if (LEGACY_COLOR_RE.test(trimmed)) {
    return { code: `${trimmed.slice(0, 2)}-${trimmed.slice(2)}`, raw, legacy: true };
  }
  return { code: null, raw, legacy: false };
}

export interface SpecSkuInput {
  skuCode: string;
  colorId: string;
  colorName: string;
  sizeCode: string;
  /** 显式排序（数字码必须给；字母码缺省取规范顺序）。 */
  sizeOrder?: number;
  minOrderQty?: number;
  priceCents?: number;
  status?: 'active' | 'inactive';
}

export interface SpecValue {
  value: string;
  label: string;
  order: number;
  /** 平台值 id 一律未知（TODO-1688-006/009）。 */
  platformValueId: null;
  mappingStatus: 'draft';
}

export interface SpecAxis {
  axis: 'color' | 'size';
  values: SpecValue[];
}

export interface SpecMatrixCell {
  colorId: string;
  sizeCode: string;
  skuCode: string | null;
  minOrderQty: number | null;
  priceCents: number | null;
}

export interface NormalizedSpecSku {
  skuCode: string;
  colorId: string;
  colorName: string;
  sizeCode: string;
  sizeOrder: number;
  minOrderQty: number | null;
  priceCents: number | null;
  status: 'active' | 'inactive';
}

export interface SpecBuildResult {
  ok: boolean;
  skus: NormalizedSpecSku[];
  axes: SpecAxis[];
  matrix: SpecMatrixCell[];
  /** 颜色 × 尺码的理论组合数。 */
  combinationCount: number;
  /** 实际存在的组合数。 */
  presentCount: number;
  issues: ValidationIssue[];
}

const SKU_CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,59}$/;

function compareValues(a: SpecValue, b: SpecValue): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.value.localeCompare(b.value);
}

/**
 * 构建规格轴与矩阵。
 * 输入为 SKU 原始行（可含未激活 SKU：未激活的不进入矩阵，但保留在 `skus` 中）。
 */
export function buildSpecAxes(rawSkus: unknown): SpecBuildResult {
  const issues: ValidationIssue[] = [];
  const empty: SpecBuildResult = {
    ok: false,
    skus: [],
    axes: [],
    matrix: [],
    combinationCount: 0,
    presentCount: 0,
    issues: [blocker('SPEC_TYPE', 'skus', 'SKU 数组', describeValue(rawSkus), '规格构建需要 SKU 列表')],
  };
  if (!Array.isArray(rawSkus)) return empty;

  const normalized: NormalizedSpecSku[] = [];
  const seenCombos = new Map<string, string>();
  const colorLabels = new Map<string, string>();
  const sizeOrders = new Map<string, number>();

  rawSkus.forEach((raw, index) => {
    const row = asRecord(raw);
    const field = `skus[${index}]`;
    if (!row) {
      issues.push(blocker('SPEC_TYPE', field, '对象', describeValue(raw), 'SKU 必须是对象'));
      return;
    }

    const skuCode = typeof row.skuCode === 'string' ? row.skuCode.trim().toUpperCase() : '';
    if (!SKU_CODE_RE.test(skuCode)) {
      issues.push(
        blocker('SPEC_SKU_CODE', `${field}.sku_code`, '^[A-Z0-9][A-Z0-9-]{3,59}$', describeValue(row.skuCode), 'SKU 编码不合规（docs/06 §4.2.2）'),
      );
    }

    const color = normalizeColorCode(row.colorId);
    if (color.code === null) {
      issues.push(
        blocker('SPEC_COLOR_CODE', `${field}.color_id`, '^[A-Z]{2}-[0-9]{4}$', describeValue(row.colorId), '内部色卡编码不合规（docs/19 §1）'),
      );
    } else if (color.legacy) {
      issues.push(
        warning('SPEC_COLOR_LEGACY', `${field}.color_id`, '带连字符编码', color.raw, `历史编码已归一为 ${color.code}；新数据必须带连字符`),
      );
    }

    const colorName = typeof row.colorName === 'string' ? row.colorName.trim() : '';
    if (colorName.length === 0) {
      issues.push(warning('SPEC_COLOR_NAME', `${field}.color_name`, '非空展示名', '空', '颜色展示名缺失会影响详情文案，但不阻断上架'));
    }

    const size = normalizeSizeCode(row.sizeCode);
    if (size.code === null) {
      const rejected = REJECTED_SIZE_CODES.includes(size.raw.trim().toUpperCase());
      issues.push(
        blocker(
          'SPEC_SIZE_CODE',
          `${field}.size_code`,
          'docs/19 §2 词表内（字母码/数字码/ONE）',
          describeValue(row.sizeCode),
          rejected ? '该写法已被 docs/19 §2 明确拒绝（无法入库）' : '尺码不在词表内，先归一别名再入库',
        ),
      );
      return;
    }
    if (size.aliased) {
      issues.push(
        warning('SPEC_SIZE_ALIAS', `${field}.size_code`, size.code, size.raw, `别名已归一：${size.raw} → ${size.code}`),
      );
    }

    const canonicalOrder = sizeOrderFor(size.code);
    let sizeOrder: number;
    if (canonicalOrder !== null) {
      sizeOrder = canonicalOrder;
      if (row.sizeOrder !== undefined && row.sizeOrder !== null) {
        const explicit = Number(row.sizeOrder);
        if (!Number.isSafeInteger(explicit) || explicit < 0 || explicit > 99) {
          issues.push(
            blocker('SPEC_SIZE_ORDER', `${field}.size_order`, '0–99 的整数', describeValue(row.sizeOrder), 'size_order 超出 smallint 约束'),
          );
        } else if (explicit !== canonicalOrder) {
          issues.push(
            blocker(
              'SPEC_SIZE_ORDER',
              `${field}.size_order`,
              String(canonicalOrder),
              String(explicit),
              `尺码 ${size.code} 的规范顺序是 ${canonicalOrder}（docs/19 §2），与显式值冲突`,
            ),
          );
        }
      }
    } else if (row.sizeOrder !== undefined && row.sizeOrder !== null && Number.isSafeInteger(Number(row.sizeOrder))) {
      const explicit = Number(row.sizeOrder);
      if (explicit < 0 || explicit > 99) {
        issues.push(
          blocker('SPEC_SIZE_ORDER', `${field}.size_order`, '0–99 的整数', describeValue(row.sizeOrder), '数字码的 size_order 超出 smallint 约束'),
        );
      }
      sizeOrder = explicit;
    } else {
      issues.push(
        blocker(
          'SPEC_SIZE_ORDER',
          `${field}.size_order`,
          '显式 size_order',
          '缺失',
          '数字码（如 90/150/26）的排序含义由尺码表决定，必须显式给出 size_order',
        ),
      );
      return;
    }

    const existingOrder = sizeOrders.get(size.code);
    if (existingOrder !== undefined && existingOrder !== sizeOrder) {
      issues.push(
        blocker('SPEC_SIZE_ORDER', `${field}.size_order`, String(existingOrder), String(sizeOrder), `尺码 ${size.code} 在多个 SKU 上给出了不同 order`),
      );
    }
    sizeOrders.set(size.code, sizeOrder);

    if (color.code !== null) {
      const comboKey = `${color.code}|${size.code}`;
      const previous = seenCombos.get(comboKey);
      if (previous) {
        issues.push(
          blocker(
            'SPEC_DUPLICATE',
            `${field}`,
            '颜色+尺码唯一',
            `${color.code} / ${size.code}（已存在 ${previous}）`,
            '同一颜色同一尺码出现两个 SKU（自然键 product_id+color_id+size_code+fabric_id 冲突）',
          ),
        );
      } else {
        seenCombos.set(comboKey, skuCode);
      }
    }

    const status = row.status === 'inactive' ? 'inactive' : 'active';
    const minOrderQty = typeof row.minOrderQty === 'number' && Number.isSafeInteger(row.minOrderQty) ? row.minOrderQty : null;
    const priceCents = typeof row.priceCents === 'number' && Number.isSafeInteger(row.priceCents) ? row.priceCents : null;

    normalized.push({
      skuCode,
      colorId: color.code ?? String(row.colorId ?? ''),
      colorName,
      sizeCode: size.code,
      sizeOrder,
      minOrderQty,
      priceCents,
      status,
    });
    if (color.code !== null) colorLabels.set(color.code, colorName);
  });

  if (normalized.length === 0) {
    issues.push(blocker('SPEC_EMPTY', 'skus', '≥1 个可解析 SKU', '0 个', '没有可用 SKU 无法生成规格与上架包'));
    return { ...empty, issues };
  }

  const active = normalized.filter((sku) => sku.status === 'active');
  const colorValues: SpecValue[] = [...new Set(active.map((sku) => sku.colorId))]
    .sort((a, b) => a.localeCompare(b))
    .map((colorId, index) => ({
      value: colorId,
      label: colorLabels.get(colorId) ?? colorId,
      order: index,
      platformValueId: null,
      mappingStatus: 'draft',
    }));
  const sizeValues: SpecValue[] = [...new Map(active.map((sku) => [sku.sizeCode, sku.sizeOrder])).entries()]
    .map(([value, order]) => ({ value, order, label: value, platformValueId: null, mappingStatus: 'draft' as const }))
    .sort(compareValues);

  const matrix: SpecMatrixCell[] = [];
  for (const color of colorValues) {
    for (const size of sizeValues) {
      const sku = active.find((candidate) => candidate.colorId === color.value && candidate.sizeCode === size.value);
      matrix.push({
        colorId: color.value,
        sizeCode: size.value,
        skuCode: sku?.skuCode ?? null,
        minOrderQty: sku?.minOrderQty ?? null,
        priceCents: sku?.priceCents ?? null,
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === 'blocker'),
    skus: normalized,
    axes: [
      { axis: 'color', values: colorValues },
      { axis: 'size', values: sizeValues },
    ],
    matrix,
    combinationCount: colorValues.length * sizeValues.length,
    presentCount: matrix.filter((cell) => cell.skuCode !== null).length,
    issues,
  };
}

/** 规格组合指纹（颜色×尺码，排序稳定）：用于上架包哈希与快照比对。 */
export function specKeyOf(sku: Pick<NormalizedSpecSku, 'colorId' | 'sizeCode'>): string {
  return `${sku.colorId}/${sku.sizeCode}`;
}

/** 只保留阻断级问题（便于调用方统一判定）。 */
export function specBlockers(result: SpecBuildResult): ValidationIssue[] {
  return result.issues.filter((issue) => issue.severity === 'blocker');
}
