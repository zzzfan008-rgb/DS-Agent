/**
 * 1688 上架包导出器 —— docs/02 §6.1 步骤 3、docs/00 §8.1 路径 2（导入包兜底）。
 *
 * 它做三件事：
 * 1. **收敛**：把主数据（product / sku / fabric / size_chart / price_tiers / moq / dropship）
 *    与平台侧信息（类目、映射）合成一个包；
 * 2. **门禁**：按 docs/19 的三级校验（L0 Schema → L1 业务 → L2 平台）逐项产出
 *    `blocker` / `warning`；有阻断项时 `publishable=false`；
 * 3. **诚实**：契约未核验（method / 签名 / 请求协议 / 平台属性值）时，**永远** 输出
 *    `publishable=false` 并把 TODO id 写进包 —— 不允许「看起来能发」的包流出去。
 *
 * 注意：本包不是 1688 后台模板（`TODO-1688-010`），`templateVerified` 恒为 false。
 */

import { buildAttributeMappings, type AttributeMappingRow, type VerifiedMappingIndex } from '../mapping/attributes.js';
import { renderMaterialsText, validateMaterials } from '../domain/fabric.js';
import { validateCare, careTextLines } from '../domain/care.js';
import { validateDropship } from '../domain/dropship.js';
import { validateMoq } from '../domain/moq.js';
import {
  computePriceRange,
  validatePriceTiers,
  type PriceTier,
} from '../domain/price-tiers.js';
import { evaluateQualification, qualificationAllowsPublish } from '../domain/qualification.js';
import {
  checkRecommendRanges,
  checkSizeChartCoverage,
  validateSizeChart,
  type SizeChartRow,
} from '../domain/size-chart.js';
import { buildSpecAxes } from '../domain/spec.js';
import { displayCents, isQty } from '../domain/money.js';
import { toCsv } from '../csv.js';
import { TODO_ITEMS, type TodoId } from '../todo.js';
import {
  asRecord,
  blocker,
  dedupeIssues,
  describeValue,
  warning,
  type ValidationIssue,
} from '../validation.js';
import {
  LISTING_PACKAGE_SCHEMA_VERSION,
  hashListingPackage,
  type ListingPackageDraft,
  type ListingPackageInput,
  type ListingPackageSku,
  type MediaRef,
} from './package.js';

export interface BuildListingPackageOptions {
  /** 生成时间（ISO）。缺省取当前时间；测试与样例生成时固定。 */
  generatedAt?: string;
  /** 资质判定基准日（ISO date）。缺省取 generatedAt 的日期部分。 */
  asOf?: string;
}

const SPU_CODE_RE = /^[A-Z0-9][A-Z0-9-]{3,39}$/;
const CATEGORY_CODE_RE = /^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/;

/** 契约未核验的三个 TODO：method / 请求协议 / 签名。 */
export const CONTRACT_TODO_IDS: TodoId[] = ['TODO-1688-001', 'TODO-1688-002', 'TODO-1688-003'];

function buildVerifiedIndex(
  entries: ListingPackageInput['verifiedMappings'],
): VerifiedMappingIndex | undefined {
  if (!entries || entries.length === 0) return undefined;
  const map = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    get: (key) => {
      const hit = map.get(key);
      return hit ? { platformValueId: hit.platformValueId, platformValueName: hit.platformValueName, status: hit.status } : undefined;
    },
  };
}

/**
 * 构建上架包。永不抛错（校验失败以 `checks.blockers` 表达），便于 dry-run 与批量预检；
 * 只有在入参结构完全无法解析时（如 `skus` 不是数组）才会得到空包 + 阻断项。
 */
export function buildListingPackage(
  input: ListingPackageInput,
  options: BuildListingPackageOptions = {},
): ListingPackageDraft {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const asOf = options.asOf ?? generatedAt.slice(0, 10);
  const issues: ValidationIssue[] = [];

  // ---- L0：商品基础字段 ----
  const spuCode = typeof input.product.spuCode === 'string' ? input.product.spuCode.trim().toUpperCase() : '';
  if (!SPU_CODE_RE.test(spuCode)) {
    issues.push(
      blocker('PACKAGE_SPU_CODE', 'product.spu_code', '^[A-Z0-9][A-Z0-9-]{3,39}$', describeValue(input.product.spuCode), '内部货号不合规（docs/06 §4.2.1）'),
    );
  }
  const name = typeof input.product.name === 'string' ? input.product.name.trim() : '';
  if (name.length < 1 || name.length > 120) {
    issues.push(blocker('PACKAGE_NAME', 'product.name', '1–120 字', describeValue(input.product.name), '商品名长度不合法'));
  }
  const categoryCode = typeof input.product.categoryCode === 'string' ? input.product.categoryCode.trim().toUpperCase() : '';
  if (!CATEGORY_CODE_RE.test(categoryCode)) {
    issues.push(
      blocker('PACKAGE_CATEGORY', 'product.category_code', '^[A-Z][0-9]{4}(\\.[0-9]{1,3})?$', describeValue(input.product.categoryCode), '内部类目编码不合规（docs/19 §3.2）'),
    );
  }

  // ---- 成分 ----
  const fabricResult = validateMaterials(input.fabric.materials);
  issues.push(...fabricResult.issues);
  const materialsText = fabricResult.value ? renderMaterialsText(fabricResult.value) : '';

  // ---- 尺码表 ----
  const sizeChartResult = validateSizeChart(input.sizeChart.rows, {
    categoryCode,
    sizeSystem: input.sizeChart.sizeSystem,
  });
  issues.push(...sizeChartResult.issues);
  const chartRows: SizeChartRow[] = sizeChartResult.value ?? [];
  if (sizeChartResult.ok && chartRows.length > 0) {
    issues.push(...checkRecommendRanges(chartRows));
  }

  // ---- 规格 ----
  const specResult = buildSpecAxes(input.skus);
  issues.push(...specResult.issues);
  const activeSkus = specResult.skus.filter((sku) => sku.status === 'active');
  if (activeSkus.length === 0) {
    issues.push(blocker('PACKAGE_NO_ACTIVE_SKU', 'skus', '≥1 个 active SKU', '0 个', '没有可上架的 SKU'));
  }
  if (chartRows.length > 0) {
    issues.push(...checkSizeChartCoverage(chartRows, activeSkus.map((sku) => sku.sizeCode)));
  }

  // ---- 起批量（包级视图；每个 SKU 自己的起批量在下面逐条校验）----
  let moqValue = null as ReturnType<typeof validateMoq>['value'];
  if (input.moq !== undefined) {
    const moqResult = validateMoq(input.moq);
    issues.push(...moqResult.issues);
    moqValue = moqResult.value;
  }

  // ---- 逐 SKU：价格 / 阶梯价 / 起批量 / 时效 / 库存 ----
  const packageSkus: ListingPackageSku[] = [];
  const rawSkuList = Array.isArray(input.skus) ? input.skus : [];
  const rawSkuByCode = new Map<string, Record<string, unknown>>();
  rawSkuList.forEach((raw) => {
    const row = asRecord(raw);
    if (!row || typeof row.skuCode !== 'string') return;
    rawSkuByCode.set(row.skuCode.trim().toUpperCase(), row);
  });

  for (const sku of specResult.skus) {
    const raw = rawSkuByCode.get(sku.skuCode) ?? {};
    const field = `skus.${sku.skuCode}`;
    const minOrderQty = isQty(raw.minOrderQty) ? raw.minOrderQty : moqValue?.minOrderQty ?? 1;
    const tiersResult = validatePriceTiers(raw.priceTiers, { minOrderQty });
    for (const issue of tiersResult.issues) {
      issues.push({ ...issue, field: `${field}.${issue.field}` });
    }
    const tiers: PriceTier[] = tiersResult.value ?? [];
    if (tiersResult.ok && tiers.length > 0) {
      // 区间价由档位推导，展示文案随包导出（docs/02 §2.7#3）。
      const range = computePriceRange(tiers);
      const priceCents = Number.isSafeInteger(sku.priceCents) ? (sku.priceCents as number) : Number.NaN;
      if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
        issues.push(blocker('PACKAGE_SKU_PRICE', `${field}.price_cents`, '正整数分', describeValue(raw.priceCents), '售价必须是正整数分'));
      }
      const listPriceCents = typeof raw.listPriceCents === 'number' ? raw.listPriceCents : null;
      const salePriceCents = typeof raw.salePriceCents === 'number' ? raw.salePriceCents : null;
      if (salePriceCents !== null && Number.isSafeInteger(priceCents) && salePriceCents > priceCents) {
        issues.push(
          blocker('PACKAGE_SALE_PRICE', `${field}.sale_price_cents`, `≤ ${priceCents}`, String(salePriceCents), '促销价不得高于售价（docs/06 promo_price 约束）'),
        );
      }
      if (listPriceCents !== null && Number.isSafeInteger(priceCents) && listPriceCents < priceCents) {
        issues.push(
          warning('PACKAGE_LIST_PRICE', `${field}.list_price_cents`, `≥ ${priceCents}`, String(listPriceCents), '原价低于售价会让「划线价」失去意义'),
        );
      }
      const leadTimeDays = typeof raw.leadTimeDays === 'number' ? raw.leadTimeDays : null;
      if (leadTimeDays !== null && (!Number.isSafeInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 60)) {
        issues.push(blocker('PACKAGE_LEAD_TIME', `${field}.lead_time_days`, '0–60 天', String(leadTimeDays), '承诺发货时效超出 0–60 天'));
      }
      const stockQty = typeof raw.stockQty === 'number' && Number.isSafeInteger(raw.stockQty) && raw.stockQty >= 0 ? raw.stockQty : null;
      if (stockQty === null) {
        issues.push(warning('PACKAGE_STOCK', `${field}.stock_qty`, '非负整数', describeValue(raw.stockQty), '库存缺失或非法，导出包按 null 处理'));
      }
      const weightG = typeof raw.weightG === 'number' && Number.isSafeInteger(raw.weightG) && raw.weightG > 0 ? raw.weightG : null;
      packageSkus.push({
        skuCode: sku.skuCode,
        colorId: sku.colorId,
        colorName: sku.colorName,
        sizeCode: sku.sizeCode,
        sizeOrder: sku.sizeOrder,
        status: sku.status,
        priceCents,
        listPriceCents,
        salePriceCents,
        priceTiers: tiers,
        priceRange: range,
        minOrderQty,
        leadTimeDays,
        stockQty,
        weightG,
      });
    } else {
      packageSkus.push({
        skuCode: sku.skuCode,
        colorId: sku.colorId,
        colorName: sku.colorName,
        sizeCode: sku.sizeCode,
        sizeOrder: sku.sizeOrder,
        status: sku.status,
        priceCents: Number.isSafeInteger(sku.priceCents) ? (sku.priceCents as number) : 0,
        listPriceCents: null,
        salePriceCents: null,
        priceTiers: [],
        priceRange: { minCents: 0, maxCents: 0, display: '—', isFlat: true },
        minOrderQty,
        leadTimeDays: typeof raw.leadTimeDays === 'number' ? raw.leadTimeDays : null,
        stockQty: typeof raw.stockQty === 'number' ? raw.stockQty : null,
        weightG: typeof raw.weightG === 'number' ? raw.weightG : null,
      });
    }
  }

  // ---- 代发 ----
  const dropshipResult = input.dropship === undefined ? null : validateDropship(input.dropship);
  if (dropshipResult) issues.push(...dropshipResult.issues);
  const dropship = dropshipResult?.value ? { ...dropshipResult.value, persisted: false } : null;

  // ---- 资质 ----
  const requirementsKnown = input.platformCategory.qualificationRequirementsKnown === true;
  const qualificationResult = evaluateQualification(input.product.qualification, { asOf, requirementsKnown });
  issues.push(...qualificationResult.issues);
  if (!qualificationAllowsPublish(qualificationResult.status)) {
    issues.push(
      blocker(
        'PACKAGE_QUALIFICATION',
        'qualification.status',
        'valid|expiring',
        qualificationResult.status,
        '资质不可用（docs/19 §7 发布门禁）',
      ),
    );
  }

  // ---- 洗护 ----
  const careResult = validateCare(input.product.careInstructions);
  issues.push(...careResult.issues);
  const care = careResult.value ? { ...careResult.value, lines: careTextLines(careResult.value) } : null;

  // ---- 媒体 ----
  const mediaAssets: MediaRef[] = Array.isArray(input.product.media) ? input.product.media : [];
  const mainAssetId = input.product.mainAssetId ?? mediaAssets.find((asset) => asset.kind === 'main')?.assetId ?? null;
  if (!mainAssetId) {
    issues.push(
      blocker('PACKAGE_MEDIA_MAIN', 'product.main_asset_id', '实拍主图 asset_id', 'null', '无主图无法上架；且主图不得为 AI 生成（docs/06 §4.2.1）'),
    );
  }
  const sizeChartAssetId = mediaAssets.find((asset) => asset.kind === 'size_chart')?.assetId ?? null;
  if (!sizeChartAssetId) {
    issues.push(
      warning('PACKAGE_MEDIA_SIZE_CHART', 'media.size_chart', '尺码表图 asset_id', 'null', '建议上传尺码表图（docs/19 §8），缺失不阻断但会降低转化'),
    );
  }

  // ---- 类目 ----
  if (input.platformCategory.id === null) {
    issues.push(
      blocker('PACKAGE_CATEGORY_MISSING', 'listing.platform_category_id', '平台叶子类目 uuid', 'null', '1688 上架类目缺失（docs/21 §17-1：类目记在 listing 维度）'),
    );
  }
  if (!input.platformCategory.isLeaf) {
    issues.push(blocker('PACKAGE_CATEGORY_NOT_LEAF', 'platform_category.is_leaf', 'true', 'false', '只能发布到叶子类目（docs/19 §1.1）'));
  }

  // ---- 属性映射 ----
  const attributeResult = buildAttributeMappings({
    platformCategoryId: input.platformCategory.id,
    productId: input.product.id ?? null,
    spuCode,
    specs: specResult,
    materialsText: materialsText.length > 0 ? materialsText : null,
    mixBatchAllowed: moqValue?.mixBatchAllowed ?? false,
    verified: buildVerifiedIndex(input.verifiedMappings),
  });
  issues.push(...attributeResult.issues);
  const attributePaths = new Set(attributeResult.rows.map((row) => row.attrPath));
  const requiredAttrs = Array.isArray(input.platformCategory.requiredAttrs) ? input.platformCategory.requiredAttrs : [];
  if (requiredAttrs.length === 0) {
    issues.push(
      warning(
        'PLAT-ATTR-001',
        'platform_category.required_attrs',
        '平台必填属性快照',
        '空（未核验）',
        '类目必填属性未知时无法做 L2 预检，导出包只能作为草稿（TODO-1688-009）',
      ),
    );
  } else {
    for (const attr of requiredAttrs) {
      if (!attr.required) continue;
      if (!attributePaths.has(attr.attrPath)) {
        issues.push(
          blocker('PLAT-ATTR-001', `platform_attribute_mapping.${attr.attrPath}`, '已被映射覆盖', '缺失', `平台必填属性未覆盖：${attr.attrPath}`),
        );
      }
    }
  }
  if (attributeResult.unverifiedPaths.length > 0) {
    issues.push(
      blocker(
        'PLAT-ATTR-002',
        'platform_attribute_mapping.status',
        '全部 verified',
        `${attributeResult.unverifiedPaths.join('、')} 仍为 draft`,
        '映射未验证禁止发布（docs/19 §10 L2）；需人工补齐平台值 id 后置 verified',
      ),
    );
  }

  // ---- 契约门禁（本包最重要的一条）----
  issues.push(
    blocker(
      'CONTRACT_UNVERIFIED',
      'adapter.contract',
      'method / 请求协议 / 签名已核验',
      '未核验',
      `1688 接口契约未核验，禁止真实写入：${CONTRACT_TODO_IDS.map((id) => `${id}（${TODO_ITEMS[id].docRef}）`).join('；')}`,
    ),
  );
  issues.push(
    warning(
      'IMPORT_TEMPLATE_UNVERIFIED',
      'adapter.import_template',
      '平台导入模板列名已核验',
      '未核验',
      '导出 CSV 是内部规范化包，不能直接当作 1688 后台模板（TODO-1688-010）',
    ),
  );

  const deduped = dedupeIssues(issues);
  const blockers = deduped.filter((issue) => issue.severity === 'blocker');
  const warnings = deduped.filter((issue) => issue.severity === 'warning');
  const openTodoIds = Object.values(TODO_ITEMS)
    .filter((item) => item.status === 'open')
    .map((item) => item.id);

  const draftWithoutHash: Omit<ListingPackageDraft, 'packageHash'> = {
    meta: {
      schemaVersion: LISTING_PACKAGE_SCHEMA_VERSION,
      platform: '1688',
      generatedAt,
      contractVerified: false,
      templateVerified: false,
      openTodoIds,
      publishable: blockers.length === 0,
    },
    product: {
      productId: input.product.id ?? null,
      spuCode,
      name,
      brand: input.product.brand ?? null,
      season: input.product.season ?? null,
      fit: input.product.fit ?? null,
      categoryCode,
      attributes: input.product.attributes ?? {},
      mainAssetId,
    },
    fabric: {
      fabricCode: input.fabric.fabricCode,
      fabricName: input.fabric.fabricName,
      role: input.fabric.role,
      materials: fabricResult.value ?? [],
      materialsText,
    },
    sizeChart: {
      versionNo: input.sizeChart.versionNo,
      sizeSystem: input.sizeChart.sizeSystem,
      unit: 'cm',
      rows: chartRows,
    },
    spec: {
      axes: specResult.axes,
      matrix: specResult.matrix,
      combinationCount: specResult.combinationCount,
      presentCount: specResult.presentCount,
    },
    skus: packageSkus,
    moq: moqValue,
    dropship,
    attributes: attributeResult.rows,
    qualification: {
      status: qualificationResult.status,
      nextExpiry: qualificationResult.nextExpiry,
      daysToExpiry: qualificationResult.daysToExpiry,
      requirementsKnown,
    },
    care,
    media: { mainAssetId, assets: mediaAssets, sizeChartAssetId },
    platformCategory: {
      id: input.platformCategory.id,
      externalCategoryId: input.platformCategory.externalCategoryId ?? null,
      name: input.platformCategory.name ?? null,
      isLeaf: input.platformCategory.isLeaf,
      requiredAttrs,
    },
    checks: { blockers, warnings },
  };

  return { ...draftWithoutHash, packageHash: hashListingPackage(draftWithoutHash) };
}

/** 上架包 JSON 文本（便于落盘/审阅；哈希以 `packageHash` 为准）。 */
export function renderListingPackageJson(draft: ListingPackageDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

/** 上架包 CSV 列（内部规范列；**不是**平台模板，TODO-1688-010）。 */
export const PACKAGE_CSV_HEADERS = [
  'spu_code',
  'category_code',
  'sku_code',
  'color_id',
  'color_name',
  'size_code',
  'size_order',
  'price_cents',
  'price_yuan',
  'list_price_cents',
  'sale_price_cents',
  'min_order_qty',
  'unit',
  'mix_batch_allowed',
  'lead_time_days',
  'stock_qty',
  'weight_g',
  'tier1_min_qty',
  'tier1_price_cents',
  'tier2_min_qty',
  'tier2_price_cents',
  'tier3_min_qty',
  'tier3_price_cents',
  'tier4_min_qty',
  'tier4_price_cents',
  'tier5_min_qty',
  'tier5_price_cents',
  'price_range_display',
  'dropship_enabled',
  'dropship_price_cents',
  'materials',
  'size_chart_version',
  'qualification_status',
] as const;

/** 导出上架包 CSV（UTF-8 BOM，Excel 可直接打开）。 */
export function renderListingPackageCsv(draft: ListingPackageDraft): string {
  const rows = draft.skus.map((sku) => {
    const tiers = sku.priceTiers;
    const tierCells: Array<number | string> = [];
    for (let index = 0; index < 5; index += 1) {
      const tier = tiers[index];
      tierCells.push(tier ? tier.minQty : '', tier ? tier.priceCents : '');
    }
    return [
      draft.product.spuCode,
      draft.product.categoryCode,
      sku.skuCode,
      sku.colorId,
      sku.colorName,
      sku.sizeCode,
      sku.sizeOrder,
      sku.priceCents,
      displayCents(sku.priceCents).replace('¥', ''),
      sku.listPriceCents ?? '',
      sku.salePriceCents ?? '',
      sku.minOrderQty,
      draft.moq?.unit ?? 'piece',
      draft.moq?.mixBatchAllowed ?? false,
      sku.leadTimeDays ?? '',
      sku.stockQty ?? '',
      sku.weightG ?? '',
      ...tierCells,
      sku.priceRange.display,
      draft.dropship?.enabled ?? false,
      draft.dropship?.dropshipPriceCents ?? '',
      draft.fabric.materialsText,
      draft.sizeChart.versionNo,
      draft.qualification.status,
    ];
  });
  return toCsv(PACKAGE_CSV_HEADERS, rows);
}

/** 只读聚合：包内所有属性的映射行（便于测试与验收记录）。 */
export function packageAttributePaths(draft: ListingPackageDraft): string[] {
  return [...new Set(draft.attributes.map((row: AttributeMappingRow) => row.attrPath))].sort();
}
