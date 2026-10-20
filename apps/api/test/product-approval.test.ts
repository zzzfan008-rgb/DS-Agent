/** t28 验收：商品列表平台态/missing_fields 聚合 + 审批内容失效 + publish_content 定级。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canonicalHash, createFactEnvelope } from '@dssaas/core';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  csrfFrom,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';
import { listProducts, PRODUCT_MISSING_CODES } from '../src/services/products.js';
import { contentDraftTargetPayload } from '../src/services/content-target.js';
import { computeLevel } from '../src/write-gate/actions.js';
import { checkPoolCapacity } from '../src/config.js';
import { errorEnvelope, toApiError } from '../src/lib/errors.js';

/** where 子句里含 BigInt（orgId），JSON.stringify 会抛 —— 用带 BigInt 支持的序列化做拦截判断。 */
function whereText(where: unknown): string {
  try {
    return JSON.stringify(where, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? '';
  } catch {
    return '';
  }
}

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';
const PREFIX = `T28-${randomUUID().slice(0, 6).toUpperCase()}`;

let app: FastifyInstance;
let admin: { id: string; email: string };
let operator: { id: string; email: string };
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;
let categoryId: string;
const cleanupProductIds: string[] = [];

async function post(path: string, payload: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t28-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function createProduct(input: {
  suffix: string;
  chart?: boolean;
  fabric?: boolean;
  qualification?: boolean;
  listing?: 'pdd' | '1688' | null;
  listingStatus?: 'draft' | 'publishing' | 'published' | 'rejected' | 'archived';
  category?: boolean;
}) {
  const product = await prisma.product.create({
    data: {
      orgId: 1n,
      spuCode: `${PREFIX}-${input.suffix}`,
      name: `t28 ${input.suffix}`,
      categoryCode: 'A0101',
      qualification: (input.qualification ?? true) ? { license: 'test' } : {},
      createdBy: operator.id,
    },
  });
  cleanupProductIds.push(product.id);
  if (input.chart ?? true) {
    await prisma.sizeChart.create({
      data: {
        orgId: 1n,
        productId: product.id,
        versionNo: 1,
        status: 'effective',
        sizeSystem: 'alpha',
        skuSizeCode: 'M',
        sizeOrder: 1,
        measurements: { 胸围: 104, 衣长: 69 },
        source: 'manual',
        effectiveFrom: new Date('2026-01-01'),
        checksum: 'a'.repeat(64),
        createdBy: operator.id,
      },
    });
  }
  if (input.fabric ?? true) {
    await prisma.fabricComposition.create({
      data: {
        orgId: 1n,
        productId: product.id,
        versionNo: 1,
        fabricCode: 'MAIN',
        fabricName: '主料',
        role: 'main',
        materials: [{ material: '棉', percent: 100 }],
        status: 'effective',
        source: 'manual',
        effectiveFrom: new Date('2026-01-01'),
        checksum: 'b'.repeat(64),
        createdBy: operator.id,
      },
    });
  }
  if (input.listing) {
    await prisma.listing.create({
      data: {
        orgId: 1n,
        platform: input.listing,
        productId: product.id,
        status: input.listingStatus ?? 'draft',
        ...(input.category ?? true ? { platformCategoryId: categoryId } : {}),
        createdBy: operator.id,
      },
    });
  }
  return product;
}

before(async () => {
  app = await buildTestApp({
    LOG_LEVEL: 'error',
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
  });
  admin = await createUser({ email: 'admin.t28@test.local', password: ADMIN_PASSWORD, role: 'admin' });
  operator = await createUser({ email: 'operator.t28@test.local', password: OPERATOR_PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
  const category = await prisma.platformCategory.create({
    data: {
      orgId: 1n,
      platform: 'pdd',
      externalCategoryId: `T28CAT-${randomUUID().slice(0, 8)}`,
      name: 't28 测试类目',
    },
  });
  categoryId = category.id;
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('GET /products 聚合 platform_states / missing_fields，platform 与 missing_fields 生效', async () => {
  const complete = await createProduct({
    suffix: 'COMPLETE',
    listing: 'pdd',
    listingStatus: 'published',
  });
  await createProduct({ suffix: 'NOTLISTED' });
  await createProduct({ suffix: 'REJECTED', listing: 'pdd', listingStatus: 'rejected' });
  const noChart = await createProduct({ suffix: 'NOCHART', chart: false, listing: 'pdd' });
  const noFabric = await createProduct({ suffix: 'NOFABRIC', fabric: false, listing: 'pdd' });
  const noQual = await createProduct({ suffix: 'NOQUAL', qualification: false, listing: 'pdd' });
  const noCategory = await createProduct({ suffix: 'NOCAT', listing: 'pdd', category: false });

  const response = await app.inject({
    method: 'GET',
    url: `/api/products?q=${PREFIX}&limit=100`,
    headers: operatorHeaders,
  });
  assert.equal(response.statusCode, 200, response.body);
  const items = (response.json() as {
    data: { items: Array<{
      id: string;
      spu_code: string;
      platform_states: Record<string, { status: string; platform_state: string | null }>;
      missing_fields: string[];
    }> };
  }).data.items;
  const bySuffix = new Map(items.map((item) => [item.spu_code, item]));
  const completeItem = bySuffix.get(`${PREFIX}-COMPLETE`)!;
  assert.equal(completeItem.platform_states.pdd!.status, 'published');
  assert.equal(completeItem.platform_states['1688']!.status, 'not_listed');
  assert.deepEqual(completeItem.missing_fields, []);
  assert.equal(bySuffix.get(`${PREFIX}-NOTLISTED`)!.platform_states.pdd!.status, 'not_listed');
  assert.equal(bySuffix.get(`${PREFIX}-REJECTED`)!.platform_states.pdd!.status, 'rejected');

  assert.deepEqual(bySuffix.get(`${PREFIX}-NOCHART`)!.missing_fields, [PRODUCT_MISSING_CODES.sizeChart]);
  assert.deepEqual(bySuffix.get(`${PREFIX}-NOFABRIC`)!.missing_fields, [PRODUCT_MISSING_CODES.fabric]);
  assert.deepEqual(bySuffix.get(`${PREFIX}-NOQUAL`)!.missing_fields, [PRODUCT_MISSING_CODES.qualification]);
  assert.deepEqual(bySuffix.get(`${PREFIX}-NOCAT`)!.missing_fields, [PRODUCT_MISSING_CODES.platformCategory]);

  const platformFiltered = await app.inject({
    method: 'GET',
    url: `/api/products?q=${PREFIX}&platform=pdd&limit=100`,
    headers: operatorHeaders,
  });
  const platformItems = (platformFiltered.json() as { data: { items: Array<{ spu_code: string }> } }).data.items;
  assert.ok(platformItems.some((item) => item.spu_code === `${PREFIX}-COMPLETE`));
  assert.ok(!platformItems.some((item) => item.spu_code === `${PREFIX}-NOTLISTED`));

  const missingFiltered = await app.inject({
    method: 'GET',
    url: `/api/products?q=${PREFIX}&missing_fields=1&limit=100`,
    headers: operatorHeaders,
  });
  const missingItems = (missingFiltered.json() as { data: { items: Array<{ spu_code: string }> } }).data.items;
  assert.ok(missingItems.every((item) => item.spu_code !== `${PREFIX}-COMPLETE`));
  assert.ok(missingItems.some((item) => item.spu_code === `${PREFIX}-NOCHART`));

  // 直接断言补全商品与缺失商品均可查
  assert.ok(complete);
  assert.ok(noChart && noFabric && noQual && noCategory);
});

test('1000 条商品聚合耗时（批量查询，无 N+1）', async () => {
  const benchPrefix = `${PREFIX}-BENCH`;
  await prisma.product.createMany({
    data: Array.from({ length: 1000 }, (_, index) => ({
      orgId: 1n,
      spuCode: `${benchPrefix}-${String(index).padStart(4, '0')}`,
      name: `bench ${index}`,
      categoryCode: 'A0101',
      createdBy: operator.id,
    })),
  });
  const benchIds = await prisma.product.findMany({
    where: { spuCode: { startsWith: benchPrefix } },
    select: { id: true },
  });
  cleanupProductIds.push(...benchIds.map((row) => row.id));
  const started = performance.now();
  const result = await listProducts(
    { prisma: app.prisma, audit: app.audit },
    { limit: 20, missing_fields: true },
  );
  const elapsedMs = performance.now() - started;
  assert.ok(result.items.length > 0);
  assert.ok(elapsedMs < 2000, `1000 条商品聚合耗时 ${elapsedMs.toFixed(1)}ms 超过 2s`);
  console.log(`[t28] 1000 products aggregate: ${elapsedMs.toFixed(1)}ms, page=${result.items.length}`);
});

test('t51/F1：分页下推 —— 只取 limit+1 行，不再全量拉取（SQL 行数断言）', async () => {
  const prefix = `${PREFIX}-PUSHDOWN`;
  await prisma.product.createMany({
    data: Array.from({ length: 300 }, (_, index) => ({
      orgId: 1n,
      spuCode: `${prefix}-${String(index).padStart(4, '0')}`,
      name: `pushdown ${index}`,
      categoryCode: 'A0101',
      createdBy: operator.id,
    })),
  });
  const created = await prisma.product.findMany({ where: { spuCode: { startsWith: prefix } }, select: { id: true } });
  cleanupProductIds.push(...created.map((row) => row.id));

  // 拦截 findMany，记录 product 查询实际带了多少行回内存。
  const original = app.prisma.product.findMany.bind(app.prisma.product);
  let maxRowsFetched = 0;
  let productQueryCalls = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (app.prisma.product as any).findMany = async (args: any) => {
    const rows = await original(args);
    if (whereText(args?.where).includes(prefix)) {
      productQueryCalls += 1;
      maxRowsFetched = Math.max(maxRowsFetched, Array.isArray(rows) ? rows.length : 0);
    }
    return rows;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  try {
    const result = await listProducts({ prisma: app.prisma, audit: app.audit }, { limit: 20, q: prefix });
    assert.equal(result.items.length, 20);
    assert.equal(productQueryCalls, 1, '无 missing_fields 过滤时只查一次');
    assert.ok(maxRowsFetched <= 21, `实际拉取 ${maxRowsFetched} 行，应 ≤ limit+1=21（分页必须下推）`);
    // 游标语义：nextCursor 是最后一条的 spu_code，下一页严格大于它。
    assert.equal(result.nextCursor, result.items[result.items.length - 1]!.spu_code);
    const next = await listProducts(
      { prisma: app.prisma, audit: app.audit },
      { limit: 20, q: prefix, cursor: result.nextCursor! },
    );
    assert.equal(next.items[0]!.spu_code, `${prefix}-0020`, '游标分页必须连续、不重不漏');
  } finally {
    (app.prisma.product as any).findMany = original;
  }
});

test('t51/F1：missing_fields 过滤仍是分批扫描 + 早停，语义不变', async () => {
  const prefix = `${PREFIX}-MISSING`;
  await prisma.product.createMany({
    data: Array.from({ length: 120 }, (_, index) => ({
      orgId: 1n,
      spuCode: `${prefix}-${String(index).padStart(4, '0')}`,
      name: `missing ${index}`,
      categoryCode: 'A0101',
      createdBy: operator.id,
    })),
  });
  const created = await prisma.product.findMany({ where: { spuCode: { startsWith: prefix } }, select: { id: true } });
  cleanupProductIds.push(...created.map((row) => row.id));

  const original = app.prisma.product.findMany.bind(app.prisma.product);
  let batches = 0;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (app.prisma.product as any).findMany = async (args: any) => {
    const rows = await original(args);
    if (whereText(args?.where).includes(prefix)) batches += 1;
    return rows;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  try {
    // 这 120 条都没尺码表/成分/资质/类目 → 全部 missing，第一批就凑够 limit+1 → 早停。
    const result = await listProducts(
      { prisma: app.prisma, audit: app.audit },
      { limit: 20, q: prefix, missing_fields: true },
    );
    assert.equal(result.items.length, 20);
    assert.ok(result.items.every((item) => item.missing_fields.length > 0));
    assert.equal(batches, 1, '凑够 limit+1 就必须早停，不得扫完全部批次');
  } finally {
    (app.prisma.product as any).findMany = original;
  }
});

test('t51/F2：Prisma P2024（连接池耗尽）映射为 503 + retryable + Retry-After', () => {
  const p2024 = Object.assign(new Error('Timed out fetching a new connection from the connection pool'), {
    code: 'P2024',
    clientVersion: '6.19.3',
  });
  const apiError = toApiError(p2024);
  assert.equal(apiError.code, 'db_pool_exhausted');
  assert.equal(apiError.httpStatus, 503, '连接池耗尽不是代码 bug，不能报 500');
  assert.equal(apiError.retryable, true, '必须可重试，否则客户端直接放弃');
  assert.equal(apiError.nextAction, 'retry_later');
  assert.equal(apiError.headers?.['retry-after'], '2');
  const detail = apiError.detail as { prisma_code?: string };
  assert.equal(detail.prisma_code, 'P2024');
  // 错误信封可读
  const envelope = errorEnvelope('req-1', apiError);
  assert.equal(envelope.error.code, 'db_pool_exhausted');
  assert.equal(envelope.error.retryable, true);

  // 连接类错误同样按可重试处理
  for (const code of ['P1001', 'P1002', 'P1017']) {
    const mapped = toApiError(Object.assign(new Error('conn'), { code }));
    assert.equal(mapped.code, 'db_pool_exhausted', `${code} 应映射为 db_pool_exhausted`);
    assert.equal(mapped.httpStatus, 503);
    assert.equal(mapped.retryable, true);
  }
  // 其他未知异常仍是 500（不要把所有错误都洗成 503）
  const unknown = toApiError(new Error('boom'));
  assert.equal(unknown.code, 'internal_error');
  assert.equal(unknown.httpStatus, 500);
});

test('t51/F3：连接池容量校验只 WARNING 不阻断，且能识别显式配置', () => {
  // 未显式配置 connection_limit + 3 实例 → 两条告警（未显式 + 超预算）
  const missing = checkPoolCapacity({
    databaseUrl: 'postgresql://u:p@db:5432/dssaas',
    apiInstanceCount: 3,
    pgMaxConnections: 100,
  });
  assert.equal(missing.connectionLimit, null);
  assert.equal(missing.effectiveLimit, 99, '未配置时按 Prisma 默认 33 估算：33×3=99');
  assert.equal(missing.warnings.length, 2);
  assert.match(missing.warnings[0]!, /connection_limit/);
  assert.match(missing.warnings[1]!, /99|超过/);

  // 显式配 20 + 3 实例 → 60 < 80 预算 → 无告警
  const configured = checkPoolCapacity({
    databaseUrl: 'postgresql://u:p@db:5432/dssaas?connection_limit=20&pool_timeout=10',
    apiInstanceCount: 3,
    pgMaxConnections: 100,
  });
  assert.equal(configured.connectionLimit, 20);
  assert.equal(configured.effectiveLimit, 60);
  assert.deepEqual(configured.warnings, []);

  // 显式配但总量仍超 → 只有超预算那一条
  const oversubscribed = checkPoolCapacity({
    databaseUrl: 'postgresql://u:p@db:5432/dssaas?connection_limit=40',
    apiInstanceCount: 3,
    pgMaxConnections: 100,
  });
  assert.equal(oversubscribed.effectiveLimit, 120);
  assert.equal(oversubscribed.warnings.length, 1);
  assert.match(oversubscribed.warnings[0]!, /120/);
});

test('审批内容失效：编辑草稿后旧审批 decide → 428 approval_stale + resubmit；新审批可批', async () => {
  const product = await createProduct({ suffix: 'APPROVAL', listing: 'pdd' });
  const draft = await prisma.contentDraft.create({
    data: {
      orgId: 1n,
      productId: product.id,
      platform: 'pdd',
      contentType: 'title',
      body: '旧标题：纯棉舒适上衣',
      structured: {},
      facts: createFactEnvelope([
        {
          key: 'name',
          value: product.name,
          unit: 'text',
          source: 'manual',
          source_table: 'product',
          source_id: product.id,
          source_version: 1,
        },
      ]) as never,
      factCheck: {},
      status: 'generated',
      createdBy: operator.id,
    },
  });
  const target = contentDraftTargetPayload(draft);
  const created = await post('/api/approvals', {
    subject_type: 'content_draft',
    subject_id: draft.id,
    action: 'publish',
    platform: 'pdd',
    target_payload: target,
    context: { listingStatus: 'draft' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const approvalId = (created.json() as { data: { id: string; level: string } }).data.id;

  const edited = await app.inject({
    method: 'PUT',
    url: `/api/content/drafts/${draft.id}`,
    headers: { ...operatorHeaders, 'content-type': 'application/json', 'idempotency-key': `t28-${randomUUID()}` },
    payload: { content: '新标题：纯棉舒适上衣（改）' },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const editedBody = edited.json() as { data: { facts_hash: string; target_hash: string } };
  assert.notEqual(editedBody.data.target_hash, targetHashOf(target));

  const stale = await post(`/api/approvals/${approvalId}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(stale.statusCode, 428, stale.body);
  const staleBody = stale.json() as { error: { code: string; next_action: string } };
  assert.equal(staleBody.error.code, 'approval_stale');
  assert.equal(staleBody.error.next_action, 'resubmit');

  const current = await prisma.contentDraft.findUniqueOrThrow({ where: { id: draft.id } });
  const newTarget = contentDraftTargetPayload(current);

  // 编辑草稿后旧审批仍保留为 pending（不再被编辑动作改写为 invalidated）；
  // 同一 subject+action 同时只允许一个活跃审批，所以重提要用内容专用动作
  // publish_content，而旧审批靠 target_hash 校验在 decide 时被 428 拦住。
  const oldAfterEdit = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
  assert.equal(oldAfterEdit.status, 'pending', '编辑草稿不应改写旧审批状态');

  const recreated = await post('/api/approvals', {
    subject_type: 'content_draft',
    subject_id: draft.id,
    action: 'publish_content',
    platform: 'pdd',
    target_payload: newTarget,
    context: { listingStatus: 'draft' },
  });
  assert.equal(recreated.statusCode, 201, recreated.body);
  const newId = (recreated.json() as { data: { id: string } }).data.id;
  const approved = await post(`/api/approvals/${newId}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(approved.statusCode, 200, approved.body);
});

function targetHashOf(payload: Record<string, unknown>): string {
  // 与 approval 服务同一 canonicalHash（不另写规范化）。
  return canonicalHash(payload);
}

test('publish_content 定级：B 级，区别于 listing.create', () => {
  assert.equal(computeLevel('content.publish', {}).level, 'B');
  assert.equal(computeLevel('listing.create', {}).level, 'B');
});

test('publish_content 创建审批：201、level=B、subject_type=content_draft，admin 可批', async () => {
  const product = await createProduct({ suffix: 'PUBLISH-CONTENT', listing: 'pdd' });
  const draft = await prisma.contentDraft.create({
    data: {
      orgId: 1n,
      productId: product.id,
      platform: 'pdd',
      contentType: 'selling_points',
      body: '纯棉面料，透气亲肤，适合春秋日常通勤。',
      structured: {},
      facts: createFactEnvelope([
        {
          key: 'name',
          value: product.name,
          unit: 'text',
          source: 'manual',
          source_table: 'product',
          source_id: product.id,
          source_version: 1,
        },
      ]) as never,
      factCheck: {},
      status: 'generated',
      createdBy: operator.id,
    },
  });

  const created = await post('/api/approvals', {
    subject_type: 'content_draft',
    subject_id: draft.id,
    action: 'publish_content',
    platform: 'pdd',
    target_payload: contentDraftTargetPayload(draft),
    context: { listingStatus: 'draft' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as {
    data: {
      id: string;
      status: string;
      level: string;
      target_hash: string;
      level_reasons: string[];
      sla_due_at: string | null;
    };
  };
  assert.equal(body.data.status, 'pending');
  assert.equal(body.data.level, 'B', 'publish_content 必须是 B 级');
  assert.match(body.data.target_hash, /^[0-9a-f]{64}$/);
  assert.ok(body.data.level_reasons.includes('base=B'));
  assert.ok(body.data.sla_due_at, 'B 级必须有 SLA 到期时间');

  // 落库校验：动作、级别、主体类型与请求一致（DB CHECK 已含 publish_content）。
  const row = await prisma.approval.findUniqueOrThrow({ where: { id: body.data.id } });
  assert.equal(row.action, 'publish_content');
  assert.equal(row.operationLevel, 'B');
  assert.equal(row.subjectType, 'content_draft');
  assert.equal(row.subjectId, draft.id);
  assert.equal(row.targetHash, body.data.target_hash);

  const approved = await post(`/api/approvals/${body.data.id}/decide`, { decision: 'approve' }, adminHeaders);
  assert.equal(approved.statusCode, 200, approved.body);
  const decided = await prisma.approval.findUniqueOrThrow({ where: { id: body.data.id } });
  assert.equal(decided.status, 'approved');
});
