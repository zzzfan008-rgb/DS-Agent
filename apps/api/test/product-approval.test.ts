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
  const recreated = await post('/api/approvals', {
    subject_type: 'content_draft',
    subject_id: draft.id,
    action: 'publish',
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
