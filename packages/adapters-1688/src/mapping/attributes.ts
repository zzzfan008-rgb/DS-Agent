/**
 * 1688 平台属性映射行生成 —— docs/19 §9（映射模板）+ docs/06 §4.2.6（表结构）。
 *
 * 事实边界（这是本模块最重要的一句话）：
 * 1688 的属性名（`attr_path`）、属性值 id、是否必填**全部未核验**（`TODO-1688-009`）。
 * 因此：
 * - 生成的行默认 `status='draft'`、`platform_value_id=null`，**禁止**进入发布报文
 *   （docs/19 §0.2 铁律 5：只有 `verified` 可用于发布）；
 * - `attr_path` 只取自 docs/19 §9 的「典型属性（待核验）」提示，且每行带 TODO id；
 * - 有 `verified` 映射索引（来自 `platform_attribute_mapping` 的已人工验证行）时才置
 *   `verified`，绝不自己编一个平台值；
 * - `mix_batch`（混批）在 docs/06 没有承载列 → `internal_field=null`、`persisted=false`，
 *   并挂 `TODO-1688-PERSIST-01`，等主数据增补。
 */

import { toCsv } from '../csv.js';
import type { SpecBuildResult } from '../domain/spec.js';
import type { TodoId } from '../todo.js';
import { warning, type ValidationIssue } from '../validation.js';

export const MAPPING_PLATFORM = '1688' as const;

export type MappingStatus = 'draft' | 'verified' | 'stale';
export type MappingSource = 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier';
export type AttrType = 'enum' | 'text' | 'number' | 'bool' | 'range' | 'multi_enum';

/** 一条 `platform_attribute_mapping` 行（字段名与 docs/06 §4.2.6 一致，驼峰形式）。 */
export interface AttributeMappingRow {
  platform: typeof MAPPING_PLATFORM;
  platformCategoryId: string | null;
  productId: string | null;
  skuId: string | null;
  attrPath: string;
  attrType: AttrType;
  /** 内部字段路径；`null` 表示主数据尚无承载列（混批）。 */
  internalField: string | null;
  internalValue: string;
  platformValueId: string | null;
  platformValueName: string | null;
  extra: Record<string, string | number | boolean>;
  status: MappingStatus;
  source: MappingSource;
  /** 该行还缺哪些平台事实。 */
  todoIds: TodoId[];
  /** 是否为已落库字段（混批为 false）。 */
  persisted: boolean;
}

/** 已核验映射索引：键形如 `color:BK-0101` / `size:M`。 */
export interface VerifiedMappingEntry {
  platformValueId: string | null;
  platformValueName: string | null;
  status: MappingStatus;
}

export interface VerifiedMappingIndex {
  get(key: string): VerifiedMappingEntry | undefined;
}

/** 1688 属性路径候选（docs/19 §9 表，**待核验**）。 */
export const DEFAULT_ATTR_PATHS = {
  color: 'color',
  size: 'size',
  material: 'material',
  minOrderQty: 'min_order_qty',
  mixBatch: 'mix_batch',
  spuCode: 'spu_code',
} as const;

export type AttrPathKey = keyof typeof DEFAULT_ATTR_PATHS;

export interface AttributeMappingInput {
  platformCategoryId: string | null;
  productId: string | null;
  spuCode: string;
  specs: SpecBuildResult;
  /** `renderMaterialsText()` 的结果；缺失时跳过 material 行。 */
  materialsText: string | null;
  /** 混批标记（无 DB 列，见 TODO-1688-PERSIST-01）。 */
  mixBatchAllowed: boolean;
  /** 可选：覆盖属性路径（平台字典快照回填后使用）。 */
  attrPaths?: Partial<Record<AttrPathKey, string>>;
  /** 可选：已核验映射（`platform_attribute_mapping` 中 status='verified' 的行）。 */
  verified?: VerifiedMappingIndex;
}

export interface AttributeMappingResult {
  rows: AttributeMappingRow[];
  issues: ValidationIssue[];
  /** 仍为 draft/stale 的属性路径（导出器据此判断是否可上架）。 */
  unverifiedPaths: string[];
}

const COLOR_TODO: TodoId[] = ['TODO-1688-006', 'TODO-1688-009'];
const SIZE_TODO: TodoId[] = ['TODO-1688-006', 'TODO-1688-009'];
const MOQ_TODO: TodoId[] = ['TODO-1688-006', 'TODO-1688-PERSIST-01'];
const MATERIAL_TODO: TodoId[] = ['TODO-1688-009'];
const MIX_TODO: TodoId[] = ['TODO-1688-006', 'TODO-1688-009', 'TODO-1688-PERSIST-01'];
const SPU_TODO: TodoId[] = ['TODO-1688-009'];

function resolvePath(input: AttributeMappingInput, key: AttrPathKey): string {
  return input.attrPaths?.[key] ?? DEFAULT_ATTR_PATHS[key];
}

function lookup(input: AttributeMappingInput, key: string): VerifiedMappingEntry | undefined {
  return input.verified?.get(key);
}

/**
 * 生成 1688 属性映射行（draft 为主）。
 * 不修改入参；同一色号/尺码组合只生成一行（`uq_pam` 的自然键）。
 */
export function buildAttributeMappings(input: AttributeMappingInput): AttributeMappingResult {
  const rows: AttributeMappingRow[] = [];
  const issues: ValidationIssue[] = [];
  const unverified = new Set<string>();

  const pushRow = (
    row: Omit<AttributeMappingRow, 'platform' | 'platformCategoryId' | 'productId' | 'status'>,
    mappingKey: string | null,
  ): void => {
    const verifiedEntry = mappingKey ? lookup(input, mappingKey) : undefined;
    const resolved: AttributeMappingRow = {
      ...row,
      platform: MAPPING_PLATFORM,
      platformCategoryId: input.platformCategoryId,
      productId: input.productId,
      status: verifiedEntry?.status ?? 'draft',
      platformValueId: verifiedEntry?.platformValueId ?? null,
      platformValueName: verifiedEntry?.platformValueName ?? row.platformValueName,
      extra: { ...row.extra, ...(verifiedEntry?.platformValueName ? { snapshot_name: verifiedEntry.platformValueName } : {}) },
    };
    rows.push(resolved);
    if (resolved.status !== 'verified') unverified.add(resolved.attrPath);
  };

  for (const axis of input.specs.axes) {
    const path = axis.axis === 'color' ? resolvePath(input, 'color') : resolvePath(input, 'size');
    const attrType: AttrType = 'enum';
    const todoIds = axis.axis === 'color' ? COLOR_TODO : SIZE_TODO;
    for (const value of axis.values) {
      pushRow(
        {
          skuId: null,
          attrPath: path,
          attrType,
          internalField: axis.axis === 'color' ? 'product_sku.color_id' : 'product_sku.size_code',
          internalValue: value.value,
          platformValueId: null,
          platformValueName: null,
          extra: {
            label: value.label,
            order: value.order,
            ...(axis.axis === 'size' ? { size_order: value.order } : {}),
          },
          source: 'manual',
          todoIds,
          persisted: true,
        },
        `${axis.axis}:${value.value}`,
      );
    }
  }

  if (input.materialsText !== null && input.materialsText.trim().length > 0) {
    pushRow(
      {
        skuId: null,
        attrPath: resolvePath(input, 'material'),
        attrType: 'text',
        internalField: 'fabric_composition.materials',
        internalValue: input.materialsText,
        platformValueId: null,
        platformValueName: input.materialsText,
        extra: { display_divisor: 1 },
        source: 'manual',
        todoIds: MATERIAL_TODO,
        persisted: true,
      },
      'material:*',
    );
  }

  for (const sku of input.specs.skus) {
    if (sku.minOrderQty === null) continue;
    pushRow(
      {
        skuId: null,
        attrPath: resolvePath(input, 'minOrderQty'),
        attrType: 'number',
        internalField: 'product_sku.min_order_qty',
        internalValue: String(sku.minOrderQty),
        platformValueId: null,
        platformValueName: null,
        extra: { unit: '件', sku_code: sku.skuCode },
        source: 'manual',
        todoIds: MOQ_TODO,
        persisted: true,
      },
      `min_order_qty:${sku.skuCode}`,
    );
  }

  pushRow(
    {
      skuId: null,
      attrPath: resolvePath(input, 'mixBatch'),
      attrType: 'bool',
      internalField: null,
      internalValue: input.mixBatchAllowed ? 'true' : 'false',
      platformValueId: null,
      platformValueName: null,
      extra: { pending_column: 'mix_batch_allowed' },
      source: 'manual',
      todoIds: MIX_TODO,
      persisted: false,
    },
    null,
  );

  pushRow(
    {
      skuId: null,
      attrPath: resolvePath(input, 'spuCode'),
      attrType: 'text',
      internalField: 'product.spu_code',
      internalValue: input.spuCode,
      platformValueId: null,
      platformValueName: null,
      extra: {},
      source: 'import',
      todoIds: SPU_TODO,
      persisted: true,
    },
    'spu_code:*',
  );

  for (const path of unverified) {
    issues.push(
      warning(
        'PLAT-ATTR-002',
        `platform_attribute_mapping.${path}`,
        'status=verified',
        'draft（平台值未核验）',
        '映射未验证，禁止进入发布报文（docs/19 §10 L2 / 铁律 5）',
      ),
    );
  }
  if (input.platformCategoryId === null) {
    issues.push(
      warning(
        'PLAT-ATTR-003',
        'platform_attribute_mapping.platform_category_id',
        '叶子类目 uuid',
        'null',
        '映射必须以平台叶子类目为作用域（docs/19 §1.1），缺失时只能作为草稿预览',
      ),
    );
  }

  return { rows, issues, unverifiedPaths: [...unverified].sort() };
}

/** `platform_attribute_mapping` 的 CSV 列（与 docs/19 §11 的样例表头一致）。 */
export const MAPPING_CSV_HEADERS = [
  'platform',
  'platform_category_id',
  'attr_path',
  'attr_type',
  'internal_field',
  'internal_value',
  'platform_value_id',
  'platform_value_name',
  'extra',
  'status',
  'source',
] as const;

/** 导出映射 CSV（UTF-8 BOM）。 */
export function renderMappingCsv(rows: readonly AttributeMappingRow[]): string {
  return toCsv(
    MAPPING_CSV_HEADERS,
    rows.map((row) => [
      row.platform,
      row.platformCategoryId,
      row.attrPath,
      row.attrType,
      row.internalField,
      row.internalValue,
      row.platformValueId,
      row.platformValueName,
      JSON.stringify(row.extra),
      row.status,
      row.source,
    ]),
  );
}
