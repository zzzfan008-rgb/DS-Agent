/**
 * t22 验收测试：知识库（入库/切片/嵌入/混合召回/引用/降级/软删）。
 *
 * 使用真实 Postgres + pgvector + 真实 HTTP（multipart 需要），embedding 走模型网关
 * 的 mock provider（provider.extra.mock=true，确定性 1024 维向量）。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  cookiesFrom,
  createUser,
  csrfFrom,
  login,
  prisma,
  sessionHeaders,
} from './helpers.js';

const ADMIN_PASSWORD = 'KbAdminPassword!2026';
const OPERATOR_PASSWORD = 'KbOperatorPassword!2026';
const VIEWER_PASSWORD = 'KbViewerPassword!2026';
const MODEL_CREDENTIALS = JSON.stringify({ mock_cred: 'sk-mock-test' });

let app: FastifyInstance;
let base: string;
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;
let viewerHeaders: Record<string, string>;
let adminId = '';
let operatorId = '';

const suffix = randomUUID().slice(0, 8);
const refs = {
  policy: `policy://return-${suffix}`,
  product: `product://spu-${suffix}`,
  size: `size://spu-${suffix}`,
  faq: `faq://service-${suffix}`,
  pdf: `policy://pdf-${suffix}`,
  multipart: `service://multipart-${suffix}`,
  versioned: `product://versioned-${suffix}`,
};

const docs: Record<string, string> = {};

function sessionHeadersFor(cookies: Record<string, string>, csrf = '') {
  return { ...sessionHeaders(cookies, csrf), 'content-type': 'application/json' };
}

async function postJson(path: string, payload: unknown, headers = adminHeaders): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function ingest(
  title: string,
  domain: string,
  content: string,
  sourceRef: string,
  extra: Record<string, unknown> = {},
  headers = adminHeaders,
): Promise<{ status: number; body: Record<string, any> }> {
  return postJson(
    '/api/kb/documents',
    {
      title,
      domain,
      file_name: `${title}.md`,
      mime: 'text/markdown',
      content,
      source_ref: sourceRef,
      ...extra,
    },
    headers,
  );
}

async function search(query: string, extra = '', headers = viewerHeaders): Promise<Record<string, any>> {
  const response = await fetch(`${base}/api/kb/search?q=${encodeURIComponent(query)}${extra}`, {
    headers,
  });
  const body = (await response.json()) as Record<string, any>;
  return { status: response.status, ...body };
}

function makePdf(text: string): Buffer {
  const safe = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET\n`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream\nendobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${object}\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function ensureEmbeddingRoute(): Promise<void> {
  const existing = await prisma.modelRoute.findFirst({
    where: { purpose: 'embed', status: 'active', scopeType: 'org' },
    select: { id: true },
  });
  if (existing) return;

  const name = `kb_embed_${suffix}`;
  const provider = await postJson('/api/providers', {
    kind: 'embedding',
    name,
    base_url: `https://${name}.mock.local`,
    credential_ref: 'mock_cred',
    vendor: 'other',
    extra: { mock: true },
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.body));
  await postJson(`/api/providers/${provider.body.data.id}/test`, {});
  const model = await postJson('/api/models', {
    name: `emb.kb.${suffix}`,
    provider_id: provider.body.data.id,
    external_model_id: 'ext-emb-kb',
    display_name: '知识库测试嵌入',
    capability: 'embedding',
    purpose_support: ['embed'],
    params_schema: {
      type: 'object',
      properties: { inputs: { type: 'array', items: { type: 'string' } } },
    },
    default_params: { inputs: ['维度测试'], input: '维度测试' },
    price: { embed: { per_1k_tokens_cents: 1 } },
    embed_dim: 1024,
  });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  await postJson(`/api/models/${model.body.data.id}/test`, {});
  const publish = await postJson(`/api/models/${model.body.data.id}/publish`, {});
  assert.equal(publish.status, 200, JSON.stringify(publish.body));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const route = await postJson('/api/routes', {
      scope_type: 'org',
      purpose: 'embed',
      model_id: model.body.data.id,
      priority: 100 + Math.floor(Math.random() * 800),
      status: 'active',
      label: `kb-test-${suffix}`,
    });
    if (route.status === 201) return;
    if (route.status === 409) continue;
    assert.fail(`embed 路由创建失败：${JSON.stringify(route.body)}`);
  }
  throw new Error('embed 路由创建连续冲突');
}

before(async () => {
  app = await buildTestApp({ DSSAAS_MODEL_CREDENTIALS: MODEL_CREDENTIALS });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${address.port}`;

  const admin = await createUser({ email: `kb.admin.${suffix}@test.local`, password: ADMIN_PASSWORD, role: 'admin' });
  const operator = await createUser({ email: `kb.operator.${suffix}@test.local`, password: OPERATOR_PASSWORD, role: 'operator' });
  const viewer = await createUser({ email: `kb.viewer.${suffix}@test.local`, password: VIEWER_PASSWORD, role: 'viewer' });
  adminId = admin.id;
  operatorId = operator.id;
  const adminLogin = await login(app, admin.email, ADMIN_PASSWORD);
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  const viewerLogin = await login(app, viewer.email, VIEWER_PASSWORD);
  adminHeaders = sessionHeadersFor(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  operatorHeaders = sessionHeadersFor(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));
  viewerHeaders = sessionHeadersFor(cookiesFrom(viewerLogin), csrfFrom(viewerLogin));

  await ensureEmbeddingRoute();
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 入库 / 切片 / 元数据
// ---------------------------------------------------------------------------

test('入库 md：切片、section_path、metadata、content_hash、embedding 写入', async () => {
  docs.policy = [
    '# 退换货政策',
    '',
    '## 七天无理由',
    '',
    '自签收次日起 7 天内，商品完好可申请退货退款。吊牌、包装必须完整。',
    '',
    '## 质量问题',
    '',
    '出现破损、色差、起球等质量问题，拍照留证后可退换，运费由卖家承担。',
    '',
    '## 尺码不合适',
    '',
    '可按尺码表复测后换码，换码运费由买家承担。',
  ].join('\n');
  const result = await ingest('退换货政策', 'policy', docs.policy, refs.policy);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const data = result.body.data as Record<string, any>;
  assert.equal(data.deduplicated, false);
  assert.equal(data.version, 1);
  assert.ok(data.chunks >= 3);
  assert.equal(data.index_status, 'indexed');
  assert.equal(data.embedded, true);

  const chunks = await prisma.kbChunk.findMany({
    where: { documentId: data.document_id },
    orderBy: { seq: 'asc' },
  });
  assert.equal(chunks.length, data.chunks);
  assert.ok(chunks.some((chunk) => chunk.sectionPath.includes('质量问题')));
  assert.ok(chunks.every((chunk) => chunk.contentHash.length === 64));
  assert.ok(chunks.every((chunk) => chunk.contentTokens > 0));
  assert.ok(chunks.every((chunk) => chunk.embeddingDim === 1024));
  assert.ok(chunks.every((chunk) => [...chunk.content].length <= 800));
  assert.ok(chunks.every((chunk) => [...chunk.content].length >= 1));
  const meta = chunks[0]!.metadata as Record<string, unknown>;
  assert.equal(meta.source_type, 'policy');
  assert.equal(meta.domain, 'policy');
  assert.equal(meta.source_ref, refs.policy);
  assert.equal(meta.advisory, false);
  assert.ok(Array.isArray(chunks[0]!.sectionPath));

  const docRow = await prisma.kbDocument.findUniqueOrThrow({ where: { id: data.document_id } });
  assert.equal(docRow.status, 'active');
  assert.equal(docRow.indexStatus, 'indexed');
  assert.equal(docRow.chunkCount, data.chunks);
  assert.equal(docRow.checksum.length, 64);
  assert.equal(docRow.uri, refs.policy);
});

test('入库 txt / pdf（文本层）：pdf 纯文本抽取可用', async () => {
  const txt = await ingest('FAQ 文本', 'service', 'Q: 发货时间是多久？\nA: 48 小时内发货，节假日顺延。', refs.faq, {
    file_name: 'faq.txt',
    mime: 'text/plain',
  });
  assert.equal(txt.status, 201, JSON.stringify(txt.body));

  const pdfBuffer = makePdf('Return policy: 7 days no reason. Keep the tag and package.');
  const pdf = await postJson('/api/kb/documents', {
    title: 'PDF 政策',
    domain: 'policy',
    file_name: 'policy.pdf',
    mime: 'application/pdf',
    content_base64: pdfBuffer.toString('base64'),
    source_ref: refs.pdf,
  });
  assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
  const chunks = await prisma.kbChunk.findMany({ where: { documentId: pdf.body.data.document_id } });
  const joined = chunks.map((chunk) => chunk.content).join('\n');
  assert.match(joined, /Return policy: 7 days no reason/);
});

test('入库 multipart：md 文件上传与 JSON 等价', async () => {
  const form = new FormData();
  form.append('title', 'FAQ multipart');
  form.append('domain', 'service');
  form.append('source_ref', refs.multipart);
  form.append('file', new Blob([docs.multipart ?? '# FAQ\n\nQ: 可以开发票吗？\nA: 可以，下单备注抬头。'], { type: 'text/markdown' }), 'faq.md');
  const response = await fetch(`${base}/api/kb/documents`, {
    method: 'POST',
    headers: {
      cookie: adminHeaders.cookie ?? '',
      'x-csrf-token': adminHeaders['x-csrf-token'] ?? '',
      'idempotency-key': randomUUID(),
    },
    body: form,
  });
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(body.data.chunks >= 1);
});

test('幂等：同 source_ref + content_hash 重复上传返回既有 id，不重复切片', async () => {
  const beforeCount = await prisma.kbDocument.count({ where: { uri: refs.policy, archivedAt: null } });
  const again = await ingest('退换货政策', 'policy', docs.policy!, refs.policy);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.data.deduplicated, true);
  assert.equal(again.body.data.version, 1);
  const afterCount = await prisma.kbDocument.count({ where: { uri: refs.policy, archivedAt: null } });
  assert.equal(afterCount, beforeCount);
});

test('版本：同 source_ref 内容变化 → version_no+1，旧版本 superseded', async () => {
  const first = await ingest(
    '风衣商品资料',
    'product',
    '# 风衣商品资料\n\n## 版型\n\n2026 秋季女士中长款风衣，收腰显瘦，适合通勤。',
    refs.versioned,
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const v1 = first.body.data.document_id as string;
  const second = await ingest(
    '风衣商品资料',
    'product',
    '# 风衣商品资料\n\n## 版型\n\n2026 秋季女士中长款风衣，收腰显瘦，适合通勤。\n\n## 面料\n\n聚酯纤维 95%，氨纶 5%，防风防泼水。',
    refs.versioned,
  );
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.data.version, 2);
  const oldDoc = await prisma.kbDocument.findUniqueOrThrow({ where: { id: v1 } });
  assert.equal(oldDoc.status, 'superseded');
  const oldChunks = await prisma.kbChunk.findMany({ where: { documentId: v1 } });
  assert.ok(oldChunks.every((chunk) => chunk.status === 'superseded'));
  const hits = await search('风衣 面料', '&k=5&domain=product');
  const hitChunkIds = new Set((hits.data.hits as Array<{ chunk_id: string }>).map((hit) => hit.chunk_id));
  assert.equal(oldChunks.some((chunk) => hitChunkIds.has(chunk.id)), false, '旧版本 chunk 仍在召回');
});

// ---------------------------------------------------------------------------
// 召回 / 引用 / 过滤 / 降级
// ---------------------------------------------------------------------------

test('同义改写召回 3 组：外套→风衣、退换→退货、尺寸→尺码；每条命中带引用', async () => {
  const productDoc = await ingest(
    '风衣商品资料',
    'product',
    '# 风衣商品资料\n\n## 版型\n\n2026 秋季女士中长款风衣，收腰显瘦，适合通勤。\n\n## 面料\n\n聚酯纤维 95%，氨纶 5%，防风防泼水，克重 320g。\n\n## 搭配\n\n适合搭配针织衫与短靴，小个子可选短款。',
    refs.product,
  );
  assert.equal(productDoc.status, 201, JSON.stringify(productDoc.body));
  const sizeDoc = await ingest(
    '尺码表',
    'size',
    '# 尺码表\n\n## 2XL\n\n尺码 2XL：衣长 68cm，胸围 104cm，肩宽 46cm，袖长 61cm。建议身高 165–172cm，体重 65–72kg。\n\n## XL\n\n尺码 XL：衣长 66cm，胸围 100cm，肩宽 45cm，袖长 60cm。建议身高 160–168cm，体重 58–65kg。',
    refs.size,
  );
  assert.equal(sizeDoc.status, 201, JSON.stringify(sizeDoc.body));
  assert.equal(productDoc.body.data.embedded, true);

  const cases: Array<{ query: string; expectedDoc: string; label: string }> = [
    { query: '外套', expectedDoc: productDoc.body.data.document_id, label: '外套→风衣' },
    { query: '退换', expectedDoc: docs.policy ? (await prisma.kbDocument.findFirstOrThrow({ where: { uri: refs.policy, status: 'active' } })).id : '', label: '退换→退货' },
    { query: '尺寸', expectedDoc: sizeDoc.body.data.document_id, label: '尺寸→尺码' },
  ];

  for (const item of cases) {
    const result = await search(item.query, '&k=5');
    assert.equal(result.status, 200);
    assert.equal(result.data.degraded, false, `${item.label} degraded`);
    const hits = result.data.hits as Array<Record<string, any>>;
    const position = hits.findIndex((hit) => hit.document_id === item.expectedDoc);
    console.log(`[recall] ${item.label} query=${item.query} position=${position + 1} top=${hits[0]?.title}`);
    assert.ok(position >= 0, `${item.label} 未召回期望文档；hits=${hits.map((hit) => hit.title).join(',')}`);
    assert.ok(position < 5);

    for (const hit of hits) {
      assert.ok(hit.citation, 'hit 缺少 citation');
      assert.equal(hit.citation.doc_id, hit.document_id);
      assert.equal(hit.citation.chunk_id, hit.chunk_id);
      assert.equal(hit.citation.doc_version, hit.version);
      assert.equal(typeof hit.citation.quote, 'string');
      assert.ok(hit.citation.quote.length >= 4);
      assert.ok(hit.content.includes(hit.citation.quote), 'quote 必须是 content 的连续子串');
      assert.ok(hit.citation.effective_from);
      assert.ok(hit.citation.title);
      assert.ok(hit.citation.source_type);
    }
    const evidence = result.data.evidence_refs as Array<Record<string, any>>;
    assert.equal(evidence.length, hits.filter((hit) => !hit.advisory).length);
    assert.ok(evidence.every((ref) => ref.doc_id && ref.chunk_id && ref.quote && ref.doc_version));
  }
});

test('过滤：domain=policy 只返回 policy；k 上限生效', async () => {
  const result = await search('退货 尺码 风衣', '&k=3&domain=policy');
  assert.equal(result.status, 200);
  const hits = result.data.hits as Array<Record<string, any>>;
  assert.ok(hits.length <= 3);
  assert.ok(hits.every((hit) => hit.domain === 'policy'));
});

test('resolveEvidence：供 L2 使用，排除 advisory、引用完整', async () => {
  const result = await app.knowledge.resolveEvidence('退换货政策 质量问题', { role: 'operator', k: 5 });
  assert.ok(result.evidence_refs.length > 0);
  assert.ok(result.evidence_refs.length <= 8);
  for (const ref of result.evidence_refs) {
    assert.ok(ref.doc_id);
    assert.ok(ref.chunk_id);
    assert.ok(ref.quote.length > 0);
    assert.ok(ref.doc_version >= 1);
    assert.ok(ref.effective_from);
  }
  assert.ok(result.hits.every((hit) => !hit.advisory));
});

test('降级：embedding 路由不可用 → embed_unavailable；向量列空 → no_vector，纯关键词仍可命中', async () => {
  const paused = await prisma.modelRoute.updateMany({
    where: { purpose: 'embed', status: 'active' },
    data: { status: 'paused' },
  });
  assert.ok(paused.count >= 1);
  const unavailable = await search('尺码', '&k=3');
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.data.degraded, true);
  assert.equal(unavailable.data.mode, 'keyword');
  assert.equal(unavailable.data.degrade_reason, 'embed_unavailable');
  assert.ok((unavailable.data.hits as unknown[]).length > 0);

  await prisma.modelRoute.updateMany({ where: { purpose: 'embed' }, data: { status: 'active' } });
  await prisma.$executeRawUnsafe('UPDATE kb_chunk SET embedding = NULL, embedding_dim = NULL WHERE embedding IS NOT NULL');
  const noVector = await search('风衣', '&k=3');
  assert.equal(noVector.status, 200);
  assert.equal(noVector.data.degraded, true);
  assert.equal(noVector.data.mode, 'keyword');
  assert.equal(noVector.data.degrade_reason, 'no_vector');
  assert.ok((noVector.data.hits as Array<Record<string, any>>).some((hit) => hit.title === '风衣商品资料'));
  const degradedLog = await prisma.kbQueryLog.findFirst({
    where: { degraded: true, degradeReason: 'no_vector' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(degradedLog, '降级检索未写 kb_query_log');
});

test('软删：DELETE 后不再命中、列表隐藏、chunks disabled', async () => {
  const target = await prisma.kbDocument.findFirstOrThrow({ where: { uri: refs.policy, status: 'active' } });
  const response = await fetch(`${base}/api/kb/documents/${target.id}`, {
    method: 'DELETE',
    headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ reason: 't22 验收：软删验证' }),
  });
  const body = (await response.json()) as Record<string, any>;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, 'archived');

  const after = await search('退货退款', '&k=5');
  const hits = after.data.hits as Array<Record<string, any>>;
  assert.equal(hits.some((hit) => hit.document_id === target.id), false, '软删后仍命中');
  const list = await fetch(`${base}/api/kb/documents?limit=100`, { headers: viewerHeaders });
  const listBody = (await list.json()) as Record<string, any>;
  assert.equal((listBody.data.items as Array<{ id: string }>).some((item) => item.id === target.id), false);
  const chunks = await prisma.kbChunk.findMany({ where: { documentId: target.id } });
  assert.ok(chunks.every((chunk) => chunk.status === 'disabled'));
  assert.ok(chunks.every((chunk) => chunk.archivedAt !== null));
});

test('鉴权/校验：viewer 可搜、operator 可上传、非 admin 不能删、非法域/类型 422/415', async () => {
  const viewerSearch = await search('尺码', '&k=2');
  assert.equal(viewerSearch.status, 200);

  const operatorUpload = await ingest(
    '客服 FAQ',
    'service',
    'Q: 发什么快递？\nA: 默认中通/圆通，偏远地区另议。',
    `service://operator-${suffix}`,
    {},
    operatorHeaders,
  );
  assert.equal(operatorUpload.status, 201, JSON.stringify(operatorUpload.body));

  const target = await prisma.kbDocument.findFirstOrThrow({ where: { uri: `service://operator-${suffix}` } });
  const forbiddenDelete = await fetch(`${base}/api/kb/documents/${target.id}`, {
    method: 'DELETE',
    headers: { ...operatorHeaders, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ reason: 'operator 不应删除' }),
  });
  assert.equal(forbiddenDelete.status, 403);

  const badDomain = await ingest('非法域', 'unknown', 'x'.repeat(100), `bad://${suffix}`);
  assert.equal(badDomain.status, 422);

  const badType = await postJson('/api/kb/documents', {
    title: 'docx 不支持',
    domain: 'policy',
    file_name: 'a.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content_base64: Buffer.from('not a docx').toString('base64'),
    source_ref: `docx://${suffix}`,
  });
  assert.equal(badType.status, 415);

  assert.ok(adminId.length > 0 && operatorId.length > 0);
});
