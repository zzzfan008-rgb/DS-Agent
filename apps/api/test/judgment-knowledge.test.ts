/** t40：判断层接入知识库软证据，L2 不再必然 escalate。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, cookiesFrom, createUser, csrfFrom, login, prisma, sessionHeaders } from './helpers.js';
import { buildProductFacts } from '../src/services/facts.js';
import { createJudgment, type L2Runner } from '../src/services/judgments.js';
import { tsvectorInput } from '../src/knowledge/tokenize.js';

const ADMIN_PASSWORD = 'TestAdminPassword!2026';
const OPERATOR_PASSWORD = 'TestOperatorPassword!2026';
const SUFFIX = randomUUID().slice(0, 8).toUpperCase();

let app: FastifyInstance;
let operator: { id: string; email: string };
let operatorHeaders: Record<string, string>;
let productId = '';
let facts: Awaited<ReturnType<typeof buildProductFacts>>;
let policyDocId = '';
let policyChunkId = '';

const POLICY_CONTENT = '退换货政策：自签收之日起 7 天内支持无理由退货。';

async function post(path: string, payload: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `t40-${randomUUID()}` },
    payload: payload as Record<string, unknown>,
  });
}

async function createDraft(body: string) {
  return prisma.contentDraft.create({
    data: {
      orgId: 1n,
      productId,
      platform: 'pdd',
      contentType: 'title',
      body,
      structured: {},
      facts: facts as never,
      factCheck: {},
      status: 'generated',
      createdBy: operator.id,
    },
  });
}

function citation() {
  return {
    doc_id: policyDocId,
    chunk_id: policyChunkId,
    doc_version: 1,
    quote: '7 天内支持无理由退货',
    source: 'kb' as const,
  };
}

function runnerFor(verdict: 'pass' | 'needs_revision'): L2Runner {
  return async ({ prompt }) => {
    const conflicting = prompt.includes('30 天');
    const actualVerdict = conflicting ? 'needs_revision' : verdict;
    return {
      raw: JSON.stringify({
        verdict: actualVerdict,
        severity: actualVerdict === 'pass' ? 'low' : 'high',
        reason: actualVerdict === 'pass' ? '文案承诺与退换政策一致' : '政策仅支持 7 天，文案承诺 30 天无理由，超出政策边界',
        repair_hint: actualVerdict === 'pass' ? '无需修改' : '改为 7 天无理由退货，或删除超期承诺',
        evidence_refs: [citation()],
        confidence: 0.92,
      }),
      modelCallId: null,
      costCents: 1,
      latencyMs: 5,
    };
  };
}

before(async () => {
  app = await buildTestApp({
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }),
    LOG_LEVEL: 'error',
  });
  await createUser({ email: `admin.t40.${SUFFIX}@test.local`, password: ADMIN_PASSWORD, role: 'admin' });
  operator = await createUser({
    email: `operator.t40.${SUFFIX}@test.local`,
    password: OPERATOR_PASSWORD,
    role: 'operator',
  });
  const operatorLogin = await login(app, operator.email, OPERATOR_PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));

  const created = await post('/api/products', {
    spu_code: `T40-${SUFFIX}`,
    name: 'T40 纯棉上衣',
    category_code: 'A0101',
    fit: 'regular',
    skus: [
      { color_id: 'bk0101', color_name: '黑色', size_code: 'M', price_cents: 12900, stock_qty: 10 },
    ],
    fabric: { materials: [{ material: '棉', percent: 100 }] },
    size_chart: {
      effective_from: '2026-01-01',
      items: [{ sku_size_code: 'M', measurements: { 胸围: 104, 衣长: 69 } }],
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  productId = (created.json() as { data: { id: string } }).data.id;
  facts = await buildProductFacts(prisma, productId);
});

after(async () => {
  if (policyDocId) {
    await prisma.kbChunk.deleteMany({ where: { documentId: policyDocId } });
    await prisma.kbDocument.deleteMany({ where: { id: policyDocId } });
  }
  await app.close();
  await prisma.$disconnect();
});

test('无 KB 政策时 L2 不调用、escalate；有政策时 7 天 pass、30 天 needs_revision 并逐字引用', async () => {
  let calls = 0;
  const deps = {
    prisma,
    audit: app.audit,
    knowledge: app.knowledge,
    now: () => new Date('2026-10-20T08:00:00.000Z'),
    l2Runner: (async () => {
      calls += 1;
      return runnerFor('pass')({ prompt: '', requestId: '', context: {} as never, attempt: 1 });
    }) as L2Runner,
  };
  const noPolicyDraft = await createDraft('支持 7 天无理由退货');
  const noPolicy = await createJudgment(
    deps,
    {
      subject_type: 'content_draft',
      subject_id: noPolicyDraft.id,
      platform: 'pdd',
      content_type: 'title',
    },
    {
      requestId: `req-${randomUUID()}`,
      userId: operator.id,
      role: 'operator',
      ip: null,
      userAgent: 't40-test',
    },
  );
  assert.equal(noPolicy.verdict, 'escalate');
  assert.equal(noPolicy.short_circuit, 'NO_EVIDENCE');
  assert.equal(calls, 0);

  // 入库政策文档（直接写 kb_document + 切片段，模拟 t22 已解析/索引结果）
  const doc = await prisma.kbDocument.create({
    data: {
      orgId: 1n,
      sourceType: 'policy',
      title: '退换货政策',
      docType: 'policy',
      domain: 'policy',
      status: 'active',
      checksum: 'd'.repeat(64),
      effectiveFrom: new Date('2026-10-01T00:00:00.000Z'),
      indexStatus: 'indexed',
      chunkCount: 1,
      createdBy: operator.id,
    },
  });
  policyDocId = doc.id;
  policyChunkId = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO kb_chunk
      (id, org_id, document_id, version_no, seq, section_path, chunk_type, content,
       content_hash, content_tokens, tsv, metadata, acl_roles, effective_from, status)
    VALUES
      (${policyChunkId}::uuid, 1, ${doc.id}::uuid, 1, 1, '{}'::text[], 'text', ${POLICY_CONTENT},
       ${'e'.repeat(64)}, 0, to_tsvector('simple', ${tsvectorInput(POLICY_CONTENT)}), '{}'::jsonb,
       ARRAY['viewer','operator','admin'], ${new Date('2026-10-01T00:00:00.000Z')}, 'active')`;

  const probe = await app.knowledge.resolveEvidence('7 天无理由退货 退换政策', {
    role: 'operator',
    domains: ['policy'],
  });
  assert.ok(probe.evidence_refs.length > 0, JSON.stringify(probe));

  const context = {
    requestId: `req-${randomUUID()}`,
    userId: operator.id,
    role: 'operator' as const,
    ip: null,
    userAgent: 't40-test',
  };
  const sevenDraft = await createDraft('支持 7 天无理由退货');
  const seven = await createJudgment(
    { ...deps, l2Runner: runnerFor('pass') },
    {
      subject_type: 'content_draft',
      subject_id: sevenDraft.id,
      platform: 'pdd',
      content_type: 'title',
    },
    context,
  );
  assert.equal(seven.verdict, 'pass', JSON.stringify(seven));
  assert.ok(seven.evidence_refs.some((ref) => ref.chunk_id === policyChunkId && ref.source === 'kb'));

  const thirtyDraft = await createDraft('支持 30 天无理由退货');
  const thirty = await createJudgment(
    { ...deps, l2Runner: runnerFor('needs_revision') },
    {
      subject_type: 'content_draft',
      subject_id: thirtyDraft.id,
      platform: 'pdd',
      content_type: 'title',
    },
    context,
  );
  assert.equal(thirty.verdict, 'needs_revision', JSON.stringify(thirty));
  assert.ok(thirty.reason?.includes('30 天') || thirty.reason?.includes('7 天'));
  assert.ok(thirty.evidence_refs.some((ref) => ref.chunk_id === policyChunkId));
});
