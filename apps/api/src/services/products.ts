/**
 * 商品主数据服务（M3）：CSV 导入、创建、尺码表/成分/平台属性强校验与落库。
 *
 * 硬规则（docs/19 §0.2）：
 * - 事实只能来自导入/ERP/人工/平台同步，模型不产事实；
 * - color_id / size_code 只做标识，展示名不参与判断；
 * - 尺码表一码一行；成分合计必须 100；映射 internal_field 白名单；
 * - 校验先 Schema 后业务，失败返回字段级 issue（422 validation_failed / invalid_fact）。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@dssaas/db';
import {
  canonicalJson,
  fabricText,
  normalizeColorId,
  normalizeSizeCode,
  sizeOrderFor,
  validateFabricComposition,
  validatePlatformAttributeMapping,
  validateSizeChart,
  type FabricMaterial,
} from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';

export interface ProductServiceDeps {
  prisma: PrismaClient;
  audit: AuditService;
}

export interface ServiceContext {
  requestId: string;
  userId: string;
  role: string;
  ip: string | null;
  userAgent: string | null;
}

export interface SkuInput {
  color_id: string;
  color_name?: string;
  size_code: string;
  price_cents: number;
  list_price_cents?: number;
  sale_price_cents?: number;
  stock_qty?: number;
  min_order_qty?: number;
  lead_time_days?: number;
  weight_g?: number;
  barcode?: string;
}

export interface FabricInput {
  materials: Array<{ material: string; percent: number; note?: string; fiber_code?: string }>;
  fabric_code?: string;
  fabric_name?: string;
  role?: 'main' | 'lining' | 'trim' | 'accessory';
  source?: 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier';
  effective_from?: string;
}

export interface ProductCreateInput {
  spu_code: string;
  name: string;
  category_code: string;
  fit?: 'slim' | 'regular' | 'loose' | 'oversize';
  description?: string;
  brand?: string;
  season?: 'spring' | 'summer' | 'autumn' | 'winter' | 'all';
  attributes?: Record<string, unknown>;
  skus: SkuInput[];
  fabric: FabricInput;
  /** DB 触发器要求 SKU 尺码必须已存在于 effective size_chart，因此创建 SKU 前必须先落尺码表。 */
  size_chart?: SizeChartPutInput;
}

export interface SizeChartPutInput {
  items: Array<{
    sku_size_code: string;
    measurements: Record<string, number>;
    recommend_height_min?: number;
    recommend_height_max?: number;
    recommend_weight_min?: number;
    recommend_weight_max?: number;
    extra_measures?: Record<string, number>;
  }>;
  version_no?: number;
  effective_from: string;
  effective_to?: string | null;
  size_system?: 'alpha' | 'numeric' | 'height_weight' | 'one_size';
  source?: 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier';
  fit_note?: string;
}

export interface FabricPutInput {
  items: Array<{ material: string; percent: number; note?: string; fiber_code?: string }>;
  fabric_code?: string;
  fabric_name?: string;
  role?: 'main' | 'lining' | 'trim' | 'accessory';
  effective_from?: string;
  source?: 'import' | 'erp' | 'manual' | 'platform_sync' | 'supplier';
}

export interface AttributesPutInput {
  platform: 'pdd' | '1688';
  mapping: Array<Record<string, unknown>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checksumOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function issue(code: string, field: string, message: string, extra: Record<string, unknown> = {}) {
  return { code, field, message, ...extra };
}

function assertValid(result: { ok: boolean; issues: Array<{ code: string; field: string; message: string }> }, label: string): void {
  if (!result.ok) {
    throw new ApiError('validation_failed', `${label}校验失败`, {
      detail: { issues: result.issues },
    });
  }
}

function skuCodeFor(spuCode: string, colorId: string, sizeCode: string): string {
  const suffix = `${colorId}-${sizeCode}`.replace(/[^A-Z0-9-]/g, '');
  return `${spuCode}-${suffix}`.slice(0, 60).toUpperCase();
}

function validateSkuInput(skus: SkuInput[]): SkuInput[] {
  if (!Array.isArray(skus) || skus.length === 0) {
    throw new ApiError('validation_failed', '至少需要 1 个 SKU', { detail: { field: 'skus' } });
  }
  const seen = new Set<string>();
  return skus.map((sku, index) => {
    const color = normalizeColorId(sku.color_id);
    if (!color.ok) {
      throw new ApiError('validation_failed', color.reason ?? 'color_id 非法', {
        detail: { field: `skus[${index}].color_id`, issues: [color.reason] },
      });
    }
    const sizeCode = normalizeSizeCode(sku.size_code);
    const key = `${color.colorId}|${sizeCode}`;
    if (seen.has(key)) {
      throw new ApiError('validation_failed', `SKU 重复：${key}`, {
        detail: { field: `skus[${index}]` },
      });
    }
    seen.add(key);
    if (!Number.isInteger(sku.price_cents) || sku.price_cents <= 0) {
      throw new ApiError('validation_failed', 'price_cents 必须是正整数分', {
        detail: { field: `skus[${index}].price_cents` },
      });
    }
    if (sku.sale_price_cents !== undefined && sku.sale_price_cents > sku.price_cents) {
      throw new ApiError('validation_failed', 'sale_price_cents 不得大于 price_cents', {
        detail: { field: `skus[${index}].sale_price_cents` },
      });
    }
    return {
      ...sku,
      color_id: color.colorId!,
      color_name: sku.color_name?.trim() || color.colorId!,
      size_code: sizeCode,
      stock_qty: sku.stock_qty ?? 0,
      min_order_qty: sku.min_order_qty ?? 1,
    };
  });
}

function validateFabric(input: FabricInput): FabricMaterial[] {
  const result = validateFabricComposition(input.materials);
  assertValid(result, '面料成分');
  return result.value!;
}

async function createProductTransaction(
  tx: Prisma.TransactionClient,
  input: ProductCreateInput,
  context: ServiceContext,
): Promise<{ id: string }> {
  const skus = validateSkuInput(input.skus);
  const materials = validateFabric(input.fabric);
  const product = await tx.product.create({
    data: {
      orgId: 1n,
      spuCode: input.spu_code,
      name: input.name,
      categoryCode: input.category_code,
      fit: input.fit ?? null,
      brand: input.brand ?? null,
      season: input.season ?? 'all',
      notes: input.description ?? null,
      attributes: (input.attributes ?? {}) as Prisma.InputJsonValue,
      status: 'draft',
      dataSource: 'import',
      createdBy: context.userId,
    },
    select: { id: true, spuCode: true },
  });

  const effectiveFrom = new Date(input.fabric.effective_from ?? new Date().toISOString());
  const fabric = await tx.fabricComposition.create({
    data: {
      orgId: 1n,
      productId: product.id,
      versionNo: 1,
      fabricCode: input.fabric.fabric_code ?? 'MAIN',
      fabricName: input.fabric.fabric_name ?? '主料',
      role: input.fabric.role ?? 'main',
      materials: materials as unknown as Prisma.InputJsonValue,
      status: 'effective',
      source: input.fabric.source ?? 'import',
      effectiveFrom,
      checksum: checksumOf({ product_id: product.id, materials }),
      createdBy: context.userId,
    },
    select: { id: true, fabricCode: true },
  });

  if (!input.size_chart) {
    throw new ApiError('validation_failed', '创建 SKU 前必须先提供 size_chart（DB 触发器要求尺码已生效）', {
      detail: { field: 'size_chart' },
    });
  }
  const chartValidation = validateSizeChart(
    {
      version_no: input.size_chart.version_no ?? 1,
      size_system: input.size_chart.size_system ?? 'alpha',
      unit: 'cm',
      effective_from: input.size_chart.effective_from,
      effective_to: input.size_chart.effective_to ?? null,
      source: input.size_chart.source ?? 'import',
      ...(input.size_chart.fit_note ? { fit_note: input.size_chart.fit_note } : {}),
      sizes: input.size_chart.items,
    },
    { categoryCode: input.category_code },
  );
  assertValid(chartValidation, '尺码表');
  const chart = chartValidation.value!;
  const chartChecksum = checksumOf(chart.sizes);
  for (const size of chart.sizes) {
    await tx.sizeChart.create({
      data: {
        orgId: 1n,
        productId: product.id,
        versionNo: input.size_chart.version_no ?? 1,
        status: 'effective',
        sizeSystem: chart.size_system,
        skuSizeCode: String(size.sku_size_code),
        sizeOrder: Number(size.size_order),
        measurements: size.measurements as Prisma.InputJsonValue,
        recommendHeightMin: (size.recommend_height_min as number | undefined) ?? null,
        recommendHeightMax: (size.recommend_height_max as number | undefined) ?? null,
        recommendWeightMin: (size.recommend_weight_min as number | undefined) ?? null,
        recommendWeightMax: (size.recommend_weight_max as number | undefined) ?? null,
        fitNote: chart.fit_note ?? null,
        source: chart.source,
        effectiveFrom: new Date(chart.effective_from),
        effectiveTo: chart.effective_to ? new Date(chart.effective_to) : null,
        checksum: chartChecksum,
        createdBy: context.userId,
      },
    });
  }

  for (const sku of skus) {
    await tx.productSku.create({
      data: {
        orgId: 1n,
        skuCode: skuCodeFor(product.spuCode, sku.color_id, sku.size_code),
        productId: product.id,
        colorId: sku.color_id,
        colorName: sku.color_name!,
        sizeCode: sku.size_code,
        fabricCode: fabric.fabricCode,
        barcode: sku.barcode ?? null,
        priceCents: sku.price_cents,
        listPriceCents: sku.list_price_cents ?? null,
        salePriceCents: sku.sale_price_cents ?? null,
        costCents: null,
        stockQty: sku.stock_qty ?? 0,
        minOrderQty: sku.min_order_qty ?? 1,
        leadTimeDays: sku.lead_time_days ?? null,
        weightG: sku.weight_g ?? null,
        priceSource: 'import',
        stockSource: 'import',
        status: 'active',
        createdBy: context.userId,
      },
    });
  }

  return { id: product.id };
}

export async function createProduct(
  deps: ProductServiceDeps,
  input: ProductCreateInput,
  context: ServiceContext,
): Promise<{ id: string }> {
  if (!/^[A-Z0-9][A-Z0-9-]{3,39}$/.test(input.spu_code)) {
    throw new ApiError('validation_failed', 'spu_code 必须形如 SPU-2026-001', {
      detail: { field: 'spu_code' },
    });
  }
  if (!/^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/.test(input.category_code)) {
    throw new ApiError('validation_failed', 'category_code 格式非法', {
      detail: { field: 'category_code' },
    });
  }
  if (input.name.trim().length < 1 || input.name.length > 120) {
    throw new ApiError('validation_failed', 'name 长度必须 1–120', { detail: { field: 'name' } });
  }

  let created: { id: string };
  try {
    created = await deps.prisma.$transaction((tx) => createProductTransaction(tx, input, context));
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      throw new ApiError('conflict', 'spu_code 已存在', { detail: { spu_code: input.spu_code } });
    }
    throw error;
  }

  await deps.audit.record({
    action: 'product.create',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'product',
    resourceId: created.id,
    after: {
      spu_code: input.spu_code,
      category_code: input.category_code,
      sku_count: input.skus.length,
      fabric: fabricText(input.fabric.materials),
    },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return created;
}

// ------------------------------------------------------------
// 查询
// ------------------------------------------------------------

export interface ProductListQuery {
  q?: string;
  category_code?: string;
  platform?: 'pdd' | '1688';
  status?: string;
  missing_fields?: boolean;
  cursor?: string;
  limit: number;
}

/** 稳定字段编码（前端负责中文/图标映射，禁止在 API 里返回展示文案）。 */
export const PRODUCT_MISSING_CODES = {
  sizeChart: 'missing_size_chart',
  fabric: 'missing_fabric',
  qualification: 'missing_qualification',
  platformCategory: 'missing_platform_category',
} as const;

/**
 * 商品列表聚合（t28 G1，t51 分页下推）。
 *
 * 拉取当前筛选下的商品后，用 4 条批量查询（SKU / size_chart / fabric / listing）聚合，
 * 不做逐商品查询。
 *
 * **t51 修复（M9 压测 P1）**：原实现 `product.findMany({where, orderBy})` 没有 `take/skip`，
 * 会把全量行拉进内存再 slice —— 10,000 条时 p95 886–991ms 且线性增长。现在：
 * - 无 `missing_fields` 过滤：`take/skip` 直接下推（`skip` 由游标换算，语义仍是 `spu_code > cursor`），
 *   只 `select` 列表真正用到的列；
 * - 有 `missing_fields` 过滤：缺失字段必须先聚合才知道，无法纯 SQL 下推 → 改为
 *   **分批扫描（`SCAN_BATCH` 一页）+ 聚合 + 早停**，凑够 `limit+1` 条就停，不再全量拉取。
 *   这是"过滤条件依赖聚合结果"的固有代价；最坏情况（几乎没有缺失商品）仍会扫到末尾，
 *   但内存占用被限制在单批，且正常场景（有缺失商品）只需扫一小部分。
 */
const SCAN_BATCH = 500;

/** 列表页真正用到的 product 列（t51：只 select 需要的列，避免拉 `attributes` 等大 JSON）。 */
const PRODUCT_LIST_SELECT = {
  id: true,
  spuCode: true,
  name: true,
  categoryCode: true,
  fit: true,
  status: true,
  qualification: true,
  updatedAt: true,
} as const;

type ProductListRow = {
  id: string;
  spuCode: string;
  name: string;
  categoryCode: string;
  fit: string | null;
  status: string;
  qualification: unknown;
  updatedAt: Date;
};

/**
 * 批量聚合 4 张关联表，返回构造列表项所需的索引。
 * 抽成函数是为了让"下推路径"和"分批扫描路径"共用同一套聚合逻辑。
 */
async function aggregateProductRows(deps: ProductServiceDeps, rows: readonly ProductListRow[]) {
  const ids = rows.map((row) => row.id);
  const skuCounts = new Map<string, { skus: number; colors: Set<string> }>();
  const chartVersion = new Map<string, number>();
  const effectiveCharts = new Set<string>();
  const effectiveFabrics = new Set<string>();
  const listingsByProduct = new Map<
    string,
    Map<string, { status: string; platformState: string | null; platformCategoryId: string | null; lastWriteAt: Date | null }>
  >();

  if (ids.length > 0) {
    const [skus, charts, fabrics, listings] = await Promise.all([
      deps.prisma.productSku.findMany({
        where: { productId: { in: ids }, archivedAt: null },
        select: { productId: true, colorId: true },
      }),
      deps.prisma.sizeChart.findMany({
        where: { productId: { in: ids }, archivedAt: null },
        select: { productId: true, versionNo: true, status: true },
      }),
      deps.prisma.fabricComposition.findMany({
        where: { productId: { in: ids }, archivedAt: null, status: 'effective' },
        select: { productId: true },
      }),
      deps.prisma.listing.findMany({
        where: { productId: { in: ids }, archivedAt: null },
        select: {
          productId: true,
          platform: true,
          status: true,
          platformState: true,
          platformCategoryId: true,
          updatedAt: true,
          lastSyncedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);
    for (const sku of skus) {
      const entry = skuCounts.get(sku.productId) ?? { skus: 0, colors: new Set<string>() };
      entry.skus += 1;
      entry.colors.add(sku.colorId);
      skuCounts.set(sku.productId, entry);
    }
    for (const chart of charts) {
      chartVersion.set(chart.productId, Math.max(chartVersion.get(chart.productId) ?? 0, chart.versionNo));
      if (chart.status === 'effective') effectiveCharts.add(chart.productId);
    }
    for (const fabric of fabrics) effectiveFabrics.add(fabric.productId);
    for (const listing of listings) {
      let byPlatform = listingsByProduct.get(listing.productId);
      if (!byPlatform) {
        byPlatform = new Map();
        listingsByProduct.set(listing.productId, byPlatform);
      }
      // 同一平台多 listing 时取 updated_at 最新一条（查询已按 updatedAt desc）。
      if (!byPlatform.has(listing.platform)) {
        byPlatform.set(listing.platform, {
          status: listing.status,
          platformState: listing.platformState,
          platformCategoryId: listing.platformCategoryId,
          lastWriteAt: listing.lastSyncedAt ?? listing.updatedAt,
        });
      }
    }
  }
  return { skuCounts, chartVersion, effectiveCharts, effectiveFabrics, listingsByProduct };
}

type ProductAggregation = Awaited<ReturnType<typeof aggregateProductRows>>;

function buildListItem(row: ProductListRow, agg: ProductAggregation) {
  const counts = agg.skuCounts.get(row.id) ?? { skus: 0, colors: new Set<string>() };
  const byPlatform = agg.listingsByProduct.get(row.id);
  const pdd = byPlatform?.get('pdd');
  const ali = byPlatform?.get('1688');
  const qualification = row.qualification;
  const hasQualification =
    qualification !== null &&
    typeof qualification === 'object' &&
    !Array.isArray(qualification) &&
    Object.keys(qualification as Record<string, unknown>).length > 0;
  const hasPlatformCategory = Boolean(
    byPlatform && [...byPlatform.values()].some((listing) => listing.platformCategoryId !== null),
  );
  const missing: string[] = [];
  if (!agg.effectiveCharts.has(row.id)) missing.push(PRODUCT_MISSING_CODES.sizeChart);
  if (!agg.effectiveFabrics.has(row.id)) missing.push(PRODUCT_MISSING_CODES.fabric);
  if (!hasQualification) missing.push(PRODUCT_MISSING_CODES.qualification);
  if (!hasPlatformCategory) missing.push(PRODUCT_MISSING_CODES.platformCategory);
  return {
    id: row.id,
    spu_code: row.spuCode,
    name: row.name,
    category_code: row.categoryCode,
    fit: row.fit,
    color_count: counts.colors.size,
    sku_count: counts.skus,
    status: row.status,
    platform_states: {
      pdd: {
        status: pdd?.status ?? 'not_listed',
        platform_state: pdd?.platformState ?? null,
        last_write_at: pdd?.lastWriteAt?.toISOString() ?? null,
      },
      '1688': {
        status: ali?.status ?? 'not_listed',
        platform_state: ali?.platformState ?? null,
        last_write_at: ali?.lastWriteAt?.toISOString() ?? null,
      },
    },
    missing_fields: missing,
    size_chart_version: agg.chartVersion.get(row.id) ?? 0,
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listProducts(deps: ProductServiceDeps, query: ProductListQuery) {
  const where: Prisma.ProductWhereInput = { orgId: 1n, archivedAt: null };
  if (query.category_code) where.categoryCode = query.category_code;
  if (query.status) where.status = query.status;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { spuCode: { contains: query.q, mode: 'insensitive' } },
    ];
  }
  if (query.platform) {
    const platformProducts = await deps.prisma.listing.findMany({
      where: { orgId: 1n, platform: query.platform, archivedAt: null },
      select: { productId: true },
      distinct: ['productId'],
    });
    where.id = { in: platformProducts.map((row) => row.productId) };
  }

  // 游标语义不变：spu_code 严格大于 cursor（升序稳定分页）。
  const cursorWhere: Prisma.ProductWhereInput = query.cursor
    ? { ...where, spuCode: { gt: query.cursor } }
    : where;
  const need = query.limit + 1; // 多取一条用于判断 nextCursor

  if (!query.missing_fields) {
    // 快速路径：无聚合依赖过滤 → take/skip 直接下推。
    const rows = await deps.prisma.product.findMany({
      where: cursorWhere,
      orderBy: { spuCode: 'asc' },
      take: need,
      select: PRODUCT_LIST_SELECT,
    });
    const agg = await aggregateProductRows(deps, rows);
    const items = rows.map((row) => buildListItem(row, agg));
    return {
      items: items.slice(0, query.limit),
      nextCursor: items.length > query.limit ? items[query.limit - 1]!.spu_code : null,
    };
  }

  // 过滤路径：缺失字段依赖聚合，无法纯 SQL 下推 → 分批扫描 + 早停。
  const collected: ReturnType<typeof buildListItem>[] = [];
  let scanCursor = query.cursor ?? null;
  for (;;) {
    const batchWhere: Prisma.ProductWhereInput = scanCursor ? { ...where, spuCode: { gt: scanCursor } } : where;
    const rows = await deps.prisma.product.findMany({
      where: batchWhere,
      orderBy: { spuCode: 'asc' },
      take: SCAN_BATCH,
      select: PRODUCT_LIST_SELECT,
    });
    if (rows.length === 0) break;
    const agg = await aggregateProductRows(deps, rows);
    for (const row of rows) {
      const item = buildListItem(row, agg);
      if (item.missing_fields.length > 0) collected.push(item);
      if (collected.length >= need) break;
    }
    if (collected.length >= need) break;
    if (rows.length < SCAN_BATCH) break;
    scanCursor = rows[rows.length - 1]!.spuCode;
  }
  return {
    items: collected.slice(0, query.limit),
    nextCursor: collected.length > query.limit ? collected[query.limit - 1]!.spu_code : null,
  };
}

export async function getProduct(deps: ProductServiceDeps, id: string) {
  const product = await deps.prisma.product.findFirst({
    where: { id, orgId: 1n, archivedAt: null },
  });
  if (!product) throw new ApiError('not_found', '商品不存在');

  const [skus, charts, fabrics, attributes] = await Promise.all([
    deps.prisma.productSku.findMany({
      where: { productId: id, archivedAt: null },
      orderBy: [{ colorId: 'asc' }, { sizeCode: 'asc' }],
    }),
    deps.prisma.sizeChart.findMany({
      where: { productId: id, archivedAt: null },
      orderBy: [{ versionNo: 'desc' }, { sizeOrder: 'asc' }],
    }),
    deps.prisma.fabricComposition.findMany({
      where: { productId: id, archivedAt: null, status: 'effective' },
      orderBy: [{ role: 'asc' }, { versionNo: 'desc' }],
    }),
    deps.prisma.platformAttributeMapping.findMany({
      where: { productId: id, archivedAt: null },
      orderBy: { attrPath: 'asc' },
    }),
  ]);

  return {
    product: {
      id: product.id,
      spu_code: product.spuCode,
      name: product.name,
      category_code: product.categoryCode,
      fit: product.fit,
      description: product.notes,
      status: product.status,
      fact_version: product.factVersion,
    },
    skus: skus.map((sku) => ({
      id: sku.id,
      sku_code: sku.skuCode,
      color_id: sku.colorId,
      color_name: sku.colorName,
      size_code: sku.sizeCode,
      fabric_code: sku.fabricCode,
      price_cents: sku.priceCents,
      list_price_cents: sku.listPriceCents,
      sale_price_cents: sku.salePriceCents,
      stock: sku.stockQty,
      min_order_qty: sku.minOrderQty,
    })),
    size_chart: charts.map((row) => ({
      sku_size_code: row.skuSizeCode,
      version_no: row.versionNo,
      size_order: row.sizeOrder,
      effective_from: row.effectiveFrom.toISOString(),
      measurements: row.measurements,
      recommend_height_min: row.recommendHeightMin,
      recommend_height_max: row.recommendHeightMax,
      recommend_weight_min: row.recommendWeightMin,
      recommend_weight_max: row.recommendWeightMax,
    })),
    fabric: fabrics.flatMap((row) =>
      (row.materials as Array<{ material: string; percent: number; note?: string }>).map((item) => ({
        material: item.material,
        percent: item.percent,
        note: item.note ?? row.role,
      })),
    ),
    attributes: attributes.map((row) => ({
      platform: row.platform,
      attr_path: row.attrPath,
      internal_value: row.internalValue,
      platform_value_id: row.platformValueId,
      status: row.status,
    })),
    media_summary: { counts: {} },
  };
}

// ------------------------------------------------------------
// PUT size-chart / fabric / attributes
// ------------------------------------------------------------

export async function putSizeChart(
  deps: ProductServiceDeps,
  productId: string,
  input: SizeChartPutInput,
  context: ServiceContext,
) {
  const product = await deps.prisma.product.findFirst({
    where: { id: productId, archivedAt: null },
    select: { id: true, categoryCode: true },
  });
  if (!product) throw new ApiError('not_found', '商品不存在');

  const chart = {
    version_no: input.version_no ?? 1,
    size_system: input.size_system ?? 'alpha',
    unit: 'cm' as const,
    effective_from: input.effective_from,
    effective_to: input.effective_to ?? null,
    source: input.source ?? 'manual',
    ...(input.fit_note ? { fit_note: input.fit_note } : {}),
    sizes: input.items,
  };
  const validation = validateSizeChart(chart, { categoryCode: product.categoryCode });
  assertValid(validation, '尺码表');
  const normalized = validation.value!;

  const max = await deps.prisma.sizeChart.aggregate({
    where: { productId, archivedAt: null },
    _max: { versionNo: true },
  });
  const versionNo = input.version_no ?? (max._max.versionNo ?? 0) + 1;
  const effectiveFrom = new Date(normalized.effective_from);
  const checksum = checksumOf(normalized.sizes);

  await deps.prisma.$transaction(async (tx) => {
    await tx.sizeChart.updateMany({
      where: { productId, status: 'effective', archivedAt: null },
      data: { status: 'superseded' },
    });
    for (const size of normalized.sizes) {
      await tx.sizeChart.create({
        data: {
          orgId: 1n,
          productId,
          versionNo,
          status: 'effective',
          sizeSystem: normalized.size_system,
          skuSizeCode: String(size.sku_size_code),
          sizeOrder: Number(size.size_order),
          measurements: size.measurements as Prisma.InputJsonValue,
          recommendHeightMin: (size.recommend_height_min as number | undefined) ?? null,
          recommendHeightMax: (size.recommend_height_max as number | undefined) ?? null,
          recommendWeightMin: (size.recommend_weight_min as number | undefined) ?? null,
          recommendWeightMax: (size.recommend_weight_max as number | undefined) ?? null,
          fitNote: normalized.fit_note ?? null,
          source: normalized.source,
          effectiveFrom,
          effectiveTo: normalized.effective_to ? new Date(normalized.effective_to) : null,
          checksum,
          createdBy: context.userId,
        },
      });
    }
    await tx.product.update({ where: { id: productId }, data: { factVersion: { increment: 1 } } });
  });

  const skuCodes = await deps.prisma.productSku.findMany({
    where: { productId, archivedAt: null, status: 'active' },
    select: { sizeCode: true },
  });
  const chartCodes = new Set(normalized.sizes.map((size) => String(size.sku_size_code)));
  const affected = skuCodes.filter((sku) => chartCodes.has(sku.sizeCode)).length;

  await deps.audit.record({
    action: 'product.size_chart',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'product',
    resourceId: productId,
    after: { version_no: versionNo, sizes: normalized.sizes.length, checksum },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return { version_no: versionNo, affected_skus: affected, render_jobs: [] as string[] };
}

export async function putFabric(
  deps: ProductServiceDeps,
  productId: string,
  input: FabricPutInput,
  context: ServiceContext,
) {
  const product = await deps.prisma.product.findFirst({
    where: { id: productId, archivedAt: null },
    select: { id: true },
  });
  if (!product) throw new ApiError('not_found', '商品不存在');
  const validation = validateFabricComposition(input.items);
  assertValid(validation, '面料成分');
  const materials = validation.value!;
  const fabricCode = input.fabric_code ?? 'MAIN';
  if (!/^[A-Z0-9-]{2,16}$/.test(fabricCode)) {
    throw new ApiError('validation_failed', 'fabric_code 格式非法', {
      detail: { field: 'fabric_code' },
    });
  }
  const max = await deps.prisma.fabricComposition.aggregate({
    where: { productId, fabricCode, archivedAt: null },
    _max: { versionNo: true },
  });
  const versionNo = (max._max.versionNo ?? 0) + 1;
  const effectiveFrom = new Date(input.effective_from ?? new Date().toISOString());
  const checksum = checksumOf({ productId, fabricCode, materials });
  await deps.prisma.$transaction(async (tx) => {
    await tx.fabricComposition.updateMany({
      where: { productId, fabricCode, status: 'effective', archivedAt: null },
      data: { status: 'superseded' },
    });
    await tx.fabricComposition.create({
      data: {
        orgId: 1n,
        productId,
        versionNo,
        fabricCode,
        fabricName: input.fabric_name ?? '主料',
        role: input.role ?? 'main',
        materials: materials as unknown as Prisma.InputJsonValue,
        status: 'effective',
        source: input.source ?? 'manual',
        effectiveFrom,
        checksum,
        createdBy: context.userId,
      },
    });
    await tx.product.update({ where: { id: productId }, data: { factVersion: { increment: 1 } } });
  });
  const affected = await deps.prisma.productSku.count({
    where: { productId, archivedAt: null, status: 'active' },
  });
  await deps.audit.record({
    action: 'product.fabric',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'product',
    resourceId: productId,
    after: { version_no: versionNo, materials: fabricText(materials) },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return { version: versionNo, affected_skus: affected };
}

export async function putAttributes(
  deps: ProductServiceDeps,
  productId: string,
  input: AttributesPutInput,
  context: ServiceContext,
) {
  const product = await deps.prisma.product.findFirst({
    where: { id: productId, archivedAt: null },
    select: { id: true },
  });
  if (!product) throw new ApiError('not_found', '商品不存在');
  if (!Array.isArray(input.mapping) || input.mapping.length === 0) {
    throw new ApiError('validation_failed', 'mapping 不能为空', { detail: { field: 'mapping' } });
  }
  const validated = input.mapping.map((entry, index) => {
    const candidate: Record<string, unknown> = {
      ...entry,
      platform: input.platform,
      product_id: productId,
      source: entry.source ?? 'manual',
      status: entry.status ?? 'draft',
    };
    const result = validatePlatformAttributeMapping(candidate);
    if (!result.ok) {
      throw new ApiError('validation_failed', `属性映射第 ${index + 1} 条非法`, {
        detail: { issues: result.issues },
      });
    }
    const categoryId = String(candidate.platform_category_id);
    if (!UUID_RE.test(categoryId)) {
      throw new ApiError('validation_failed', 'platform_category_id 必须是 UUID', {
        detail: { field: `mapping[${index}].platform_category_id` },
      });
    }
    return candidate;
  });

  const categoryIds = [...new Set(validated.map((entry) => String(entry.platform_category_id)))];
  const categories = await deps.prisma.platformCategory.findMany({
    where: { id: { in: categoryIds }, archivedAt: null },
    select: { id: true, platform: true, isLeaf: true, archivedAt: true },
  });
  const categoryMap = new Map(categories.map((row) => [row.id, row]));
  for (const categoryId of categoryIds) {
    const category = categoryMap.get(categoryId);
    if (!category) {
      throw new ApiError('not_found', `平台类目不存在：${categoryId}`);
    }
    if (!category.isLeaf) {
      throw new ApiError('invalid_fact', '平台类目必须是叶子类目', {
        detail: { platform_category_id: categoryId },
      });
    }
    if (category.platform !== input.platform) {
      throw new ApiError('invalid_fact', '平台类目与映射平台不一致', {
        detail: { platform_category_id: categoryId },
      });
    }
  }

  await deps.prisma.$transaction(async (tx) => {
    await tx.platformAttributeMapping.updateMany({
      where: { productId, platform: input.platform, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    for (const entry of validated) {
      await tx.platformAttributeMapping.create({
        data: {
          orgId: 1n,
          platform: input.platform,
          platformCategoryId: String(entry.platform_category_id),
          productId,
          attrPath: String(entry.attr_path),
          attrType: String(entry.attr_type),
          internalField: String(entry.internal_field),
          internalValue: String(entry.internal_value),
          platformValueId: entry.platform_value_id === null || entry.platform_value_id === undefined
            ? null
            : String(entry.platform_value_id),
          platformValueName: entry.platform_value_name === null || entry.platform_value_name === undefined
            ? null
            : String(entry.platform_value_name),
          extra: (entry.extra ?? {}) as Prisma.InputJsonValue,
          status: String(entry.status ?? 'draft'),
          source: String(entry.source ?? 'manual'),
          verifiedAt: entry.status === 'verified' ? new Date() : null,
          verifiedBy: entry.status === 'verified' ? context.userId : null,
          createdBy: context.userId,
        },
      });
    }
    await tx.product.update({ where: { id: productId }, data: { factVersion: { increment: 1 } } });
  });

  await deps.audit.record({
    action: 'product.attributes',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'product',
    resourceId: productId,
    after: { platform: input.platform, count: validated.length },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return { version: 1, unmapped: [] as string[] };
}

// ------------------------------------------------------------
// CSV 导入
// ------------------------------------------------------------

export interface ImportOptions {
  dryRun: boolean;
  platformScope?: 'pdd' | '1688' | 'both';
}

interface CsvTable {
  headers: string[];
  rows: Array<{ rowNumber: number; values: Record<string, string> }>;
}

export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const nonEmpty = records.filter((record) => record.some((value) => value.trim() !== ''));
  if (nonEmpty.length === 0) throw new ApiError('validation_failed', 'CSV 为空');
  const headers = nonEmpty[0]!.map((header) => header.trim().toLowerCase());
  const rows = nonEmpty.slice(1).map((record, index) => ({
    rowNumber: index + 1,
    values: Object.fromEntries(headers.map((header, column) => [header, record[column]?.trim() ?? ''])),
  }));
  return { headers, rows };
}

const REQUIRED_CSV_HEADERS = [
  'spu_code', 'name', 'category_code', 'color_id', 'size_code', 'price_cents',
  'fabric_materials', 'measurements',
];

export interface ImportResult {
  import_id: string;
  rows_total: number;
  rows_ok: number;
  rows_failed: Array<{ row: number; field: string; reason: string }>;
  warnings: string[];
  dry_run: boolean;
}

export async function importProductsCsv(
  deps: ProductServiceDeps,
  csv: string,
  options: ImportOptions,
  context: ServiceContext,
): Promise<ImportResult> {
  const table = parseCsv(csv);
  const missing = REQUIRED_CSV_HEADERS.filter((header) => !table.headers.includes(header));
  if (missing.length > 0) {
    throw new ApiError('validation_failed', `CSV 缺少列：${missing.join(',')}`, {
      detail: { issues: missing.map((field) => issue('SCHEMA-001', field, '缺少必填列')) },
    });
  }
  const groups = new Map<string, ProductCreateInput>();
  const failures: ImportResult['rows_failed'] = [];

  for (const row of table.rows) {
    const value = row.values;
    const spu = value.spu_code!;
    try {
      let materials: unknown;
      try {
        materials = JSON.parse(value.fabric_materials!);
      } catch {
        throw new ApiError('validation_failed', 'fabric_materials 必须是 JSON 数组');
      }
      const sku: SkuInput = {
        color_id: value.color_id!,
        color_name: value.color_name || value.color_id!,
        size_code: value.size_code!,
        price_cents: Number(value.price_cents),
        ...(value.list_price_cents ? { list_price_cents: Number(value.list_price_cents) } : {}),
        ...(value.sale_price_cents ? { sale_price_cents: Number(value.sale_price_cents) } : {}),
        ...(value.stock_qty ? { stock_qty: Number(value.stock_qty) } : {}),
        ...(value.min_order_qty ? { min_order_qty: Number(value.min_order_qty) } : {}),
        ...(value.lead_time_days ? { lead_time_days: Number(value.lead_time_days) } : {}),
        ...(value.weight_g ? { weight_g: Number(value.weight_g) } : {}),
      };
      let measurements: Record<string, number>;
      try {
        measurements = JSON.parse(value.measurements!) as Record<string, number>;
      } catch {
        throw new ApiError('validation_failed', 'measurements 必须是 JSON 对象');
      }
      const chartItem = {
        sku_size_code: value.size_code!,
        measurements,
        ...(value.recommend_height_min ? { recommend_height_min: Number(value.recommend_height_min) } : {}),
        ...(value.recommend_height_max ? { recommend_height_max: Number(value.recommend_height_max) } : {}),
        ...(value.recommend_weight_min ? { recommend_weight_min: Number(value.recommend_weight_min) } : {}),
        ...(value.recommend_weight_max ? { recommend_weight_max: Number(value.recommend_weight_max) } : {}),
      };
      const existing = groups.get(spu);
      if (existing) {
        existing.skus.push(sku);
        existing.size_chart!.items.push(chartItem);
      } else {
        groups.set(spu, {
          spu_code: spu,
          name: value.name!,
          category_code: value.category_code!,
          ...(value.fit ? { fit: value.fit as ProductCreateInput['fit'] } : {}),
          ...(value.description ? { description: value.description } : {}),
          ...(value.brand ? { brand: value.brand } : {}),
          ...(value.season ? { season: value.season as ProductCreateInput['season'] } : {}),
          skus: [sku],
          fabric: {
            materials: materials as Array<{ material: string; percent: number; note?: string }>,
            fabric_code: value.fabric_code || 'MAIN',
            fabric_name: value.fabric_name || '主料',
            role: (value.fabric_role as FabricInput['role']) || 'main',
            source: 'import',
          },
          size_chart: {
            version_no: 1,
            size_system: (value.size_system as SizeChartPutInput['size_system']) ?? 'alpha',
            effective_from: value.effective_from || new Date().toISOString().slice(0, 10),
            source: 'import',
            items: [chartItem],
          },
        });
      }
    } catch (error) {
      failures.push({
        row: row.rowNumber,
        field: 'csv',
        reason: error instanceof ApiError ? error.message : String(error),
      });
    }
  }

  // 整组校验（同 SPU 多行汇总后校验）
  for (const [spu, input] of groups) {
    try {
      validateSkuInput(input.skus);
      validateFabric(input.fabric);
      const chartValidation = validateSizeChart(
        {
          version_no: input.size_chart?.version_no ?? 1,
          size_system: input.size_chart?.size_system ?? 'alpha',
          unit: 'cm',
          effective_from: input.size_chart?.effective_from ?? new Date().toISOString().slice(0, 10),
          effective_to: input.size_chart?.effective_to ?? null,
          source: input.size_chart?.source ?? 'import',
          sizes: input.size_chart?.items ?? [],
        },
        { categoryCode: input.category_code },
      );
      assertValid(chartValidation, '尺码表');
    } catch (error) {
      failures.push({
        row: 0,
        field: spu,
        reason: error instanceof ApiError ? error.message : String(error),
      });
    }
  }

  if (options.dryRun) {
    return {
      import_id: randomUUID(),
      rows_total: table.rows.length,
      rows_ok: failures.length === 0 ? table.rows.length : 0,
      rows_failed: failures,
      warnings: [],
      dry_run: true,
    };
  }
  if (failures.length > 0) {
    throw new ApiError('validation_failed', 'CSV 存在非法行，未写入任何数据', {
      detail: { rows_failed: failures },
    });
  }

  const importId = randomUUID();
  let createdCount = 0;
  try {
    await deps.prisma.$transaction(async (tx) => {
      for (const input of groups.values()) {
        await createProductTransaction(tx, input, context);
        createdCount += 1;
      }
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
      throw new ApiError('conflict', 'CSV 中存在已存在的 spu_code/SKU');
    }
    throw error;
  }

  await deps.audit.record({
    action: 'product.import',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'product',
    resourceId: null,
    after: {
      import_id: importId,
      products: createdCount,
      rows: table.rows.length,
      platform_scope: options.platformScope ?? 'both',
    },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return {
    import_id: importId,
    rows_total: table.rows.length,
    rows_ok: table.rows.length,
    rows_failed: [],
    warnings: [],
    dry_run: false,
  };
}
