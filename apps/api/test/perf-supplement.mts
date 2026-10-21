/**
 * M9 性能补测（对应 docs/M9-上线检查清单 项 38、39）。
 *
 * 两个问题，两个答案：
 *   A. 商品列表在 10,000 条数据下的 p95 是多少？与 1,000 条（44.5ms）怎么比？
 *   B. DB 连接池被打满时，API 是 5xx、超时，还是优雅排队？第一个失败点在哪？
 *
 * 测量口径（重要，避免和旧数据误比）：
 * - 「服务级」直接调 `listProducts()`（与 t28 的 44.5ms 同口径），重复 N 次取分位；
 * - 「HTTP 级」走真实 Fastify + 登录会话（含鉴权、序列化、网络栈），是用户实际感受；
 * - 两档数据量在**同一个进程、同一套参数**下测，只有行数不同。
 *
 * 用法（隔离库，库名 _test 结尾；建议用独立库，会灌 1 万行）：
 *   cd apps/api
 *   DATABASE_URL="postgresql://.../dssaas_m9perf_test?schema=public" \
 *   TEST_DATABASE_URL="$DATABASE_URL" LOG_LEVEL=silent \
 *   ./node_modules/.bin/tsx test/perf-supplement.mts
 *
 * 产出：artifacts/m9/perf-supplement.json + 控制台摘要
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';
import { listProducts } from '../src/services/products.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
if (!DB_URL) {
  console.error('[perf] 缺少 DATABASE_URL/TEST_DATABASE_URL');
  process.exit(2);
}
const dbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  console.error(`[perf] 拒绝在非隔离库上压测：${dbName}`);
  process.exit(2);
}

const REPO_ROOT = path.resolve(process.cwd(), '../..');
const OUT_DIR = path.join(REPO_ROOT, 'artifacts/m9');
const OUT_FILE = path.join(OUT_DIR, 'perf-supplement.json');

const SERVICE_ITERATIONS = Number(process.env.PERF_SERVICE_ITERATIONS ?? 20);
const HTTP_CONCURRENCY = Number(process.env.PERF_HTTP_CONCURRENCY ?? 20);
const HTTP_TOTAL = Number(process.env.PERF_HTTP_TOTAL ?? 100);
const POOL_LIMIT = Number(process.env.PERF_POOL_LIMIT ?? 5);
const POOL_CONCURRENCY = Number(process.env.PERF_POOL_CONCURRENCY ?? 60);
const SUFFIX = randomUUID().slice(0, 8);
const SPU_SUFFIX = SUFFIX.toUpperCase();

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const report: Record<string, unknown> = {
  run_id: randomUUID(),
  started_at: new Date().toISOString(),
  database: maskUrl(DB_URL),
  node: process.version,
  cpu_count: (await import('node:os')).cpus().length,
};

/** size_chart / fabric_composition 的 checksum 有 CHECK: char_length = 64。 */
function checksumFor(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function maskUrl(raw: string): string {  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(invalid)';
  }
}

function percentile(values: number[], p: number): number {  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function summarize(latencies: number[], errors: Array<{ status: number; code: string }>, durationMs: number) {
  return {
    requests: latencies.length,
    errors: errors.length,
    error_rate: latencies.length + errors.length === 0 ? 0 : Number((errors.length / (latencies.length + errors.length)).toFixed(4)),
    throughput_rps: durationMs <= 0 ? 0 : Number((latencies.length / (durationMs / 1000)).toFixed(2)),
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : 0,
      min: latencies.length ? Number(Math.min(...latencies).toFixed(2)) : 0,
      mean: latencies.length
        ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2))
        : 0,
    },
    duration_ms: Math.round(durationMs),
    error_samples: errors.slice(0, 5),
  };
}

async function dbStats() {
  const rows = await prisma.$queryRawUnsafe<Array<{ datname: string; state: string; n: number }>>(
    `select datname, coalesce(state,'') as state, count(*)::int as n
       from pg_stat_activity where datname = current_database()
      group by 1,2 order by 3 desc`,
  );
  return rows;
}

async function pgSetting(name: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ setting: string }>>(
    `select setting from pg_settings where name = $1`,
    name,
  );
  return rows[0]?.setting ?? null;
}

// ------------------------------------------------------------
// 造数：把商品从 base 扩到 target（只补差量，避免重复灌）
// ------------------------------------------------------------
/**
 * 清空本脚本自己灌的数据。
 *
 * 必要性：这个脚本会被反复跑，如果不清，「1,000 条」那一轮测到的其实是上一轮留下的
 * 10,000 条 —— 两档数字会变成一样，结论直接错。所以每档测量前都回到干净状态。
 * 只删 spu_code 以 PERF- 开头的商品及其子行，不动其他数据。
 */
async function resetPerfData(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { orgId: 1n, spuCode: { startsWith: 'PERF-' } },
    select: { id: true },
  });
  const ids = products.map((row) => row.id);
  if (ids.length === 0) return;
  // 顺序：先删引用 product 的子表，再删 product（外键 RESTRICT）
  await prisma.platformAttributeMapping.deleteMany({ where: { productId: { in: ids } } });
  await prisma.mediaAsset.deleteMany({ where: { productId: { in: ids } } });
  await prisma.contentDraft.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productSku.deleteMany({ where: { productId: { in: ids } } });
  await prisma.sizeChart.deleteMany({ where: { productId: { in: ids } } });
  await prisma.fabricComposition.deleteMany({ where: { productId: { in: ids } } });
  await prisma.listing.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

async function seedProductsTo(target: number, operatorId: string, prefix: string): Promise<number> {
  const existing = await prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
  if (existing >= target) return existing;
  const need = target - existing;
  const batch: Array<{
    orgId: bigint;
    spuCode: string;
    name: string;
    categoryCode: string;
    createdBy: string;
  }> = [];
  for (let index = 0; index < need; index += 1) {
    batch.push({
      orgId: 1n,
      spuCode: `${prefix}-${String(existing + index).padStart(6, '0')}`,
      name: `性能补测商品 ${existing + index}`,
      categoryCode: 'A0101',
      createdBy: operatorId,
    });
  }
  for (let offset = 0; offset < batch.length; offset += 500) {
    await prisma.product.createMany({ data: batch.slice(offset, offset + 500) });
  }
  return prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
}

/** 让 10,000 行不是「空壳」：给每个商品挂 SKU / 尺码表 / 面料 / listing，才像真实聚合负载。 */
async function attachChildRows(operatorId: string): Promise<{
  skus: number;
  charts: number;
  fabrics: number;
  listings: number;
}> {
  const products = await prisma.product.findMany({
    where: { orgId: 1n, archivedAt: null, spuCode: { startsWith: 'PERF-' } },
    select: { id: true },
    orderBy: { spuCode: 'asc' },
  });
  const ids = products.map((row) => row.id);
  // 只统计还没挂子行的商品（reset 后每次都是全量补，避免上一轮残留导致误判）
  const existingSkus = await prisma.productSku.count({ where: { productId: { in: ids } } });
  if (existingSkus >= ids.length) {
    return {
      skus: existingSkus,
      charts: await prisma.sizeChart.count({ where: { productId: { in: ids } } }),
      fabrics: await prisma.fabricComposition.count({ where: { productId: { in: ids } } }),
      listings: await prisma.listing.count({ where: { productId: { in: ids } } }),
    };
  }
  const withSku = new Set(
    (
      await prisma.productSku.findMany({
        where: { productId: { in: ids } },
        select: { productId: true },
        distinct: ['productId'],
      })
    ).map((row) => row.productId),
  );
  const withChart = new Set(
    (
      await prisma.sizeChart.findMany({
        where: { productId: { in: ids } },
        select: { productId: true },
        distinct: ['productId'],
      })
    ).map((row) => row.productId),
  );
  const withFabric = new Set(
    (
      await prisma.fabricComposition.findMany({
        where: { productId: { in: ids } },
        select: { productId: true },
        distinct: ['productId'],
      })
    ).map((row) => row.productId),
  );
  const withListing = new Set(
    (
      await prisma.listing.findMany({
        where: { productId: { in: ids } },
        select: { productId: true },
        distinct: ['productId'],
      })
    ).map((row) => row.productId),
  );
  const needChart = ids.filter((id) => !withChart.has(id));
  const needFabric = ids.filter((id) => !withFabric.has(id));
  const needSku = ids.filter((id) => !withSku.has(id));
  const needListing = ids.filter((id) => !withListing.has(id));
  void needSku;
  // 顺序有依赖：size_chart 必须先于 product_sku（触发器 trg_sku_size_exists 校验尺码表存在）。
  const chartRows = needChart.map((productId, index) => ({
    orgId: 1n,
    productId,
    versionNo: 1,
    status: 'effective',
    sizeSystem: 'alpha',
    skuSizeCode: 'M',
    sizeOrder: index % 5,
    measurements: { 胸围: 100, 衣长: 70 },
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    checksum: checksumFor(`chart-${productId}`),
    createdBy: operatorId,
  }));
  for (let offset = 0; offset < chartRows.length; offset += 500) {
    await prisma.sizeChart.createMany({ data: chartRows.slice(offset, offset + 500) });
  }
  const fabricRows = needFabric.map((productId) => ({
    orgId: 1n,
    productId,
    role: 'main',
    versionNo: 1,
    status: 'effective',
    fabricCode: 'FAB-0101',
    fabricName: '纯棉',
    materials: [{ material: '棉', percent: 100 }],
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    checksum: checksumFor(`fabric-${productId}`),
    createdBy: operatorId,
  }));
  for (let offset = 0; offset < fabricRows.length; offset += 500) {
    await prisma.fabricComposition.createMany({ data: fabricRows.slice(offset, offset + 500) });
  }
  const skuRows = needSku.map((productId, index) => ({
    orgId: 1n,
    productId,
    colorId: index % 2 === 0 ? 'BK-0101' : 'WH-0101',
    colorName: index % 2 === 0 ? '黑色' : '白色',
    sizeCode: 'M',
    fabricCode: 'FAB-0101',
    // sku_code 有 (org_id, sku_code) 唯一索引；uuid v7 前缀是时间戳（同批相同），
    // 必须用完整 uuid 才能保证跨批次唯一。长度 4+32=36，符合 ^[A-Z0-9][A-Z0-9-]{3,59}$。
    skuCode: `SKU-${productId.replace(/-/g, '').toUpperCase()}`,
    priceCents: 9900,
    createdBy: operatorId,
  }));
  for (let offset = 0; offset < skuRows.length; offset += 500) {
    await prisma.productSku.createMany({ data: skuRows.slice(offset, offset + 500) });
  }
  // published listing 必须已有平台类目（ck_listing_published_category + trg_listing_category_platform）。
  const categories: Record<'pdd' | '1688', string> = { pdd: '', '1688': '' };
  for (const platform of ['pdd', '1688'] as const) {
    const existing = await prisma.platformCategory.findFirst({
      where: { orgId: 1n, platform, archivedAt: null },
      select: { id: true },
    });
    if (existing) {
      categories[platform] = existing.id;
      continue;
    }
    const row = await prisma.platformCategory.create({
      data: {
        orgId: 1n,
        platform,
        externalCategoryId: `PERF-CAT-${platform.toUpperCase()}`,
        name: `性能补测类目 ${platform}`,
        path: ['女装', '上衣'],
        level: 2,
        isLeaf: true,
      },
    });
    categories[platform] = row.id;
  }

  const listingRows = needListing.map((productId, index) => {
    const platform: 'pdd' | '1688' = index % 2 === 0 ? 'pdd' : '1688';
    return {
      orgId: 1n,
      platform,
      productId,
      status: 'published',
      platformCategoryId: categories[platform],
      createdBy: operatorId,
    };
  });
  for (let offset = 0; offset < listingRows.length; offset += 500) {
    await prisma.listing.createMany({ data: listingRows.slice(offset, offset + 500) });
  }
  return {
    skus: await prisma.productSku.count({ where: { productId: { in: ids } } }),
    charts: await prisma.sizeChart.count({ where: { productId: { in: ids } } }),
    fabrics: await prisma.fabricComposition.count({ where: { productId: { in: ids } } }),
    listings: await prisma.listing.count({ where: { productId: { in: ids } } }),
  };
}

// ------------------------------------------------------------
// A. 商品列表性能
// ------------------------------------------------------------
async function measureService(app: any, label: string, missingFields: boolean) {
  // listProducts 查的是 org 全表，所以必须记录「测量时刻的真实总行数」，否则对比会失真。
  const totalRows = await prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
  const latencies: number[] = [];
  for (let index = 0; index < SERVICE_ITERATIONS; index += 1) {
    const started = performance.now();
    await listProducts(
      { prisma: app.prisma, audit: app.audit },
      { limit: 20, missing_fields: missingFields },
    );
    latencies.push(Number((performance.now() - started).toFixed(2)));
  }
  return {
    label,
    total_product_rows: totalRows,
    missing_fields: missingFields,
    iterations: SERVICE_ITERATIONS,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Number(Math.max(...latencies).toFixed(2)),
      min: Number(Math.min(...latencies).toFixed(2)),
      mean: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)),
    },
  };
}

async function measureHttp(
  apiBase: string,
  session: { cookie: string; csrf: string },
  label: string,
  query: string,
  concurrency = HTTP_CONCURRENCY,
  total = HTTP_TOTAL,
) {
  const latencies: number[] = [];
  const errors: Array<{ status: number; code: string }> = [];
  const started = Date.now();
  let issued = 0;
  const worker = async () => {
    while (issued < total) {
      issued += 1;
      const t0 = performance.now();
      try {
        const response = await fetch(`${apiBase}/api/products?${query}`, {
          headers: { cookie: session.cookie, accept: 'application/json' },
        });
        const text = await response.text();
        const elapsed = Number((performance.now() - t0).toFixed(2));
        if (response.ok) latencies.push(elapsed);
        else {
          let code = '';
          try {
            code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '';
          } catch {
            code = '';
          }
          errors.push({ status: response.status, code });
        }
      } catch (error) {
        errors.push({ status: 0, code: (error as Error)?.name ?? 'exception' });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const totalRows = await prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
  return { label, query, concurrency, total_product_rows: totalRows, ...summarize(latencies, errors, Date.now() - started) };
}

// ------------------------------------------------------------
// B. 连接池压测
// ------------------------------------------------------------
interface PoolProbeResult {
  label: string;
  connection_limit: number;
  pool_timeout_s: number;
  concurrency: number;
  total: number;
  ok: number;
  failed: number;
  first_failure: {
    status: number;
    code: string;
    body: string;
    after_ms: number;
    at_request_index: number;
  } | null;
  status_histogram: Record<string, number>;
  error_codes: Record<string, number>;
  latency_ms: Record<string, number>;
  db_connections_peak: number;
  db_connections_samples: number;
  db_stats: unknown;
  duration_ms: number;
}

/**
 * 连接池压测：故意把 connection_limit 设小，用「重查询」把池占满，
 * 观察排队（延迟上升）、超时（pool_timeout）与最终暴露给客户端的错误形态。
 *
 * 关键：用 application_name 把被测池的连接与采样器/主客户端的连接区分开，
 * 否则 pg_stat_activity 统计的是「所有连接」，会误判成池没打满。
 */
async function poolProbe(options: {
  label: string;
  connectionLimit: number;
  poolTimeoutS: number;
  concurrency: number;
  total: number;
  query: string;
}): Promise<PoolProbeResult> {
  const appName = `m9pool_${options.label}`;
  const url = `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=${options.connectionLimit}&pool_timeout=${options.poolTimeoutS}&application_name=${appName}`;
  const poolPrisma = new PrismaClient({ datasources: { db: { url } } });
  // 采样器用独立小池，避免自己抢被测池的连接
  const samplePrisma = new PrismaClient({
    datasources: {
      db: {
        url: `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=1&application_name=m9pool_sample`,
      },
    },
  });
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp(config, { prisma: poolPrisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('端口获取失败');
  const apiBase = `http://127.0.0.1:${address.port}`;

  // 登录（用同一个池，登录本身也会占连接）
  const loginResponse = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${options.label.replace(/[^a-z0-9]/gi, '')}.perf@test.local`, password: 'PerfPassword!2026' }),
  });
  const loginJson = (await loginResponse.json()) as { data?: { csrf_token?: string } };
  const setCookies =
    loginResponse.headers.getSetCookie?.() ?? [loginResponse.headers.get('set-cookie')].filter(Boolean);
  const cookie = (setCookies as Array<string | null | undefined>)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.split(';')[0] ?? '')
    .filter((value) => value.startsWith('dssaas_sid=') || value.startsWith('dssaas_csrf='))
    .join('; ');
  const csrf = loginJson.data?.csrf_token ?? '';
  if (!loginResponse.ok) throw new Error(`池压测登录失败 ${loginResponse.status}`);

  let peak = 0;
  const samples: number[] = [];
  let stopSampling = false;
  const sampler = (async () => {
    while (!stopSampling) {
      try {
        const rows = await samplePrisma.$queryRawUnsafe<Array<{ n: number }>>(
          `select count(*)::int as n from pg_stat_activity where application_name = $1`,
          appName,
        );
        const value = Number(rows[0]?.n ?? 0);
        samples.push(value);
        peak = Math.max(peak, value);
      } catch {
        /* 采样失败忽略，不影响压测 */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();

  const latencies: number[] = [];
  const statusHistogram: Record<string, number> = {};
  const errorCodes: Record<string, number> = {};
  const failures: Array<{ status: number; code: string; body: string; afterMs: number; index: number }> = [];
  const startedAt = Date.now();
  let issued = 0;

  const worker = async () => {
    while (issued < options.total) {
      const index = issued;
      issued += 1;
      const t0 = performance.now();
      try {
        const response = await fetch(`${apiBase}${options.query}`, {
          headers: { cookie, accept: 'application/json' },
        });
        const text = await response.text();
        const elapsed = Number((performance.now() - t0).toFixed(2));
        statusHistogram[String(response.status)] = (statusHistogram[String(response.status)] ?? 0) + 1;
        if (response.ok) {
          latencies.push(elapsed);
        } else {
          let code = '';
          try {
            code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '';
          } catch {
            code = '';
          }
          errorCodes[code || '(none)'] = (errorCodes[code || '(none)'] ?? 0) + 1;
          failures.push({ status: response.status, code, body: text.slice(0, 300), afterMs: elapsed, index });
        }
      } catch (error) {
        statusHistogram.exception = (statusHistogram.exception ?? 0) + 1;
        const code = (error as Error)?.name ?? 'exception';
        errorCodes[code] = (errorCodes[code] ?? 0) + 1;
        failures.push({
          status: 0,
          code,
          body: String((error as Error)?.message ?? error).slice(0, 300),
          afterMs: Number((performance.now() - t0).toFixed(2)),
          index,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  const durationMs = Date.now() - startedAt;
  stopSampling = true;
  await sampler;
  const stats = await dbStats().catch(() => []);
  await app.close();
  await poolPrisma.$disconnect();
  await samplePrisma.$disconnect();

  const first = failures.sort((a, b) => a.afterMs - b.afterMs)[0] ?? null;
  return {
    label: options.label,
    connection_limit: options.connectionLimit,
    pool_timeout_s: options.poolTimeoutS,
    concurrency: options.concurrency,
    total: options.total,
    ok: latencies.length,
    failed: failures.length,
    first_failure: first
      ? {
          status: first.status,
          code: first.code,
          body: first.body,
          after_ms: first.afterMs,
          at_request_index: first.index,
        }
      : null,
    status_histogram: statusHistogram,
    error_codes: errorCodes,
    latency_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : 0,
      mean: latencies.length
        ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2))
        : 0,
    },
    db_connections_peak: peak,
    db_connections_samples: samples.length,
    db_stats: stats,
    duration_ms: durationMs,
  };
}

// ------------------------------------------------------------
// 主流程
// ------------------------------------------------------------
async function ensureUser(email: string, password: string, roleCode: string, displayName: string) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  if (existing) return existing.id;
  const user = await prisma.user.create({
    data: { orgId: 1n, email, displayName, passwordHash: await hashPassword(password), status: 'active', totpEnabled: false },
  });
  await prisma.membership.create({ data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' } });
  return user.id;
}

async function main(): Promise<number> {
  await mkdir(OUT_DIR, { recursive: true });

  const operatorId = await ensureUser(`perf.operator.${SUFFIX}@test.local`, 'PerfPassword!2026', 'operator', '性能补测运营');
  await ensureUser(`pool2.perf@test.local`, 'PerfPassword!2026', 'viewer', '池压测 2');
  await ensureUser(`pool5.perf@test.local`, 'PerfPassword!2026', 'viewer', '池压测 5');
  await ensureUser(`pooldefault.perf@test.local`, 'PerfPassword!2026', 'viewer', '池压测默认');

  // 主 app（默认连接池）
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
  });
  const app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('端口获取失败');
  const apiBase = `http://127.0.0.1:${address.port}`;

  const loginResponse = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `perf.operator.${SUFFIX}@test.local`, password: 'PerfPassword!2026' }),
  });
  const loginJson = (await loginResponse.json()) as { data?: { csrf_token?: string } };
  const setCookies =
    loginResponse.headers.getSetCookie?.() ?? [loginResponse.headers.get('set-cookie')].filter(Boolean);
  const session = {
    cookie: (setCookies as Array<string | null | undefined>)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.split(';')[0] ?? '')
      .filter((value) => value.startsWith('dssaas_sid=') || value.startsWith('dssaas_csrf='))
      .join('; '),
    csrf: loginJson.data?.csrf_token ?? '',
  };

  console.log('--- 环境 ---');
  const maxConnections = await pgSetting('max_connections');
  const poolDefaults = {
    connection_limit_default: 'num_physical_cpus * 2 + 1（Prisma 默认）',
    pool_timeout_default_s: '10（Prisma 默认）',
    cpu_count: (await import('node:os')).cpus().length,
    pg_max_connections: maxConnections,
  };
  console.log(JSON.stringify(poolDefaults, null, 2));
  report.environment = { ...poolDefaults, database: maskUrl(DB_URL) };

  // ---------- A. 商品列表 ----------
  console.log('\n--- A. 商品列表：1,000 条 vs 10,000 条 ---');
  // 每档测量前都回到干净状态：本脚本会被反复跑，否则「1,000 条」那轮测到的其实是上一轮的 1 万条
  await resetPerfData();
  const baseCount = await prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
  const count1k = await seedProductsTo(baseCount + 1000, operatorId, `PERF-${SPU_SUFFIX}-A`);
  const children1k = await attachChildRows(operatorId);
  const service1k = await measureService(app, '1000 条', true);
  // HTTP 用低并发（5）测「用户感知」，两档同参数才可比；高并发另测一次看争用
  const http1k = await measureHttp(apiBase, session, '1000 条（并发 5）', 'limit=20&missing_fields=1', 5, 40);
  const http1kHigh = await measureHttp(apiBase, session, '1000 条（并发 20）', 'limit=20&missing_fields=1', 20, 60);
  console.log(`1,000 条：service p95=${service1k.latency_ms.p95}ms，HTTP(并发5) p95=${http1k.latency_ms.p95}ms，HTTP(并发20) p95=${http1kHigh.latency_ms.p95}ms`);

  const count10k = await seedProductsTo(baseCount + 10000, operatorId, `PERF-${SPU_SUFFIX}-B`);
  const children10k = await attachChildRows(operatorId);
  const service10k = await measureService(app, '10000 条', true);
  const http10k = await measureHttp(apiBase, session, '10000 条（并发 5）', 'limit=20&missing_fields=1', 5, 40);
  const http10kHigh = await measureHttp(apiBase, session, '10000 条（并发 20）', 'limit=20&missing_fields=1', 20, 40);
  console.log(`10,000 条：service p95=${service10k.latency_ms.p95}ms，HTTP(并发5) p95=${http10k.latency_ms.p95}ms，HTTP(并发20) p95=${http10kHigh.latency_ms.p95}ms`);

  // 对照：不筛 missing_fields（前端默认列表）
  const service10kPlain = await measureService(app, '10000 条（无 missing_fields）', false);

  report.productList = {
    rows: { base_before_seed: baseCount, after_1k_seed: count1k, after_10k_seed: count10k },
    children: children1k,
    children_10k: children10k,
    service_level: [service1k, service10k, service10kPlain],
    http_level: [http1k, http1kHigh, http10k, http10kHigh],
    comparison: {
      baseline_44_5ms_source: 'docs/验收记录-M3-商品内容.md §t28（1,000 条，limit=20，missing_fields=true，单次测量）',
      service_1k_p95_ms: service1k.latency_ms.p95,
      service_10k_p95_ms: service10k.latency_ms.p95,
      ratio: service1k.latency_ms.p95 === 0 ? null : Number((service10k.latency_ms.p95 / service1k.latency_ms.p95).toFixed(2)),
      row_ratio: Number((count10k / count1k).toFixed(2)),
    },
  };

  // ---------- B. 连接池 ----------
  console.log('\n--- B. DB 连接池压测 ---');
  // B1：极小池（limit=2）+ 重查询 → 必然撞 pool_timeout，用来找「第一个失败点」与对外错误形态
  const poolTiny = await poolProbe({
    label: 'pool2',
    connectionLimit: 2,
    poolTimeoutS: 5,
    concurrency: 40,
    total: 120,
    query: '/api/products?limit=20&missing_fields=1',
  });
  console.log(
    `pool(limit=${poolTiny.connection_limit}, timeout=${poolTiny.pool_timeout_s}s)：ok=${poolTiny.ok} failed=${poolTiny.failed} ` +
      `peak_conn=${poolTiny.db_connections_peak} 首个失败=${JSON.stringify(poolTiny.first_failure)}`,
  );

  const poolSmall = await poolProbe({
    label: 'pool5',
    connectionLimit: POOL_LIMIT,
    poolTimeoutS: 10,
    concurrency: POOL_CONCURRENCY,
    total: 120,
    query: '/api/products?limit=20&missing_fields=1',
  });
  console.log(
    `pool(limit=${poolSmall.connection_limit}, timeout=${poolSmall.pool_timeout_s}s)：ok=${poolSmall.ok} failed=${poolSmall.failed} ` +
      `peak_conn=${poolSmall.db_connections_peak} 首个失败=${JSON.stringify(poolSmall.first_failure)}`,
  );

  const poolDefault = await poolProbe({
    label: 'pooldefault',
    connectionLimit: 17,
    poolTimeoutS: 10,
    concurrency: POOL_CONCURRENCY,
    total: 120,
    query: '/api/products?limit=20&missing_fields=1',
  });
  console.log(
    `pool(limit=${poolDefault.connection_limit}, timeout=${poolDefault.pool_timeout_s}s)：ok=${poolDefault.ok} failed=${poolDefault.failed} ` +
      `peak_conn=${poolDefault.db_connections_peak} 首个失败=${JSON.stringify(poolDefault.first_failure)}`,
  );

  report.connectionPool = {
    pg: { max_connections: maxConnections, current_database_stats: await dbStats().catch(() => []) },
    scenarios: [poolTiny, poolSmall, poolDefault],
  };

  report.finished_at = new Date().toISOString();
  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\n报告已写入 ${path.relative(REPO_ROOT, OUT_FILE)}`);

  await app.close();
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('[perf] 执行失败：', error);
  report.error = { message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  exitCode = 1;
} finally {
  await prisma.$disconnect();
}
process.exit(exitCode);
