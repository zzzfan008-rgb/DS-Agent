/** 商品主数据路由（docs/12 §3.3）：列表/详情/创建/CSV 导入/尺码表/成分/属性映射。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { parseLimit } from '../lib/cursor.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import {
  createProduct,
  getProduct,
  importProductsCsv,
  listProducts,
  putAttributes,
  putFabric,
  putSizeChart,
  type ProductServiceDeps,
} from '../services/products.js';

const ListQuery = z.object({
  q: z.string().min(1).max(100).optional(),
  category_code: z.string().min(1).max(20).optional(),
  platform: z.enum(['pdd', '1688']).optional(),
  status: z.enum(['draft', 'active', 'inactive', 'archived']).optional(),
  missing_fields: z.enum(['0', '1']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.string().optional(),
  with_total: z.enum(['0', '1']).optional(),
});

const Sku = z.object({
  color_id: z.string().min(1),
  color_name: z.string().min(1).max(60).optional(),
  size_code: z.string().min(1),
  price_cents: z.number().int().positive(),
  list_price_cents: z.number().int().positive().optional(),
  sale_price_cents: z.number().int().positive().optional(),
  stock_qty: z.number().int().min(0).optional(),
  min_order_qty: z.number().int().min(1).optional(),
  lead_time_days: z.number().int().min(0).max(60).optional(),
  weight_g: z.number().int().positive().optional(),
  barcode: z.string().min(1).max(64).optional(),
});

const Fabric = z.object({
  materials: z
    .array(
      z.object({
        material: z.string().min(1),
        percent: z.number().int().min(1).max(100),
        note: z.string().optional(),
        fiber_code: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
  fabric_code: z.string().min(2).max(16).optional(),
  fabric_name: z.string().min(1).max(60).optional(),
  role: z.enum(['main', 'lining', 'trim', 'accessory']).optional(),
  source: z.enum(['import', 'erp', 'manual', 'platform_sync', 'supplier']).optional(),
  effective_from: z.string().optional(),
});

const SizeChartPut = z.object({
  items: z
    .array(
      z.object({
        sku_size_code: z.string().min(1),
        measurements: z.record(z.string(), z.number()),
        recommend_height_min: z.number().int().optional(),
        recommend_height_max: z.number().int().optional(),
        recommend_weight_min: z.number().int().optional(),
        recommend_weight_max: z.number().int().optional(),
        extra_measures: z.record(z.string(), z.number()).optional(),
      }),
    )
    .min(1)
    .max(30),
  version_no: z.number().int().min(1).max(999).optional(),
  effective_from: z.string().min(8),
  effective_to: z.string().nullable().optional(),
  size_system: z.enum(['alpha', 'numeric', 'height_weight', 'one_size']).optional(),
  source: z.enum(['import', 'erp', 'manual', 'platform_sync', 'supplier']).optional(),
  fit_note: z.string().max(200).optional(),
});

const ProductCreate = z.object({
  spu_code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{3,39}$/),
  name: z.string().min(1).max(120),
  category_code: z.string().regex(/^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/),
  fit: z.enum(['slim', 'regular', 'loose', 'oversize']).optional(),
  description: z.string().max(2000).optional(),
  brand: z.string().max(60).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter', 'all']).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  skus: z.array(Sku).min(1).max(200),
  fabric: Fabric,
  size_chart: SizeChartPut.optional(),
});

const FabricPut = z.object({
  items: z
    .array(
      z.object({
        material: z.string().min(1),
        percent: z.number().int().min(1).max(100),
        note: z.string().optional(),
        fiber_code: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
  fabric_code: z.string().min(2).max(16).optional(),
  fabric_name: z.string().min(1).max(60).optional(),
  role: z.enum(['main', 'lining', 'trim', 'accessory']).optional(),
  effective_from: z.string().optional(),
  source: z.enum(['import', 'erp', 'manual', 'platform_sync', 'supplier']).optional(),
});

const AttributesPut = z.object({
  platform: z.enum(['pdd', '1688']),
  mapping: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
});

const ImportBody = z.object({
  csv: z.string().min(1),
  dry_run: z.boolean().optional(),
  platform_scope: z.enum(['pdd', '1688', 'both']).optional(),
});

export function registerProductRoutes(app: FastifyInstance): void {
  const deps: ProductServiceDeps = { prisma: app.prisma, audit: app.audit };

  app.get('/api/products', { config: { minRole: 'viewer' } }, async (request, reply) => {
    const query = ListQuery.parse(request.query ?? {});
    const limit = parseLimit(query.limit);
    const result = await listProducts(deps, {
      ...(query.q === undefined ? {} : { q: query.q }),
      ...(query.category_code === undefined ? {} : { category_code: query.category_code }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit,
    });
    if (query.with_total === '1') {
      const total = await app.prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
      reply.header('X-Total-Count', String(total));
    }
    return ok(request, { items: result.items }, { next_cursor: result.nextCursor });
  });

  app.get('/api/products/:id', { config: { minRole: 'viewer' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return ok(request, await getProduct(deps, params.id));
  });

  app.post('/api/products', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    const body = ProductCreate.parse(request.body ?? {});
    const created = await createProduct(deps, body, context);
    request.auditLogged = true;
    reply.code(201);
    return ok(request, created);
  });

  app.post('/api/products/import', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = serviceContext(request);
    let csv: string;
    let dryRun = false;
    let platformScope: 'pdd' | '1688' | 'both' | undefined;

    if (request.isMultipart()) {
      const file = await request.file();
      if (!file) throw new ApiError('validation_failed', '缺少 CSV 文件', { detail: { field: 'file' } });
      const buffer = await file.toBuffer();
      csv = buffer.toString('utf8');
      const fields = file.fields as Record<string, { value?: unknown } | undefined>;
      dryRun = String(fields.dry_run?.value ?? 'false') === 'true';
      const scope = String(fields.platform_scope?.value ?? 'both');
      platformScope = scope === 'pdd' || scope === '1688' ? scope : 'both';
    } else {
      const body = ImportBody.parse(request.body ?? {});
      csv = body.csv;
      dryRun = body.dry_run ?? false;
      platformScope = body.platform_scope ?? 'both';
    }

    const result = await importProductsCsv(
      deps,
      csv,
      { dryRun, ...(platformScope === undefined ? {} : { platformScope }) },
      context,
    );
    request.auditLogged = true;
    if (!dryRun) reply.code(201);
    return ok(request, result);
  });

  app.put('/api/products/:id/size-chart', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = serviceContext(request);
    const body = SizeChartPut.parse(request.body ?? {});
    const result = await putSizeChart(deps, params.id, body, context);
    request.auditLogged = true;
    return ok(request, result);
  });

  app.put('/api/products/:id/fabric', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = serviceContext(request);
    const body = FabricPut.parse(request.body ?? {});
    const result = await putFabric(deps, params.id, body, context);
    request.auditLogged = true;
    return ok(request, result);
  });

  app.put('/api/products/:id/attributes', { config: { minRole: 'operator' } }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const context = serviceContext(request);
    const body = AttributesPut.parse(request.body ?? {});
    const result = await putAttributes(deps, params.id, body, context);
    request.auditLogged = true;
    return ok(request, result);
  });
}
