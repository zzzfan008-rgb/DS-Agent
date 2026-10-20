#!/usr/bin/env node
/**
 * t38 端到端全链路验证：商品 → 文案 → 判定 → 审批 → 上架(dry-run)
 * → 客服/SSE → 回复发送(dry-run) → 媒体(mock) → 知识库。
 *
 * 运行方式（推荐复用既有 Postgres，独立库）：
 *   DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL=postgresql://.../dssaas_test?schema=public pnpm e2e
 * 也可直接：
 *   TEST_DATABASE_URL=postgresql://.../dssaas_test_<6hex>?schema=public \
 *     node apps/api/node_modules/tsx/dist/cli.mjs scripts/e2e/full-chain.mjs
 *
 * 约束：
 * - 不访问真实平台/模型：平台写走 dry_run，模型用进程内 mock gateway，媒体用 MockMediaProvider；
 * - 不写真实密钥；数据库来自 with-db，脚本不清理（独立库由 with-db 销毁）；
 * - 每一步失败打印中文原因 + request_id，并写 artifacts/e2e/report.json；
 * - 跨模块不一致只记录到 report/findings 与 docs/验收记录-E2E.md，不改其他模块。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '../../packages/db/src/index.ts';
import { createFactEnvelope } from '../../packages/core/src/index.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { hashPassword } from '../../apps/api/src/lib/password.ts';
import { buildProductFacts } from '../../apps/api/src/services/facts.ts';
import { contentDraftTargetPayload } from '../../apps/api/src/services/content-target.ts';
import { publishTargetPayload } from '../../apps/api/src/write-gate/gate.ts';
import { parseCsv } from '../../apps/api/src/services/products.ts';
import { MediaPipeline } from '../../apps/worker/src/media/pipeline.ts';
import { PrismaMediaRepository } from '../../apps/worker/src/media/prisma-repository.ts';
import { MockMediaProvider } from '../../apps/worker/src/media/provider.ts';
import { FsStorage } from '../../apps/worker/src/media/storage.ts';
import { MEDIA_BUCKET } from '../../apps/worker/src/media/keys.ts';
import { renderSizeChart } from '../../apps/worker/src/media/render.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_FILE = path.join(REPO_ROOT, 'artifacts/e2e/report.json');
const MEDIA_ROOT = path.join(REPO_ROOT, 'artifacts/e2e/media');
const DOWNLOAD_ROOT = path.join(REPO_ROOT, 'artifacts/e2e/downloads');
const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const ADMIN_EMAIL = 'e2e.admin@test.local';
const OPERATOR_EMAIL = 'e2e.operator@test.local';
const ADMIN_PASSWORD = 'E2eAdminPassword!2026';
const OPERATOR_PASSWORD = 'E2eOperatorPassword!2026';

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const steps = [];
const findings = [];
const expectedFailures = [];
let currentStep = null;
let lastRequestId = null;
let apiBase = '';
let app = null;

class StepFailure extends Error {
  constructor(message, requestId = null) {
    super(message);
    this.name = 'StepFailure';
    this.requestId = requestId;
  }
}

function maskUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(invalid)';
  }
}

function recordAssertion(record, message, ok, detail) {
  record.assertions.push({ message, status: ok ? 'passed' : 'failed', ...(detail === undefined ? {} : { detail }) });
  if (!ok) throw new StepFailure(message);
}

function assertThat(record, condition, message, detail) {
  recordAssertion(record, message, Boolean(condition), detail);
}

async function step(id, name, fn) {
  const record = { id, name, status: 'running', duration_ms: 0, assertions: [], request_ids: [] };
  steps.push(record);
  currentStep = record;
  const started = Date.now();
  try {
    await fn(record);
    record.status = 'passed';
  } catch (error) {
    record.status = 'failed';
    record.error = {
      message: error instanceof StepFailure ? error.message : `${error?.message ?? error}`,
      request_id: error?.requestId ?? lastRequestId,
    };
    throw error;
  } finally {
    record.duration_ms = Date.now() - started;
    record.request_ids = [...new Set(record.request_ids)];
    currentStep = null;
  }
}

async function api(method, pathName, { role = 'operator', body, headers = {} } = {}) {
  const auth = role ? auths[role] : null;
  const requestHeaders = { accept: 'application/json', ...headers };
  if (auth) requestHeaders.cookie = auth.cookie;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  if (method !== 'GET') {
    if (auth) requestHeaders['x-csrf-token'] = auth.csrf;
    requestHeaders['idempotency-key'] = randomUUID();
  }
  const response = await fetch(`${apiBase}${pathName}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  const requestId = response.headers.get('x-request-id') ?? json?.request_id ?? null;
  if (requestId) {
    lastRequestId = requestId;
    currentStep?.request_ids.push(requestId);
  }
  if (!response.ok) {
    const error = json?.error ?? {};
    const detail = error.detail === undefined ? '' : ` detail=${JSON.stringify(error.detail).slice(0, 800)}`;
    throw new StepFailure(
      `请求失败：${method} ${pathName} → HTTP ${response.status} ${error.code ?? ''} ${error.message ?? ''}${detail}`.trim(),
      requestId,
    );
  }
  return { status: response.status, body: json, request_id: requestId, headers: response.headers };
}

const auths = { admin: null, operator: null };

async function login(email, password) {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  const requestId = response.headers.get('x-request-id') ?? json?.request_id ?? null;
  if (!response.ok) {
    throw new StepFailure(
      `登录失败：HTTP ${response.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`.trim(),
      requestId,
    );
  }
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies
    .map((value) => value.split(';')[0])
    .filter((value) => value.startsWith('dssaas_sid=') || value.startsWith('dssaas_csrf='))
    .join('; ');
  return { cookie, csrf: json.data.csrf_token, requestId };
}

async function ensureUser(email, password, roleCode, displayName) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  if (existing) return existing.id;
  const user = await prisma.user.create({
    data: {
      orgId: 1n,
      email,
      displayName,
      passwordHash: await hashPassword(password),
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
  return user.id;
}

function dummyVector(text) {
  const vector = new Array(1024).fill(0);
  for (let index = 0; index < text.length; index += 1) {
    vector[(index * 31 + text.charCodeAt(index)) % 1024] += 1;
  }
  if (!vector.some((value) => value !== 0)) vector[0] = 1;
  return vector;
}

let kbEvidence = null;
let e2eProviderId = null;
let e2eModelId = null;

/** 进程内 mock gateway：copy 返回中文文案，judge 返回带 KB 引用的 JSON，embed 返回确定性向量。 */
function installMockGateway() {
  const gateway = app.registry.gateway;
  gateway.invoke = async (request) => {
    // content_draft.model_call_id / judgment.model_call_id 有 FK，必须落一条可追溯调用流水。
    const call = await prisma.modelCallLog.create({
      data: {
        orgId: 1n,
        requestId: request.requestId,
        purpose: request.purpose,
        providerId: e2eProviderId,
        modelId: e2eModelId,
        actorType: 'user',
        actorId: null,
        subjectType: 'other',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 5,
        status: 'succeeded',
        tokensSource: 'estimated',
        costCents: 1,
        priceSnapshot: {},
      },
    });
    const callLogId = call.id;
    const base = {
      decision: {
        routeId: 'e2e-route',
        modelId: e2eModelId,
        providerId: e2eProviderId,
        degraded: false,
        reason: 'primary',
      },
      usage: { inputTokens: 10, outputTokens: 5, tokensSource: 'estimated' },
      costCents: 1,
      latencyMs: 5,
      callLogId,
    };
    if (request.purpose === 'embed') {
      const inputs = request.params?.inputs;
      const texts = Array.isArray(inputs) ? inputs.map(String) : [String(inputs ?? '')];
      return { ...base, response: { text: 'mock:embed', vectors: texts.map(dummyVector) } };
    }
    if (request.purpose === 'judge') {
      const evidence = kbEvidence ?? {
        doc_id: '00000000-0000-4000-8000-000000000000',
        chunk_id: 'e2e-no-evidence',
        doc_version: 1,
        quote: '无',
      };
      const text = JSON.stringify({
        verdict: 'pass',
        severity: 'low',
        reason: '未发现违规表述，事实与证据一致',
        repair_hint: '无需修改',
        evidence_refs: [evidence],
        confidence: 0.92,
        claims: [],
        checked_rule_ids: [],
      });
      return { ...base, response: { text } };
    }
    return { ...base, response: { text: '纯棉圆领短袖T恤，100%棉，透气舒适，常规版型。' } };
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function readGoldenProduct() {
  const csv = await readFile(path.join(REPO_ROOT, 'data/golden/products.csv'), 'utf8');
  const table = parseCsv(csv);
  const row = table.rows.find((item) => item.values.spu_code === 'GOLD-SPU-001');
  if (!row) throw new StepFailure('黄金集 data/golden/products.csv 中找不到 GOLD-SPU-001');
  const chartsText = await readFile(path.join(REPO_ROOT, 'data/golden/size-charts.jsonl'), 'utf8');
  const chart = chartsText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((item) => item.spu_code === 'GOLD-SPU-001');
  if (!chart) throw new StepFailure('黄金集 size-charts.jsonl 中找不到 GOLD-SPU-001 尺码表');
  return { row: row.values, chart };
}

async function main() {
  if (!DB_URL) {
    console.error('[e2e] 缺少 TEST_DATABASE_URL/DATABASE_URL，请用 pnpm e2e（with-db）运行。');
    process.exit(2);
  }
  const databaseName = new URL(DB_URL).pathname.replace(/^\//, '');
  if (!/(^dssaas_test_[0-9a-z]{6}$)|(_test$)|(^dssaas_ci$)/.test(databaseName)) {
    console.error(`[e2e] 拒绝在非隔离库上运行：${databaseName}`);
    process.exit(2);
  }

  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
    DSSAAS_ENABLE_INTERNAL_SIMULATION: '1',
  });
  app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  apiBase = `http://127.0.0.1:${address.port}`;
  installMockGateway();

  await step('01', 'seed admin/operator + 登录', async (record) => {
    await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD, 'admin', 'E2E 管理员');
    await ensureUser(OPERATOR_EMAIL, OPERATOR_PASSWORD, 'operator', 'E2E 运营');
    const suffix = randomUUID().slice(0, 8);
    const provider = await prisma.provider.create({
      data: {
        orgId: 1n,
        name: `e2e_provider_${suffix}`,
        kind: 'text',
        credentialRef: 'e2e_cred',
        status: 'active',
        extra: { mock: true },
      },
    });
    const model = await prisma.model.create({
      data: {
        orgId: 1n,
        providerId: provider.id,
        name: `e2e.model.${suffix}`,
        externalModelId: 'e2e-mock-model',
        displayName: 'E2E Mock 模型',
        capability: 'text',
        purposeSupport: ['copy', 'judge', 'embed'],
        paramsSchema: { type: 'object', properties: {}, additionalProperties: true },
        price: { text: { input_per_1k_cents: 1, output_per_1k_cents: 1 } },
        contextTokens: 4096,
        status: 'published',
        publishedAt: new Date(),
      },
    });
    e2eProviderId = provider.id;
    e2eModelId = model.id;
    auths.admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    auths.operator = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);
    assertThat(record, /dssaas_sid=/.test(auths.admin.cookie), 'admin 登录成功并拿到会话 Cookie');
    assertThat(record, /dssaas_sid=/.test(auths.operator.cookie), 'operator 登录成功并拿到会话 Cookie');
    assertThat(record, auths.admin.csrf.length > 0, 'admin 拿到 CSRF token');
  });

  const golden = await readGoldenProduct();
  let productId;
  let listing;
  let titleDraft;
  let sellingDraft;
  let kbDocId;
  let kbDocVersion;
  const conversationA = `e2e-conv-a-${randomUUID().slice(0, 8)}`;
  const conversationB = `e2e-conv-b-${randomUUID().slice(0, 8)}`;

  await step('02', '导入黄金集商品 GOLD-SPU-001', async (record) => {
    const fabric = JSON.parse(golden.row.fabric_json);
    const sizeRef = JSON.parse(golden.row.size_chart_json);
    const sizes = golden.chart.sizes;
    const price = Number(golden.row.price_cents);
    const totalStock = Number(golden.row.stock_qty);
    const perSizeStock = Math.max(1, Math.floor(totalStock / sizes.length));
    const header =
      'spu_code,name,category_code,color_id,size_code,price_cents,list_price_cents,sale_price_cents,stock_qty,fabric_materials,measurements,effective_from,size_system';
    const lines = [header];
    for (const size of sizes) {
      lines.push(
        [
          golden.row.spu_code,
          golden.row.title,
          golden.row.category_code,
          'BK-0101',
          size.sku_size_code,
          price,
          golden.row.list_price_cents ?? price,
          golden.row.sale_price_cents ?? '',
          perSizeStock,
          JSON.stringify(fabric.materials),
          JSON.stringify(size.measurements),
          golden.chart.effective_from,
          golden.chart.size_system,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    const imported = await api('POST', '/api/products/import', {
      role: 'operator',
      body: { csv: `${lines.join('\n')}\n`, platform_scope: 'both' },
    });
    assertThat(record, imported.status === 201, '导入返回 201', { status: imported.status });
    assertThat(record, imported.body.data.rows_ok === sizes.length, `导入 ${sizes.length} 行全部成功`, imported.body.data);
    assertThat(record, imported.body.data.rows_failed.length === 0, '导入无失败行', imported.body.data.rows_failed);

    const list = await api('GET', `/api/products?q=${encodeURIComponent(golden.row.spu_code)}&limit=10`, { role: 'operator' });
    const item = list.body.data.items.find((entry) => entry.spu_code === golden.row.spu_code);
    assertThat(record, Boolean(item), '商品列表可查到 GOLD-SPU-001');
    assertThat(record, item.platform_states.pdd.status === 'not_listed', 'PDD 平台态为 not_listed', item.platform_states.pdd);
    assertThat(record, item.platform_states['1688'].status === 'not_listed', '1688 平台态为 not_listed', item.platform_states['1688']);
    productId = item.id;
    assertThat(record, Boolean(productId), '拿到商品 ID');
    // 防止未使用变量（sizeRef 仅用于说明导入使用尺码表码集）
    assertThat(record, Array.isArray(sizeRef.sku_size_codes) && sizeRef.sku_size_codes.length === sizes.length, '黄金集尺码码集与图表一致');
  });

  await step('03', '生成文案草稿（标题 + 卖点）', async (record) => {
    titleDraft = await api('POST', '/api/content/drafts', {
      role: 'operator',
      body: { content_type: 'title', product_id: productId, platform: 'pdd', tone: '专业' },
    });
    assertThat(record, titleDraft.status === 201, '标题草稿返回 201', { status: titleDraft.status });
    assertThat(record, titleDraft.body.data.facts_hash.length === 64, '标题草稿带 facts_hash（64 hex）');
    assertThat(record, Boolean(titleDraft.body.data.model_call_id), '标题草稿带 model_call_id');
    assertThat(record, titleDraft.body.data.content.length > 0, '标题草稿正文非空');

    sellingDraft = await api('POST', '/api/content/drafts', {
      role: 'operator',
      body: { content_type: 'selling_points', product_id: productId, platform: 'pdd', tone: '专业' },
    });
    assertThat(record, sellingDraft.status === 201, '卖点草稿返回 201', { status: sellingDraft.status });
    assertThat(record, sellingDraft.body.data.facts_hash.length === 64, '卖点草稿带 facts_hash');
    assertThat(record, Boolean(sellingDraft.body.data.model_call_id), '卖点草稿带 model_call_id');
  });

  // 预置 KB 政策：L2 证据只接受 kb_document 引用；这一步同时服务步骤 11 的检索断言。
  await step('03b', '预置退换政策知识库（L2 证据来源）', async (record) => {
    const ingested = await api('POST', '/api/kb/documents', {
      role: 'operator',
      body: {
        title: 'E2E 退换货政策',
        domain: 'policy',
        file_name: 'e2e-return-policy.md',
        mime: 'text/markdown',
        source_ref: `e2e-policy-${randomUUID().slice(0, 8)}`,
        source_type: 'policy',
        doc_type: 'policy',
        content:
          '# 退换货政策\n\n自签收之日起 7 天内，商品完好、不影响二次销售可申请无理由退货。\n\n质量问题 15 天内可换货，运费按平台规则执行。\n\n定制商品、改标商品不适用无理由退货。\n',
      },
    });
    assertThat(record, ingested.status === 201, '知识库政策入库 201', { status: ingested.status });
    kbDocId = ingested.body.data.document_id;
    kbDocVersion = ingested.body.data.version;
    assertThat(record, Boolean(kbDocId), '拿到知识库文档 ID');
    const chunk = await prisma.kbChunk.findFirst({
      where: { documentId: kbDocId, status: 'active', archivedAt: null, aclRoles: { has: 'operator' } },
      orderBy: { seq: 'asc' },
    });
    assertThat(record, Boolean(chunk), '政策文档有 operator 可读切片');
    kbEvidence = {
      doc_id: kbDocId,
      chunk_id: chunk.id,
      doc_version: kbDocVersion,
      quote: chunk.content.slice(0, 80),
      effective_from: chunk.effectiveFrom?.toISOString() ?? null,
    };
  });

  listing = await prisma.listing.create({
    data: {
      orgId: 1n,
      platform: 'pdd',
      productId,
      status: 'draft',
      createdBy: (await prisma.user.findFirstOrThrow({ where: { email: OPERATOR_EMAIL } })).id,
    },
  });

  await step('04', '跑判断（L1+L2）', async (record) => {
    // 4a) 草稿绑定判断：当前 buildProductFacts 不含 KB 政策，L2 无证据会直接 escalate（已知缺口，记录）。
    const draftJudgment = await api('POST', '/api/judgments', {
      role: 'operator',
      body: { subject_type: 'content_draft', subject_id: titleDraft.body.data.draft_id, platform: 'pdd', content_type: 'title', run: 'L1+L2' },
    });
    assertThat(record, draftJudgment.status === 201, '草稿判断返回 201');
    if (draftJudgment.body.data.verdict === 'escalate') {
      findings.push({
        id: 'F-E2E-01',
        severity: 'medium',
        area: 'content_draft → judgment L2',
        summary: '草稿绑定判断无法携带 kb_document 政策证据，L2 在 NO_EVIDENCE 处直接 escalate',
        evidence: `verdict=${draftJudgment.body.data.verdict}, short_circuit=${draftJudgment.body.data.short_circuit}, request_id=${draftJudgment.request_id}`,
        depends_on: 't35 / 判断层证据组装（buildProductFacts 增加政策或允许显式 facts 引用）',
      });
      expectedFailures.push('content_draft L2 证据缺口：草稿判断 expected escalate（NO_EVIDENCE），依赖 t35/判断层证据组装');
    }
    assertThat(record, ['escalate', 'pass', 'needs_revision', 'reject'].includes(draftJudgment.body.data.verdict), '草稿判断给出确定 verdict');

    // 4b) 显式 facts + KB 政策引用的判断（可验证 L2 通路）：使用重复词命中 L1-TXT-002、L2 mock pass
    const productFacts = await buildProductFacts(prisma, productId);
    const facts = createFactEnvelope([
      ...productFacts.items,
      {
        key: 'policy',
        value: '自签收之日起 7 天内可申请无理由退货（质量问题 15 天内换货）',
        unit: 'text',
        source: 'kb',
        source_table: 'kb_document',
        source_id: kbDocId,
        source_version: kbDocVersion,
      },
    ]);
    const judged = await api('POST', '/api/judgments', {
      role: 'operator',
      body: {
        subject_type: 'listing',
        subject_id: listing.id,
        platform: 'pdd',
        content_type: 'title',
        text: '纯棉纯棉纯棉圆领短袖T恤',
        facts,
        run: 'L1+L2',
      },
    });
    const data = judged.body.data;
    assertThat(record, judged.status === 201, 'L1+L2 判断返回 201');
    assertThat(record, ['pass', 'needs_revision'].includes(data.verdict), `verdict ∈ {pass, needs_revision}（实际 ${data.verdict}）`, data.verdict);
    assertThat(record, Array.isArray(data.rule_hits) && data.rule_hits.length > 0, 'rule_hits 可追溯且非空', data.rule_hits?.map((hit) => hit.rule_id));
    assertThat(record, Array.isArray(data.evidence_refs) && data.evidence_refs.length > 0, 'evidence_refs 非空', data.evidence_refs?.length);
    assertThat(record, data.short_circuit !== 'NO_EVIDENCE', 'L2 未走 NO_EVIDENCE 短路（有 KB 证据）');
  });

  await step('05', '创建内容审批（publish_content）→ admin 批准', async (record) => {
    const draft = await prisma.contentDraft.findUniqueOrThrow({ where: { id: titleDraft.body.data.draft_id } });
    const target = contentDraftTargetPayload(draft);
    const created = await api('POST', '/api/approvals', {
      role: 'operator',
      body: {
        subject_type: 'content_draft',
        subject_id: draft.id,
        action: 'publish_content',
        platform: 'pdd',
        target_payload: target,
        context: { listingStatus: 'draft' },
      },
    });
    assertThat(record, created.status === 201, '审批创建 201', { status: created.status });
    assertThat(record, created.body.data.level === 'B', 'publish_content 定级为 B', created.body.data.level);
    const decided = await api('POST', `/api/approvals/${created.body.data.id}/decide`, {
      role: 'admin',
      body: { decision: 'approve', comment: 'E2E 自动批准' },
    });
    assertThat(record, decided.status === 200, 'admin 批准 200');
    const detail = await api('GET', `/api/approvals/${created.body.data.id}`, { role: 'admin' });
    assertThat(record, detail.body.data.status === 'approved', '审批状态流转为 approved', detail.body.data.status);
  });

  await step('06', 'listing + 上架写入门 dry_run', async (record) => {
    const target = publishTargetPayload({ product_id: productId, platform: 'pdd', sku_ids: [], media_plan: {} });
    const approval = await api('POST', '/api/approvals', {
      role: 'operator',
      body: {
        subject_type: 'listing',
        subject_id: listing.id,
        action: 'publish',
        platform: 'pdd',
        target_payload: target,
        risk_meta: { impact_scope: { sku_ids: [] }, risk_notes: ['E2E'] },
        context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
      },
    });
    assertThat(record, approval.status === 201, '上架审批创建 201');
    const decided = await api('POST', `/api/approvals/${approval.body.data.id}/decide`, {
      role: 'admin',
      body: { decision: 'approve' },
    });
    assertThat(record, decided.status === 200, '上架审批 admin 批准');

    const published = await api('POST', '/api/listings/publish', {
      role: 'operator',
      body: { product_id: productId, platform: 'pdd', sku_ids: [], approval_id: approval.body.data.id, mode: 'dry_run' },
    });
    const data = published.body.data;
    assertThat(record, published.status === 200, '上架 dry-run 返回 200');
    assertThat(record, data.result === 'success', `result=success（实际 ${data.result}）`, data.result);
    assertThat(record, data.platform_response?.status === 'dry_run', 'platform_response.status=dry_run', data.platform_response);
    const listingRow = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    assertThat(record, listingRow.status !== 'published', `dry-run 后 listing.status 未被改成 published（实际 ${listingRow.status}）`, listingRow.status);
    const writeLogs = await prisma.listingWriteLog.count({ where: { listingId: listing.id } });
    assertThat(record, writeLogs === 1, `listing_write_log 恰好 1 条（实际 ${writeLogs}）`, writeLogs);
    const auditCount = await prisma.auditLog.count({ where: { action: 'listing.write', resourceId: listing.id } });
    assertThat(record, auditCount >= 1, `审计 listing.write 至少 1 条（实际 ${auditCount}）`, auditCount);
  });

  await step('07', '模拟入站客服消息 + SSE 可拉到', async (record) => {
    const inbound = await api('POST', '/api/internal/conversations/simulate-inbound', {
      role: 'admin',
      body: {
        platform: 'pdd',
        platform_conversation_id: conversationA,
        buyer_nick: 'E2E 测试买家',
        content: '请问 M 码有货吗？',
        platform_message_id: `e2e-msg-${randomUUID().slice(0, 8)}`,
      },
    });
    assertThat(record, inbound.status === 201, '模拟入站返回 201');
    assertThat(record, inbound.body.data.unread_count === 1, '未读数 +1（=1）', inbound.body.data.unread_count);
    const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: inbound.body.data.conversation_id } });
    assertThat(record, conversation.unreadCount === 1, '数据库未读数 =1', conversation.unreadCount);

    const stream = await openSse('/api/events/stream?topics=all&last_event_id=0');
    try {
      const frame = await stream.waitFor(/event: message\.created/, 5000);
      assertThat(record, Boolean(frame), 'SSE 拉到 message.created 事件');
    } finally {
      await stream.close();
    }
  });

  let replyDraftA;
  let replyDraftB;
  await step('08', '生成回复草稿（5s 内；无证据必须降级）', async (record) => {
    const startedA = Date.now();
    replyDraftA = await api('POST', '/api/replies/draft', {
      role: 'operator',
      body: { conversation_id: (await prisma.conversation.findFirstOrThrow({ where: { platformConversationId: conversationA } })).id },
    });
    const elapsedA = Date.now() - startedA;
    assertThat(record, replyDraftA.status === 201, '无证据草稿返回 201');
    assertThat(record, replyDraftA.body.data.degraded === true, '无证据时 degraded=true');
    assertThat(record, replyDraftA.body.data.degraded_reason === 'no_evidence', '降级原因 = no_evidence', replyDraftA.body.data.degraded_reason);
    assertThat(record, elapsedA < 5000, `无证据草稿 5s 内返回（实际 ${elapsedA}ms）`);

    const inboundB = await api('POST', '/api/internal/conversations/simulate-inbound', {
      role: 'admin',
      body: {
        platform: 'pdd',
        platform_conversation_id: conversationB,
        buyer_nick: 'E2E 测试买家',
        content: '这件 T 恤是什么成分？',
        platform_message_id: `e2e-msg-${randomUUID().slice(0, 8)}`,
        related_product_id: productId,
      },
    });
    const startedB = Date.now();
    replyDraftB = await api('POST', '/api/replies/draft', {
      role: 'operator',
      body: { conversation_id: inboundB.body.data.conversation_id },
    });
    const elapsedB = Date.now() - startedB;
    assertThat(record, replyDraftB.status === 201, '有证据草稿返回 201');
    assertThat(record, replyDraftB.body.data.degraded === false, '有主数据证据时 degraded=false');
    assertThat(record, replyDraftB.body.data.evidence_refs.length > 0, '有证据草稿 evidence_refs 非空');
    assertThat(record, elapsedB < 5000, `有证据草稿 5s 内返回（实际 ${elapsedB}ms）`);
  });

  await step('09', '发送审批（B 级）→ dry-run 发送 → 重复提交回放', async (record) => {
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { platformConversationId: conversationB } });
    const text = replyDraftB.body.data.text;
    const approval = await api('POST', '/api/approvals', {
      role: 'operator',
      body: {
        subject_type: 'message',
        subject_id: conversation.id,
        action: 'send_reply',
        platform: 'pdd',
        target_payload: { conversation_id: conversation.id, text },
        risk_meta: { impact_scope: {} },
      },
    });
    assertThat(record, approval.status === 201, '发送审批 201');
    const decided = await api('POST', `/api/approvals/${approval.body.data.id}/decide`, {
      role: 'admin',
      body: { decision: 'approve' },
    });
    assertThat(record, decided.status === 200, '发送审批 admin 批准');
    const key = `e2e-out-${randomUUID().slice(0, 8)}`;
    const body = {
      conversation_id: conversation.id,
      platform: 'pdd',
      text,
      draft_id: replyDraftB.body.data.draft_id,
      approval_id: approval.body.data.id,
      outbound_idempotency_key: key,
    };
    const sent = await api('POST', '/api/replies/send', { role: 'operator', body });
    assertThat(record, sent.status === 200, 'dry-run 发送返回 200');
    assertThat(record, sent.body.data.delivery_mode === 'dry_run', 'delivery_mode=dry_run', sent.body.data.delivery_mode);
    assertThat(record, sent.body.data.status !== 'sent', `status != sent（实际 ${sent.body.data.status}）`, sent.body.data.status);
    const replay = await api('POST', '/api/replies/send', { role: 'operator', body });
    assertThat(record, replay.status === 200, '重复发送返回 200');
    assertThat(record, replay.body.data.deduped === true, '重复提交 deduped=true');
    assertThat(record, replay.body.data.message_id === sent.body.data.message_id, '重复提交回放同一 message_id');
    const outbound = await prisma.message.count({ where: { conversationId: conversation.id, direction: 'outbound' } });
    assertThat(record, outbound === 1, `出站消息只 1 条（实际 ${outbound}）`, outbound);
  });

  await step('10', '媒体任务（mock provider）→ 资产/成本/尺码表图', async (record) => {
    const operator = await prisma.user.findFirstOrThrow({ where: { email: OPERATOR_EMAIL } });
    const chart = await prisma.sizeChart.findMany({
      where: { productId, archivedAt: null, status: 'effective' },
      orderBy: { sizeOrder: 'asc' },
    });
    assertThat(record, chart.length > 0, '商品存在 effective 尺码表');
    const chartInput = {
      productName: golden.row.title,
      fit: 'regular',
      versionNo: chart[0].versionNo,
      effectiveFrom: chart[0].effectiveFrom,
      rows: chart.map((row) => ({
        sizeCode: row.skuSizeCode,
        sizeOrder: row.sizeOrder,
        measurements: row.measurements,
      })),
    };
    await mkdir(DOWNLOAD_ROOT, { recursive: true });

    // 10a) DB 路径的尺码表渲染任务：先尝试真实创建；schema CHECK 只允许 image/video，
    //      M6 pipeline 使用 purpose=render。该不一致记录为 expected failure，不阻断其余链。
    const chartJobId = randomUUID();
    let chartJobError = null;
    try {
      await prisma.mediaJob.create({
        data: {
          id: chartJobId,
          orgId: 1n,
          purpose: 'render',
          providerId: e2eProviderId,
          modelId: e2eModelId,
          params: { kind: 'size_chart', size_chart: chartInput },
          status: 'queued',
          idempotencyKey: `e2e-media-chart-${randomUUID()}`,
          subjectType: 'other',
          createdBy: operator.id,
        },
      });
    } catch (error) {
      chartJobError = error;
    }
    if (chartJobError) {
      findings.push({
        id: 'F-E2E-02',
        severity: 'blocker',
        area: 'media_job.purpose ↔ 媒体管线',
        summary: 'schema CHECK ck_media_purpose 只允许 image|video，而 M6 尺码表渲染使用 purpose=render，DB 路径无法创建渲染任务',
        evidence: String(chartJobError.message ?? chartJobError).slice(0, 500),
        depends_on: 't12/t26：迁移放宽 ck_media_purpose（加 render）或管线映射为 image + kind=size_chart',
      });
      expectedFailures.push('媒体 DB 渲染任务：purpose=render 被 ck_media_purpose 拒绝，依赖 t12/t26 修 schema');
      record.assertions.push({ message: '媒体 DB 渲染任务受限（expected failure，已记录 F-E2E-02）', status: 'passed' });
    } else {
      // 若未来迁移放宽 CHECK，本分支正常通过；渲染任务后续由 media worker 推进。
      record.assertions.push({ message: 'purpose=render 可创建（schema 已放宽）', status: 'passed' });
    }

    // 10b) 图片任务走 DB 路径：验证 mock provider 管线、pending_review 资产、cost_ledger。
    const imageJobId = randomUUID();
    await prisma.mediaJob.create({
      data: {
        id: imageJobId,
        orgId: 1n,
        purpose: 'image',
        providerId: e2eProviderId,
        modelId: e2eModelId,
        params: { kind: 'scene', source: 'ai_generated', prompt: 'E2E 场景图', count: 1 },
        status: 'queued',
        idempotencyKey: `e2e-media-image-${randomUUID()}`,
        subjectType: 'other',
        createdBy: operator.id,
      },
    });
    const storage = await FsStorage.create(MEDIA_ROOT);
    const repo = new PrismaMediaRepository(prisma);
    const provider = new MockMediaProvider({ pendingPolls: 0, costCents: 4 });
    const clock = new FakeClock();
    const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });
    let job = await repo.getJob(imageJobId);
    const terminal = new Set(['succeeded', 'failed', 'expired', 'cancelled']);
    for (let index = 0; index < 20 && job && !terminal.has(job.status); index += 1) {
      if (job.pollAfter && job.pollAfter.getTime() > clock.now().getTime()) {
        clock.advance(job.pollAfter.getTime() - clock.now().getTime());
      }
      await pipeline.advance(imageJobId);
      job = await repo.getJob(imageJobId);
    }
    assertThat(record, job?.status === 'succeeded', `图片任务完成（实际 ${job?.status}）`, job?.status);
    const asset = await prisma.mediaAsset.findFirst({ where: { mediaJobId: imageJobId, archivedAt: null } });
    assertThat(record, Boolean(asset), '媒体任务产出 media_asset');
    assertThat(record, asset.status === 'pending_review', `media_asset 状态 pending_review（实际 ${asset.status}）`, asset.status);
    const ledger = await prisma.costLedger.findFirst({ where: { kind: 'media', refType: 'media_job', refId: imageJobId } });
    assertThat(record, Boolean(ledger), 'cost_ledger 有媒体记账');
    assertThat(record, ledger.amountCents === 4, `媒体成本记账 4 分（实际 ${ledger.amountCents}）`, ledger.amountCents);
    const variants = Array.isArray(asset.variants) ? asset.variants : [];
    assertThat(record, variants.length >= 1, '资产有变体');
    const variant = variants[0];
    const buffer = await storage.get(MEDIA_BUCKET, variant.objectKey);
    assertThat(record, buffer.length > 0, '媒体变体可从存储读取');
    const downloadPath = path.join(DOWNLOAD_ROOT, `mock-image-${imageJobId}.webp`);
    await writeFile(downloadPath, buffer);
    record.assertions.push({ message: `媒体变体已落盘：${path.relative(REPO_ROOT, downloadPath)}`, status: 'passed' });

    // 10c) 尺码表图：直接调用渲染器产出 PNG（DB 任务受限，见 F-E2E-02），验证可下载文件。
    const rendered = await renderSizeChart(chartInput);
    assertThat(record, rendered.charts.length >= 2, '尺码表渲染产出 750/1200 两档');
    const chartBuffer = rendered.charts[0].buffer;
    assertThat(record, chartBuffer.length > 0, '尺码表 PNG 字节非空');
    const chartDownload = path.join(DOWNLOAD_ROOT, `size-chart-direct-${randomUUID().slice(0, 8)}.png`);
    await writeFile(chartDownload, chartBuffer);
    record.assertions.push({ message: `尺码表图已落盘：${path.relative(REPO_ROOT, chartDownload)}（直接渲染路径）`, status: 'passed' });

    // 10d) 记录 API 缺口：docs/12 §3.7 的 generate/jobs/assets/download 未实现，仅有 cancel。
    findings.push({
      id: 'F-E2E-03',
      severity: 'high',
      area: 'media API',
      summary: 'docs/12 §3.7 的 POST /media/generate、GET /media/jobs、GET /media/assets、下载端点未实现；当前仅有 /media/jobs/:id/cancel',
      evidence: 'apps/api/src/routes/media.ts 仅注册 cancel 路由；E2E 只能直接调用 worker MediaPipeline',
      depends_on: 'M6 API 补齐（t26 后续）',
    });
    expectedFailures.push('媒体 HTTP API 不完整（仅 cancel），依赖 M6 API 补齐');
  });

  await step('11', '知识库检索命中并带引用', async (record) => {
    const searched = await api('GET', `/api/kb/search?q=${encodeURIComponent('退换货')}&domain=policy&k=5`, { role: 'operator' });
    assertThat(record, searched.status === 200, 'KB 检索 200');
    const hits = searched.body.data.hits ?? [];
    assertThat(record, hits.some((hit) => hit.document_id === kbDocId), '检索命中政策文档', hits.map((hit) => hit.document_id));
    const refs = searched.body.data.evidence_refs ?? [];
    assertThat(record, refs.length > 0, '检索结果带 evidence_refs（引用）');
    assertThat(record, refs.every((ref) => ref.doc_id?.length === 36 && ref.quote?.length > 0), '引用含 doc_id/quote');
  });
}

class FakeClock {
  constructor(start = Date.UTC(2026, 9, 20, 12, 0, 0)) {
    this.time = start;
  }
  now() {
    return new Date(this.time);
  }
  advance(ms) {
    this.time += ms;
  }
}

async function openSse(pathName) {
  const controller = new AbortController();
  const response = await fetch(`${apiBase}${pathName}`, {
    headers: { cookie: auths.admin.cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok) throw new StepFailure(`SSE 连接失败：HTTP ${response.status}`, response.headers.get('x-request-id'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async waitFor(pattern, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const match = buffer.match(pattern);
        if (match) return match;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new StepFailure(`SSE 等待 ${pattern} 超时（已收到 ${buffer.length} 字符）`);
        const result = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
        ]);
        if (result.timeout) throw new StepFailure(`SSE 等待 ${pattern} 超时（已收到 ${buffer.slice(-300)}）`);
        if (result.done) throw new StepFailure(`SSE 连接提前关闭（已收到 ${buffer.slice(-300)}）`);
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}

async function writeReport({ status, error }) {
  await mkdir(path.dirname(REPORT_FILE), { recursive: true });
  const report = {
    run_id: randomUUID(),
    generated_at: new Date().toISOString(),
    status,
    api_base: apiBase,
    database: DB_URL ? maskUrl(DB_URL) : null,
    total_duration_ms: steps.reduce((sum, item) => sum + item.duration_ms, 0),
    steps,
    findings,
    expected_failures: expectedFailures,
    summary: {
      total: steps.length,
      passed: steps.filter((item) => item.status === 'passed').length,
      failed: steps.filter((item) => item.status === 'failed').length,
    },
    ...(error
      ? {
          error: {
            message: error instanceof StepFailure ? error.message : `${error?.message ?? error}`,
            request_id: error?.requestId ?? lastRequestId,
          },
        }
      : {}),
  };
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

let reportWritten = false;
try {
  await main();
  const report = await writeReport({ status: 'passed' });
  reportWritten = true;
  console.log(
    `✔ 全链路通过：${report.summary.passed}/${report.summary.total} 步，总耗时 ${(report.total_duration_ms / 1000).toFixed(1)}s`,
  );
  console.log(`  报告：${path.relative(REPO_ROOT, REPORT_FILE)}`);
  if (findings.length > 0) console.log(`  发现 ${findings.length} 条跨模块缺口（已写入报告与验收记录）`);
  process.exit(0);
} catch (error) {
  const report = await writeReport({ status: 'failed', error });
  reportWritten = true;
  console.error(`✖ 全链路失败：${error instanceof StepFailure ? error.message : error?.stack ?? error}`);
  console.error(`  request_id: ${error?.requestId ?? lastRequestId ?? '(unknown)'}`);
  console.error(`  报告：${path.relative(REPO_ROOT, REPORT_FILE)}`);
  process.exit(1);
} finally {
  if (!reportWritten) {
    // 理论上不会走到；保留兜底，避免丢失失败现场。
  }
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
}
