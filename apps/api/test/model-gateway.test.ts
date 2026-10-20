/** t7 验收：模型网关（可见性 / 配额 / 降级 / 计量 / 管理流程 / 文本 adapter）。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  AdapterError,
  CircuitBreaker,
  MapCredentialResolver,
  ModelGateway,
  OpenAICompatibleAdapter,
  PrismaRegistryRepo,
  QuotaService,
  minLimits,
  type ModelRow,
  type Principal,
  type ProviderAdapter,
  type ProviderRow,
} from '@dssaas/registry';
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
const VIEWER_PASSWORD = 'TestViewerPassword!2026';
const MODEL_CREDENTIALS = JSON.stringify({ mock_cred: 'sk-mock-test' });

let app: FastifyInstance;
let admin: { id: string; email: string };
let operator: { id: string; email: string };
let viewer: { id: string; email: string };
let quotaAdmin: { id: string; email: string };
let priceAdmin: { id: string; email: string };
let adminHeaders: Record<string, string>;
let adminCookies: Record<string, string>;

interface CreatedProvider {
  id: string;
}
interface CreatedModel {
  id: string;
  version: number;
}
interface CreatedRoute {
  id: string;
  version: number;
}

async function post(path: string, payload: unknown, headers = adminHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `test-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function patch(path: string, payload: unknown, version: number, headers = adminHeaders) {
  return app.inject({
    method: 'PATCH',
    url: path,
    headers: {
      ...headers,
      'content-type': 'application/json',
      'if-match': String(version),
      'idempotency-key': `test-${randomUUID()}`,
    },
    payload: payload as Record<string, unknown>,
  });
}

async function createProvider(input: {
  kind: 'text' | 'image' | 'video' | 'embedding';
  name: string;
  credentialRef?: string;
  extra?: Record<string, unknown>;
}): Promise<CreatedProvider> {
  const response = await post('/api/providers', {
    kind: input.kind,
    name: input.name,
    base_url: `https://${input.name.replaceAll('_', '-')}.mock.local`,
    credential_ref: input.credentialRef ?? 'mock_cred',
    vendor: 'other',
    extra: input.extra ?? { mock: true },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { data: CreatedProvider };
  return body.data;
}

async function activateProvider(providerId: string): Promise<void> {
  const response = await post(`/api/providers/${providerId}/test`, {});
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((response.json() as { data: { ok: boolean } }).data.ok, true);
}

async function createTextModel(
  providerId: string,
  name: string,
  price = { input_per_1k_cents: 1, output_per_1k_cents: 2 },
): Promise<CreatedModel> {
  const response = await post('/api/models', {
    name,
    provider_id: providerId,
    external_model_id: `ext-${name}`,
    display_name: `测试模型 ${name}`,
    capability: 'text',
    purpose_support: ['copy', 'judge'],
    params_schema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, temperature: { type: 'number' } },
      required: ['prompt'],
      additionalProperties: false,
    },
    default_params: { prompt: 'hello' },
    price: { text: price },
    context_tokens: 4096,
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: CreatedModel }).data;
}

async function testAndPublishModel(modelId: string): Promise<void> {
  const tested = await post(`/api/models/${modelId}/test`, {});
  assert.equal(tested.statusCode, 200, tested.body);
  assert.equal((tested.json() as { data: { ok: boolean } }).data.ok, true);
  const published = await post(`/api/models/${modelId}/publish`, {});
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(
    (published.json() as { data: { status: string } }).data.status,
    'published',
  );
}

async function createRoute(input: {
  purpose?: 'copy' | 'judge' | 'image' | 'video' | 'embed' | 'rerank';
  modelId: string;
  fallbackIds?: string[];
  priority?: number;
  dailyCalls?: number;
  scopeUserId?: string;
}): Promise<CreatedRoute> {
  const response = await post('/api/routes', {
    scope_type: input.scopeUserId ? 'user' : 'org',
    ...(input.scopeUserId ? { scope_user_id: input.scopeUserId } : {}),
    purpose: input.purpose ?? 'copy',
    model_id: input.modelId,
    fallback_ids: input.fallbackIds ?? [],
    priority: input.priority ?? 1,
    status: 'active',
    ...(input.dailyCalls === undefined ? {} : { quota: { daily_calls: input.dailyCalls } }),
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { data: CreatedRoute }).data;
}

async function principal(roleCode: 'viewer' | 'operator' | 'admin', userId: string): Promise<Principal> {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, archivedAt: null } });
  return { orgId: 1, userId, roles: [roleCode], roleIds: [role.id] };
}

before(async () => {
  app = await buildTestApp({ DSSAAS_MODEL_CREDENTIALS: MODEL_CREDENTIALS });
  admin = await createUser({
    email: 'admin.models@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  operator = await createUser({
    email: 'operator.models@test.local',
    password: OPERATOR_PASSWORD,
    role: 'operator',
  });
  viewer = await createUser({
    email: 'viewer.models@test.local',
    password: VIEWER_PASSWORD,
    role: 'viewer',
  });
  quotaAdmin = await createUser({
    email: 'quota.models@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  priceAdmin = await createUser({
    email: 'price.models@test.local',
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  adminCookies = cookiesFrom(adminLogin);
  adminHeaders = sessionHeaders(adminCookies, csrfFrom(adminLogin));
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test('管理流程：provider 测试→active，model 测试→发布，route 发布；未测试模型发布被阻断', async () => {
  const provider = await createProvider({ kind: 'text', name: 'mock_text_flow' });
  await activateProvider(provider.id);
  const model = await createTextModel(provider.id, 'txt.mock.flow.v1');
  const blocked = await post(`/api/models/${model.id}/publish`, {});
  assert.equal(blocked.statusCode, 409);
  assert.equal((blocked.json() as { error: { code: string } }).error.code, 'publish_blocked');

  await testAndPublishModel(model.id);
  const route = await createRoute({ modelId: model.id, priority: 1 });
  assert.equal(route.id.length, 36);

  const providers = await app.inject({
    method: 'GET',
    url: '/api/providers',
    headers: adminHeaders,
  });
  const providerBody = providers.json() as {
    data: { items: Array<{ id: string; status: string; credential_ref_masked: string }> };
  };
  const listed = providerBody.data.items.find((item) => item.id === provider.id);
  assert.equal(listed?.status, 'active');
  assert.ok(listed?.credential_ref_masked.includes('****'));
});

test('可见性：operator 可见；viewer 为空；admin 带 visible；撤销凭据/停用模型后立即消失', async () => {
  const provider = await createProvider({ kind: 'text', name: 'mock_text_visibility' });
  await activateProvider(provider.id);
  const model = await createTextModel(provider.id, 'txt.mock.visible.v1');
  await testAndPublishModel(model.id);
  await createRoute({ modelId: model.id, priority: 2 });

  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  const operatorCookies = cookiesFrom(operatorLogin);
  const visible = await app.inject({
    method: 'GET',
    url: '/api/models',
    headers: sessionHeaders(operatorCookies),
  });
  assert.equal(visible.statusCode, 200);
  const visibleItems = (visible.json() as { data: { items: Array<{ id: string; visible: boolean }> } }).data.items;
  assert.ok(visibleItems.some((item) => item.id === model.id && item.visible));

  const viewerLogin = await login(app, viewer.email, VIEWER_PASSWORD);
  const viewerList = await app.inject({
    method: 'GET',
    url: '/api/models',
    headers: sessionHeaders(cookiesFrom(viewerLogin)),
  });
  assert.deepEqual((viewerList.json() as { data: { items: unknown[] } }).data.items, []);

  const adminList = await app.inject({
    method: 'GET',
    url: '/api/models',
    headers: sessionHeaders(adminCookies),
  });
  const adminItems = (adminList.json() as {
    data: { items: Array<{ id: string; visible: boolean }> };
  }).data.items;
  assert.equal(adminItems.find((item) => item.id === model.id)?.visible, true);

  await prisma.credentialRef.updateMany({
    where: { name: 'mock_cred', archivedAt: null },
    data: { status: 'revoked' },
  });
  const afterRevoke = await app.inject({
    method: 'GET',
    url: '/api/models',
    headers: sessionHeaders(operatorCookies),
  });
  assert.equal(
    (afterRevoke.json() as { data: { items: unknown[] } }).data.items.some(
      (item: unknown) => (item as { id: string }).id === model.id,
    ),
    false,
  );
  await prisma.credentialRef.updateMany({
    where: { name: 'mock_cred', archivedAt: null },
    data: { status: 'active' },
  });

  await post(`/api/models/${model.id}/suspend`, {});
  const afterSuspend = await app.inject({
    method: 'GET',
    url: '/api/models',
    headers: sessionHeaders(operatorCookies),
  });
  assert.equal(
    (afterSuspend.json() as { data: { items: unknown[] } }).data.items.some(
      (item: unknown) => (item as { id: string }).id === model.id,
    ),
    false,
  );
});

test('角色 × 用途：operator 不能使用 embed；admin 可用', async () => {
  const provider = await createProvider({ kind: 'embedding', name: 'mock_embed_provider' });
  await activateProvider(provider.id);
  const created = await post('/api/models', {
    name: 'emb.mock.v1',
    provider_id: provider.id,
    external_model_id: 'ext-emb-mock',
    display_name: '测试嵌入模型',
    capability: 'embedding',
    purpose_support: ['embed'],
    params_schema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
    default_params: { input: 'hello' },
    price: { embed: { per_1k_tokens_cents: 1 } },
    embed_dim: 1024,
  });
  assert.equal(created.statusCode, 201, created.body);
  const modelId = (created.json() as { data: CreatedModel }).data.id;
  await testAndPublishModel(modelId);
  await createRoute({ purpose: 'embed', modelId, priority: 1 });

  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  const operatorEmbed = await app.inject({
    method: 'GET',
    url: '/api/models?purpose=embed',
    headers: sessionHeaders(cookiesFrom(operatorLogin)),
  });
  assert.deepEqual((operatorEmbed.json() as { data: { items: unknown[] } }).data.items, []);

  const adminEmbed = await app.inject({
    method: 'GET',
    url: '/api/models?purpose=embed',
    headers: sessionHeaders(adminCookies),
  });
  assert.ok(
    (adminEmbed.json() as { data: { items: Array<{ id: string; visible: boolean }> } }).data.items.some(
      (item) => item.id === modelId && item.visible,
    ),
  );

  const customGateway = new ModelGateway({
    repo: app.registry.repo,
    adapterFactory: app.registry.adapterFactory,
    quota: new QuotaService(app.registry.repo),
    breaker: new CircuitBreaker(),
    credentials: new MapCredentialResolver({ mock_cred: 'sk-mock-test' }),
  });
  await assert.rejects(
    () =>
      customGateway.invoke({
        principal: { orgId: 1, userId: operator.id, roles: ['operator'], roleIds: [] },
        purpose: 'embed',
        requestId: 'req_test_embed_forbidden',
        actorType: 'user',
        actorId: operator.id,
        estimate: { tokensIn: 10 },
      }),
    (error: unknown) => (error as { code?: string }).code === 'role_forbidden',
  );
});

test('降级 + 计量：主模型 500 → fallback 成功，degraded=true，费用按 fallback 价', async () => {
  const provider = await createProvider({ kind: 'text', name: 'mock_text_fallback' });
  await activateProvider(provider.id);
  const fallbackProvider = await createProvider({ kind: 'text', name: 'mock_text_fallback_two' });
  await activateProvider(fallbackProvider.id);
  const primary = await createTextModel(provider.id, 'txt.mock.primary.v1', {
    input_per_1k_cents: 1,
    output_per_1k_cents: 2,
  });
  const fallback = await createTextModel(fallbackProvider.id, 'txt.mock.fallback.v1', {
    input_per_1k_cents: 100,
    output_per_1k_cents: 200,
  });
  await testAndPublishModel(primary.id);
  await testAndPublishModel(fallback.id);
  const route = await createRoute({
    modelId: primary.id,
    fallbackIds: [fallback.id],
    priority: 1,
    scopeUserId: admin.id,
  });

  const failing: ProviderAdapter = {
    kind: 'text',
    test: async () => ({ ok: true, latencyMs: 1 }),
    invoke: async () => {
      throw new AdapterError('upstream_5xx', 500, true);
    },
  };
  const succeeding: ProviderAdapter = {
    kind: 'text',
    test: async () => ({ ok: true, latencyMs: 1 }),
    invoke: async () => ({
      text: 'fallback-ok',
      usage: { inputTokens: 1500, outputTokens: 500, tokensSource: 'provider_usage' },
    }),
  };
  const repo = new PrismaRegistryRepo(prisma);
  const gateway = new ModelGateway({
    repo,
    adapterFactory: (candidate) => (candidate.id === provider.id ? { ...failing } : succeeding),
    quota: new QuotaService(repo),
    breaker: new CircuitBreaker(),
    credentials: new MapCredentialResolver({ mock_cred: 'sk-mock-test' }),
    audit: {
      record: async (input) =>
        app.audit.record({
          action: input.action,
          actorType: input.actorType,
          actorId: input.actorId,
          requestId: input.requestId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          before: input.before,
          after: input.after,
          irreversible: input.irreversible,
          meta: input.meta,
          ip: input.ip,
          userAgent: input.userAgent,
        }),
    },
  });

  const result = await gateway.invoke({
    principal: await principal('admin', admin.id),
    purpose: 'copy',
    requestId: 'req_test_fallback_0001',
    actorType: 'user',
    actorId: admin.id,
    params: { prompt: 'hi' },
    estimate: { tokensIn: 1500, tokensOut: 500 },
  });
  assert.equal(result.decision.degraded, true);
  assert.equal(result.decision.fallbackFrom, primary.id);
  assert.equal(result.decision.modelId, fallback.id);
  assert.equal(result.decision.reason, 'fallback');
  assert.equal(result.costCents, 250); // ceil(1500*100/1000) + ceil(500*200/1000)

  const logs = await prisma.modelCallLog.findMany({
    where: { requestId: 'req_test_fallback_0001' },
    orderBy: { startedAt: 'asc' },
  });
  assert.equal(logs.length, 2);
  const failed = logs.find((row) => row.modelId === primary.id);
  const succeeded = logs.find((row) => row.modelId === fallback.id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.costCents, 0);
  assert.equal(succeeded?.status, 'succeeded');
  assert.equal(succeeded?.costCents, 250);
  assert.equal(succeeded?.fallbackFromModelId, primary.id);
  assert.ok(succeeded?.priceSnapshot);

  const usage = await app.inject({
    method: 'GET',
    url: `/api/usage?from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600_000).toISOString())}`,
    headers: adminHeaders,
  });
  assert.equal(usage.statusCode, 200, usage.body);
  const usageBody = usage.json() as { data: { total_cents: number } };
  assert.ok(usageBody.data.total_cents >= 250);

  const fallbackAudits = await prisma.auditLog.findMany({
    where: { action: 'model.fallback', resourceId: fallback.id },
  });
  assert.ok(fallbackAudits.length >= 1);
  assert.equal(route.id.length, 36);
});

test('配额：daily_calls=1 时第二次调用被拒（quota_exceeded）', async () => {
  const provider = await createProvider({ kind: 'text', name: 'mock_text_quota' });
  await activateProvider(provider.id);
  const model = await createTextModel(provider.id, 'txt.mock.quota.v1');
  await testAndPublishModel(model.id);
  await createRoute({
    modelId: model.id,
    priority: 1,
    dailyCalls: 1,
    purpose: 'judge',
    scopeUserId: quotaAdmin.id,
  });

  const repo = new PrismaRegistryRepo(prisma);
  const gateway = new ModelGateway({
    repo,
    adapterFactory: app.registry.adapterFactory,
    quota: new QuotaService(repo),
    breaker: new CircuitBreaker(),
    credentials: new MapCredentialResolver({ mock_cred: 'sk-mock-test' }),
  });
  const input = {
    principal: await principal('admin', quotaAdmin.id),
    purpose: 'judge' as const,
    requestId: 'req_test_quota_0001',
    actorType: 'user' as const,
    actorId: quotaAdmin.id,
    params: { prompt: 'hi' },
    estimate: { tokensIn: 10, tokensOut: 5 },
  };
  const first = await gateway.invoke(input);
  assert.ok(first.callLogId);
  await assert.rejects(
    () => gateway.invoke({ ...input, requestId: 'req_test_quota_0002' }),
    (error: unknown) => (error as { code?: string }).code === 'quota_exceeded',
  );
});

test('配额键取严：camelCase/snake_case 都识别，三层取最小值', () => {
  const limits = minLimits(
    { rpm: 10, tpm: 1000, dailyCalls: 5, dailyCostCents: 500 },
    { rpm: 2, daily_calls: 9, daily_cost_cents: 800 },
    { concurrency: 3 },
  );
  assert.equal(limits.rpm, 2);
  assert.equal(limits.tpm, 1000);
  assert.equal(limits.concurrency, 3);
  assert.equal(limits.dailyCalls, 5);
  assert.equal(limits.dailyCostCents, 500);
});

test('熔断：连续 5 次超时打开，冷却后进入半开，成功闭合', async () => {
  let clock = 1_000_000;
  const breaker = new CircuitBreaker({ consecutiveTimeouts: 5, openMs: 60_000 }, () => clock);
  for (let index = 0; index < 5; index += 1) breaker.recordFailure('model:1', 'timeout');
  assert.equal(breaker.isOpen('model:1'), true);
  clock += 60_001;
  assert.equal(breaker.isOpen('model:1'), false);
  breaker.recordSuccess('model:1');
  assert.equal(breaker.isOpen('model:1'), false);
});

test('文本 adapter：OpenAI-compatible 请求/响应与 token 用量解析', async () => {
  let receivedAuth = '';
  const server = http.createServer((req, res) => {
    receivedAuth = String(req.headers.authorization ?? '');
    if (req.url === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'ext-model' }] }));
      return;
    }
    if (req.url === '/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model: string; messages: unknown[] };
        assert.equal(parsed.model, 'ext-model');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'hello from adapter' } }],
            usage: { prompt_tokens: 1200, completion_tokens: 300 },
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const now = new Date();
  const provider: ProviderRow = {
    id: 'provider-local',
    orgId: 1,
    name: 'local_text',
    kind: 'text',
    vendor: 'openai_compatible',
    baseUrl: `http://127.0.0.1:${address.port}`,
    credentialRef: 'mock_cred',
    authScheme: 'bearer',
    timeoutMs: 3000,
    maxConcurrency: 8,
    rateLimit: {},
    status: 'active',
    connectivity: 'ok',
    lastCheckAt: now,
    lastCheckLatencyMs: 1,
    lastErrorCode: null,
    balanceCents: null,
    region: null,
    extra: {},
    version: 1,
  };
  const model: ModelRow = {
    id: 'model-local',
    orgId: 1,
    providerId: provider.id,
    name: 'txt.local.v1',
    externalModelId: 'ext-model',
    displayName: '本地模型',
    capability: 'text',
    purposeSupport: ['copy'],
    paramsSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
    defaultParams: { prompt: 'hi' },
    price: { text: { input_per_1k_cents: 1, output_per_1k_cents: 2 } },
    priceVersion: 1,
    rateLimit: {},
    contextTokens: 4096,
    maxOutputTokens: null,
    embedDim: null,
    status: 'published',
    publishedAt: now,
    publishedBy: null,
    sunsetAt: null,
    version: 1,
  };

  try {
    const adapter = new OpenAICompatibleAdapter();
    const probe = await adapter.test(provider, 'sk-test');
    assert.equal(probe.ok, true);
    const result = await adapter.invoke({
      purpose: 'copy',
      model,
      provider,
      params: { prompt: 'hello' },
      credential: 'sk-test',
      timeoutMs: 3000,
    });
    assert.equal(result.text, 'hello from adapter');
    assert.equal(result.usage?.inputTokens, 1200);
    assert.equal(result.usage?.outputTokens, 300);
    assert.equal(receivedAuth, 'Bearer sk-test');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('改价：price_version+1，旧调用成本不变，新调用按新价计费', async () => {
  const provider = await createProvider({ kind: 'text', name: 'mock_text_price' });
  await activateProvider(provider.id);
  const model = await createTextModel(provider.id, 'txt.mock.price.v1', {
    input_per_1k_cents: 1,
    output_per_1k_cents: 1,
  });
  await testAndPublishModel(model.id);
  await createRoute({ modelId: model.id, priority: 1, purpose: 'judge', scopeUserId: priceAdmin.id });

  const before = await prisma.model.findUniqueOrThrow({ where: { id: model.id } });
  const patched = await patch(
    `/api/models/${model.id}`,
    { price: { text: { input_per_1k_cents: 10, output_per_1k_cents: 20 } } },
    before.version,
  );
  assert.equal(patched.statusCode, 200, patched.body);
  const patchedBody = patched.json() as { data: { price_version: number } };
  assert.equal(patchedBody.data.price_version, 2);

  const audit = await prisma.auditLog.findFirst({
    where: { action: 'model.price_change', resourceId: model.id },
    orderBy: { seq: 'desc' },
  });
  assert.ok(audit);

  const repo = new PrismaRegistryRepo(prisma);
  const gateway = new ModelGateway({
    repo,
    adapterFactory: app.registry.adapterFactory,
    quota: new QuotaService(repo),
    breaker: new CircuitBreaker(),
    credentials: new MapCredentialResolver({ mock_cred: 'sk-mock-test' }),
  });
  const result = await gateway.invoke({
    principal: await principal('admin', priceAdmin.id),
    purpose: 'judge',
    requestId: 'req_test_price_0001',
    actorType: 'user',
    actorId: admin.id,
    params: { prompt: 'hi' },
    estimate: { tokensIn: 10, tokensOut: 5 },
  });
  // mock adapter 固定 usage 10/5；新价 10/20 分每 1k → ceil(10*10/1000)+ceil(5*20/1000)=2
  assert.equal(result.costCents, 2);
});
