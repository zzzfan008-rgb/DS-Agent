/** t8 验收：商品强校验 / CSV 导入 / 文案草稿 / L1+L2 判断层 / 申诉。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createFactEnvelope } from '@dssaas/core';
import { mergeJudgments, runL1, validateL2Output } from '@dssaas/judge-rules';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  csrfFrom,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';

let app: FastifyInstance;
let admin: { id: string; email: string };
let operator: { id: string; email: string };
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;
let operatorRoleId: string;
let productId: string;

async function post(path: string, payload: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `test-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function put(path: string, payload: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'PUT',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `test-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

function factEnvelope(priceCents = 12900) {
  return createFactEnvelope([
    {
      key: 'price',
      value: priceCents,
      unit: 'cent',
      source: 'import',
      source_table: 'product_sku',
      source_id: randomUUID(),
      source_version: 1,
    },
    {
      key: 'stock',
      value: 10,
      unit: 'piece',
      source: 'import',
      source_table: 'product_sku',
      source_id: randomUUID(),
      source_version: 1,
    },
  ]);
}

async function createMockModel(kind: 'text' = 'text') {
  const provider = await post('/api/providers', {
    kind,
    name: `mock_t8_${kind}`,
    base_url: `https://mock-t8-${kind}.local`,
    credential_ref: 'mock_cred',
    vendor: 'other',
    extra: { mock: true },
  }, adminHeaders);
  assert.equal(provider.statusCode, 201, provider.body);
  const providerId = (provider.json() as { data: { id: string } }).data.id;
  const testedProvider = await post(`/api/providers/${providerId}/test`, {}, adminHeaders);
  assert.equal(testedProvider.statusCode, 200, testedProvider.body);

  const model = await post('/api/models', {
    name: 'txt.mock.t8.v1',
    provider_id: providerId,
    external_model_id: 'ext-txt-t8',
    display_name: 'T8 测试文本模型',
    capability: 'text',
    purpose_support: ['copy', 'judge'],
    params_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, temperature: { type: 'number' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    default_params: { prompt: 'hello' },
    price: { text: { input_per_1k_cents: 1, output_per_1k_cents: 2 } },
    context_tokens: 4096,
  }, adminHeaders);
  assert.equal(model.statusCode, 201, model.body);
  const modelId = (model.json() as { data: { id: string } }).data.id;
  const tested = await post(`/api/models/${modelId}/test`, {}, adminHeaders);
  assert.equal(tested.statusCode, 200, tested.body);
  const published = await post(`/api/models/${modelId}/publish`, {}, adminHeaders);
  assert.equal(published.statusCode, 200, published.body);

  const route = await post('/api/routes', {
    scope_type: 'role',
    scope_role_id: operatorRoleId,
    purpose: 'copy',
    model_id: modelId,
    fallback_ids: [],
    priority: 1,
    status: 'active',
  }, adminHeaders);
  assert.equal(route.statusCode, 201, route.body);
  return { providerId, modelId };
}

before(async () => {
  app = await buildTestApp({
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
    LOG_LEVEL: 'error',
  });
  admin = await createUser({
    email: 'admin.t8@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  operator = await createUser({
    email: 'operator.t8@test.local',
    password: OPERATOR_PASSWORD,
    role: 'operator',
  });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
  const role = await prisma.role.findFirstOrThrow({ where: { code: 'operator', archivedAt: null } });
  operatorRoleId = role.id;

  await createMockModel();

  const created = await post('/api/products', {
    spu_code: 'TST-0001',
    name: '测试纯棉上衣',
    category_code: 'A0101',
    fit: 'regular',
    skus: [
      {
        color_id: 'bk0101',
        color_name: '黑色',
        size_code: 'M',
        price_cents: 12900,
        stock_qty: 10,
      },
    ],
    fabric: { materials: [{ material: '棉', percent: 100 }] },
    size_chart: {
      effective_from: '2026-10-01',
      items: [
        {
          sku_size_code: 'M',
          measurements: { 胸围: 104, 衣长: 69 },
          recommend_height_min: 165,
          recommend_height_max: 172,
          recommend_weight_min: 60,
          recommend_weight_max: 67,
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  productId = (created.json() as { data: { id: string } }).data.id;

  const chart = await put(`/api/products/${productId}/size-chart`, {
    effective_from: '2026-10-01',
    items: [
      {
        sku_size_code: 'M',
        measurements: { 胸围: 104, 衣长: 69 },
        recommend_height_min: 165,
        recommend_height_max: 172,
        recommend_weight_min: 60,
        recommend_weight_max: 67,
      },
    ],
  });
  assert.equal(chart.statusCode, 200, chart.body);
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('商品创建：color_id 归一 BK-0101、size 归一为 XXL；CSV 导入成功', async () => {
  const product = await prisma.product.findFirst({
    where: { id: productId },
    select: { id: true, factVersion: true },
  });
  assert.ok(product);
  const sku = await prisma.productSku.findFirst({ where: { productId } });
  assert.equal(sku?.colorId, 'BK-0101');
  assert.equal(sku?.sizeCode, 'M');

  const csv = [
    'spu_code,name,category_code,fit,color_id,color_name,size_code,price_cents,stock_qty,fabric_materials,measurements',
    'TST-IMP-001,导入测试款,A0101,regular,bk0101,黑色,2XL,9900,10,"[{""material"":""涤纶"",""percent"":100}]","{""胸围"":104,""衣长"":69}"',
  ].join('\n');
  const imported = await post('/api/products/import', { csv, dry_run: false });
  assert.equal(imported.statusCode, 201, imported.body);
  const body = imported.json() as { data: { rows_ok: number; dry_run: boolean } };
  assert.equal(body.data.rows_ok, 1);
  const importedProduct = await prisma.product.findFirst({
    where: { spuCode: 'TST-IMP-001' },
  });
  assert.ok(importedProduct);
  const importedSku = await prisma.productSku.findFirst({
    where: { productId: importedProduct!.id },
  });
  assert.equal(importedSku?.colorId, 'BK-0101');
  assert.equal(importedSku?.sizeCode, 'XXL');
  const fabric = await prisma.fabricComposition.findFirst({
    where: { productId: importedProduct!.id, status: 'effective' },
  });
  const materials = fabric?.materials as Array<{ material: string; percent: number }>;
  assert.equal(materials[0]?.material, '聚酯纤维');
});

test('非法尺码表/成分合计≠100 被拒，且不落库', async () => {
  const beforeChart = await prisma.sizeChart.count({ where: { productId } });
  const badChart = await put(`/api/products/${productId}/size-chart`, {
    effective_from: '2026-10-02',
    items: [{ sku_size_code: '6XL', measurements: { 胸围: 104.3, 衣长: 69 } }],
  });
  assert.equal(badChart.statusCode, 422);
  assert.equal((badChart.json() as { error: { code: string } }).error.code, 'validation_failed');
  const afterChart = await prisma.sizeChart.count({ where: { productId } });
  assert.equal(afterChart, beforeChart);

  const missingPart = await put(`/api/products/${productId}/size-chart`, {
    effective_from: '2026-10-02',
    items: [{ sku_size_code: 'L', measurements: { 胸围: 104 } }],
  });
  // 胸围+衣长是上装必测；且单行尺码表未覆盖 SKU M（业务规则在尺码表 PUT 校验）
  assert.equal(missingPart.statusCode, 422);

  const badFabric = await put(`/api/products/${productId}/fabric`, {
    items: [{ material: '棉', percent: 99 }],
  });
  assert.equal(badFabric.statusCode, 422);
  assert.equal((badFabric.json() as { error: { code: string } }).error.code, 'validation_failed');
  const effectiveFabric = await prisma.fabricComposition.findFirst({
    where: { productId, status: 'effective' },
  });
  const materials = effectiveFabric?.materials as Array<{ percent: number }>;
  assert.equal(materials[0]?.percent, 100);
});

test('CSV 非法成分不写入任何商品', async () => {
  const before = await prisma.product.count();
  const badCsv = [
    'spu_code,name,category_code,color_id,size_code,price_cents,fabric_materials,measurements',
    'TST-BAD-001,坏数据款,A0101,BK-0102,M,9900,"[{""material"":""棉"",""percent"":99}]","{""胸围"":104,""衣长"":69}"',
  ].join('\n');
  const response = await post('/api/products/import', { csv: badCsv });
  assert.equal(response.statusCode, 422);
  assert.equal((response.json() as { error: { code: string } }).error.code, 'validation_failed');
  assert.equal(await prisma.product.count(), before);
});

test('文案草稿生成：写入 facts 信封 + model_call_id，可再判 L1 pass', async () => {
  const response = await post('/api/content/drafts', {
    content_type: 'title',
    product_id: productId,
    platform: 'pdd',
    tone: '专业',
  });
  assert.equal(response.statusCode, 201, response.body);
  const draft = (response.json() as {
    data: { draft_id: string; content: string; facts_hash: string; model_call_id: string };
  }).data;
  assert.ok(draft.draft_id);
  assert.ok(draft.content.length > 0);
  assert.equal(draft.facts_hash.length, 64);
  assert.ok(draft.model_call_id);

  const judgment = await post('/api/judgments', {
    subject_type: 'content_draft',
    subject_id: draft.draft_id,
    platform: 'pdd',
    content_type: 'title',
    run: 'L1',
  });
  assert.equal(judgment.statusCode, 201, judgment.body);
  const body = judgment.json() as {
    data: { verdict: string; l1: { evaluated: number; skipped: string[] }; rule_hits: unknown[] };
  };
  assert.equal(body.data.verdict, 'pass');
  assert.ok(body.data.l1.evaluated > 0);
});

test('L1 blocker：全网最低价+价格不符 → reject 短路，rule_hits 可追溯', async () => {
  const facts = factEnvelope(12900);
  const response = await post('/api/judgments', {
    subject_type: 'listing',
    subject_id: randomUUID(),
    platform: 'pdd',
    content_type: 'title',
    text: '全网最低 99 元纯棉上衣',
    facts,
    run: 'L1+L2',
  }, adminHeaders);
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as {
    data: {
      judgment_id: string;
      verdict: string;
      status: string;
      l1: { blocked: boolean; hits: Array<{ rule_id: string; span: [number, number]; matched: string }> };
      rule_hits: Array<{ rule_id: string; span: [number, number] }>;
      short_circuit: string;
      l2: unknown;
    };
  };
  assert.equal(body.data.verdict, 'reject');
  assert.equal(body.data.l1.blocked, true);
  assert.equal(body.data.short_circuit, 'L1_BLOCKER');
  assert.equal(body.data.l2, null);
  const ids = body.data.rule_hits.map((hit) => hit.rule_id);
  assert.ok(ids.includes('L1-LEX-001'));
  assert.ok(ids.includes('L1-PRC-001'));
  const priceHit = body.data.rule_hits.find((hit) => hit.rule_id === 'L1-PRC-001');
  assert.ok(priceHit && priceHit.span[1] > priceHit.span[0]);

  const detail = await app.inject({
    method: 'GET',
    url: `/api/judgments/${body.data.judgment_id}`,
    headers: operatorHeaders,
  });
  assert.equal(detail.statusCode, 200);
  const detailBody = detail.json() as {
    data: { l1_hit_rule_ids: string[]; status: string; verdict: string };
  };
  assert.equal(detailBody.data.status, 'rejected');
  assert.ok(detailBody.data.l1_hit_rule_ids.includes('L1-LEX-001'));
});

test('L2 无证据：直接 escalate，不调用模型；post-validate 无引用也升级', async () => {
  const facts = factEnvelope(12900);
  const response = await post('/api/judgments', {
    subject_type: 'listing',
    subject_id: randomUUID(),
    platform: 'pdd',
    content_type: 'title',
    text: '舒适纯棉上衣',
    facts,
    run: 'L1+L2',
  }, adminHeaders);
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as {
    data: { verdict: string; status: string; escalated: boolean; short_circuit: string; l2: unknown };
  };
  assert.equal(body.data.verdict, 'escalate');
  assert.equal(body.data.status, 'escalated');
  assert.equal(body.data.escalated, true);
  assert.equal(body.data.short_circuit, 'NO_EVIDENCE');
  assert.equal(body.data.l2, null);

  const l2NoRefs = validateL2Output(
    JSON.stringify({
      verdict: 'needs_revision',
      severity: 'high',
      reason: '夸大宣传',
      repair_hint: '删除夸大表述',
      evidence_refs: [],
    }),
    [],
  );
  assert.equal(l2NoRefs.ok, false);
  if (!l2NoRefs.ok) assert.equal(l2NoRefs.reason, 'missing_evidence');

  const l1 = runL1({
    platform: 'pdd',
    content_type: 'title',
    text: '舒适纯棉上衣',
    facts: { price_cents: 12900, stock: 10, composition: [{ material: '棉', percent: 100 }] },
  });
  const merged = mergeJudgments(l1, null, { noEvidence: true });
  assert.equal(merged.verdict, 'escalate');
  assert.equal(merged.short_circuit, 'NO_EVIDENCE');
});

test('申诉：operator 提交→同条不可二次→admin 改判', async () => {
  const facts = factEnvelope(12900);
  const created = await post('/api/judgments', {
    subject_type: 'listing',
    subject_id: randomUUID(),
    platform: 'pdd',
    content_type: 'title',
    text: '舒适纯棉上衣',
    facts,
    run: 'L1',
  }, adminHeaders);
  assert.equal(created.statusCode, 201, created.body);
  const judgmentId = (created.json() as { data: { judgment_id: string; status: string } }).data.judgment_id;

  const appeal = await post(`/api/judgments/${judgmentId}/appeal`, {
    reason: '该判定与实际商品描述一致，请人工复核',
  });
  assert.equal(appeal.statusCode, 200, appeal.body);
  assert.equal((appeal.json() as { data: { appeal_status: string } }).data.appeal_status, 'requested');

  const second = await post(`/api/judgments/${judgmentId}/appeal`, {
    reason: '再次申请复核同一判定记录',
  });
  assert.equal(second.statusCode, 409);

  const review = await post(`/api/judgments/${judgmentId}/appeal-review`, {
    decision: 'overridden',
    final_verdict: 'needs_revision',
    note: '人工复核认为需补充说明',
  }, adminHeaders);
  assert.equal(review.statusCode, 200, review.body);
  const reviewBody = review.json() as {
    data: { appeal_status: string; status: string; final_verdict: string };
  };
  assert.equal(reviewBody.data.appeal_status, 'overridden');
  assert.equal(reviewBody.data.status, 'needs_revision');
  assert.equal(reviewBody.data.final_verdict, 'needs_revision');
});
