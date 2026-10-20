/** t41：G23 半码小数 500 + G22 provider/model 列表 version。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { canonicalHash } from '@dssaas/core';
import { buildTestApp, cookiesFrom, createUser, csrfFrom, login, prisma, sessionHeaders } from './helpers.js';
import { buildProductFacts } from '../src/services/facts.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';
const SUFFIX = randomUUID().slice(0, 8).toUpperCase();

let app: FastifyInstance;
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;

async function api(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload: unknown,
  headers = operatorHeaders,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: path,
    headers: {
      ...headers,
      'content-type': 'application/json',
      'idempotency-key': `t41-${randomUUID()}`,
      ...extraHeaders,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function productBody(suffix: string, measurement: number, priceCents: number | string | null) {
  return {
    spu_code: `T41-${SUFFIX}-${suffix}`,
    name: `t41 半码 ${suffix}`,
    category_code: 'A0101',
    fit: 'regular',
    skus: [
      {
        color_id: 'bk0101',
        color_name: '黑色',
        size_code: 'M',
        price_cents: priceCents,
        stock_qty: 10,
      },
    ],
    fabric: { materials: [{ material: '棉', percent: 100 }] },
    size_chart: {
      effective_from: '2026-01-01',
      items: [{ sku_size_code: 'M', measurements: { 肩宽: measurement, 胸围: 104, 衣长: 69 } }],
    },
  };
}

before(async () => {
  app = await buildTestApp({
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
    LOG_LEVEL: 'error',
  });
  await createUser({ email: `admin.t41.${SUFFIX}@test.local`, password: ADMIN_PASSWORD, role: 'admin' });
  const operator = await createUser({
    email: `operator.t41.${SUFFIX}@test.local`,
    password: OPERATOR_PASSWORD,
    role: 'operator',
  });
  const adminLogin = await login(app, `admin.t41.${SUFFIX}@test.local`, ADMIN_PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('G23：measurements 45.5/45.0/45 均 201，facts_hash 稳定；price_cents 非整数 400', async () => {
  const createdAt: string[] = [];
  for (const [suffix, measurement] of [['A', 45.5], ['B', 45.0], ['C', 45]] as const) {
    const response = await api('POST', '/api/products', productBody(suffix, measurement, 12900));
    assert.equal(response.statusCode, 201, response.body);
    createdAt.push((response.json() as { data: { id: string } }).data.id);
  }
  const factsA = await buildProductFacts(prisma, createdAt[0]!);
  const factsB = await buildProductFacts(prisma, createdAt[0]!);
  assert.equal(factsA.facts_hash, factsB.facts_hash);
  assert.equal(
    canonicalHash({ measurements: { 肩宽: 45.5, 胸围: 104 } }),
    canonicalHash({ measurements: { 胸围: 104, 肩宽: 45.5 } }),
  );
  assert.notEqual(
    canonicalHash({ measurements: { 肩宽: 45.5 } }),
    canonicalHash({ measurements: { 肩宽: 45.0 } }),
  );

  const decimalPrice = await api('POST', '/api/products', productBody('D', 45.5, 12.5));
  assert.equal(decimalPrice.statusCode, 400, decimalPrice.body);
  assert.equal((decimalPrice.json() as { error: { code: string } }).error.code, 'validation_failed');

  const nullPrice = await api('POST', '/api/products', productBody('E', 45.5, null));
  assert.equal(nullPrice.statusCode, 400, nullPrice.body);
  assert.notEqual(nullPrice.statusCode, 500);

  const invalidJson = await app.inject({
    method: 'POST',
    url: '/api/products',
    headers: { ...operatorHeaders, 'content-type': 'application/json' },
    payload: `{"spu_code":"T41-${SUFFIX}-F","name":"x","category_code":"A0101","skus":[{"color_id":"bk0101","size_code":"M","price_cents":NaN,"stock_qty":1}],"fabric":{"materials":[{"material":"棉","percent":100}]}}`,
  });
  assert.equal(invalidJson.statusCode, 400, invalidJson.body);
});

test('G22：providers 列表返回 version，If-Match 匹配成功、不匹配 409', async () => {
  const created = await api('POST', '/api/providers', {
    kind: 'text',
    name: `t41_provider_${SUFFIX.toLowerCase()}`,
    base_url: `https://t41-${SUFFIX.toLowerCase()}.mock.local`,
    credential_ref: 'mock_cred',
    vendor: 'other',
    extra: { mock: true },
  }, adminHeaders);
  assert.equal(created.statusCode, 201, created.body);
  const providerId = (created.json() as { data: { id: string } }).data.id;

  const listed = await api('GET', '/api/providers', undefined, adminHeaders);
  assert.equal(listed.statusCode, 200, listed.body);
  const item = (listed.json() as { data: { items: Array<{ id: string; version: number }> } }).data.items.find(
    (row) => row.id === providerId,
  );
  assert.equal(item?.version, 1);

  const patched = await api('PATCH', `/api/providers/${providerId}`, { region: 'cn' }, adminHeaders, {
    'if-match': '1',
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((patched.json() as { data: { version: number } }).data.version, 2);

  const conflict = await api('PATCH', `/api/providers/${providerId}`, { region: 'us' }, adminHeaders, {
    'if-match': '1',
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
});

test('G22：models 列表返回 version，PATCH If-Match 生效', async () => {
  const provider = await api('POST', '/api/providers', {
    kind: 'text',
    name: `t41_model_provider_${SUFFIX.toLowerCase()}`,
    base_url: `https://t41-model-${SUFFIX.toLowerCase()}.mock.local`,
    credential_ref: 'mock_cred',
    vendor: 'other',
    extra: { mock: true },
  }, adminHeaders);
  assert.equal(provider.statusCode, 201, provider.body);
  const providerId = (provider.json() as { data: { id: string } }).data.id;

  const model = await api('POST', '/api/models', {
    name: `t41_model_${SUFFIX.toLowerCase()}`,
    provider_id: providerId,
    external_model_id: `ext-t41-${SUFFIX}`,
    display_name: 'T41 模型',
    capability: 'text',
    purpose_support: ['judge'],
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

  const listed = await api('GET', '/api/models?limit=100', undefined, adminHeaders);
  assert.equal(listed.statusCode, 200, listed.body);
  const item = (listed.json() as { data: { items: Array<{ id: string; version: number }> } }).data.items.find(
    (row) => row.id === modelId,
  );
  assert.equal(item?.version, 1);

  const patched = await api('PATCH', `/api/models/${modelId}`, { display_name: 'T41 模型改' }, adminHeaders, {
    'if-match': '1',
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal((patched.json() as { data: { version: number } }).data.version, 2);

  const conflict = await api('PATCH', `/api/models/${modelId}`, { display_name: '旧版本' }, adminHeaders, {
    'if-match': '1',
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
});
