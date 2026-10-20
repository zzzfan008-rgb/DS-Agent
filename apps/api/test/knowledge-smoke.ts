/**
 * M7 知识库验收冒烟（真实 Postgres + pgvector + 模型网关 mock embedding）。
 *
 * 输出结构化 JSON：入库结果、三组近义查询的命中位置与引用、降级、软删。
 * 运行：
 *   DATABASE_URL=… pnpm --filter @dssaas/api exec tsx test/knowledge-smoke.ts
 */
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

const suffix = randomUUID().slice(0, 8);
const PASSWORD = 'KbSmokePassword!2026';

async function main(): Promise<void> {
  const app: FastifyInstance = await buildTestApp({
    DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock-test' }),
  });
  const admin = await createUser({ email: `kb.smoke.admin.${suffix}@test.local`, password: PASSWORD, role: 'admin' });
  const operator = await createUser({ email: `kb.smoke.op.${suffix}@test.local`, password: PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, PASSWORD);
  const operatorLogin = await login(app, operator.email, PASSWORD);
  const adminHeaders = {
    ...sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin)),
    'content-type': 'application/json',
  };
  const operatorHeaders = {
    ...sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin)),
    'content-type': 'application/json',
  };

  const post = async (path: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: payload as Record<string, unknown>,
    });

  // 1) 确保存在 mock embedding 路由（与 knowledge.test.ts 同构）。
  let route = await prisma.modelRoute.findFirst({ where: { purpose: 'embed', status: 'active', scopeType: 'org' } });
  if (!route) {
    const providerName = `kb_smoke_embed_${suffix}`;
    const providerResponse = await post('/api/providers', {
      kind: 'embedding',
      name: providerName,
      base_url: `https://${providerName}.mock.local`,
      credential_ref: 'mock_cred',
      vendor: 'other',
      extra: { mock: true },
    }, adminHeaders);
    const provider = (providerResponse.json() as { data: { id: string } }).data;
    await post(`/api/providers/${provider.id}/test`, {}, adminHeaders);
    const modelResponse = await post('/api/models', {
      name: `emb.kb.smoke.${suffix}`,
      provider_id: provider.id,
      external_model_id: 'ext-emb-smoke',
      display_name: '知识库冒烟嵌入',
      capability: 'embedding',
      purpose_support: ['embed'],
      params_schema: { type: 'object', properties: { inputs: { type: 'array' } } },
      default_params: { inputs: ['维度测试'], input: '维度测试' },
      price: { embed: { per_1k_tokens_cents: 1 } },
      embed_dim: 1024,
    }, adminHeaders);
    const model = (modelResponse.json() as { data: { id: string } }).data;
    await post(`/api/models/${model.id}/test`, {}, adminHeaders);
    await post(`/api/models/${model.id}/publish`, {}, adminHeaders);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const created = await post('/api/routes', {
        scope_type: 'org',
        purpose: 'embed',
        model_id: model.id,
        priority: 100 + Math.floor(Math.random() * 800),
        status: 'active',
        label: `kb-smoke-${suffix}`,
      }, adminHeaders);
      if (created.statusCode === 201 || created.statusCode === 409) break;
    }
    route = await prisma.modelRoute.findFirst({ where: { purpose: 'embed', status: 'active', scopeType: 'org' } });
  }

  const ingest = async (title: string, domain: string, sourceRef: string, content: string) => {
    const response = await post('/api/kb/documents', {
      title,
      domain,
      file_name: `${title}.md`,
      mime: 'text/markdown',
      content,
      source_ref: sourceRef,
    }, operatorHeaders);
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };

  const policy = await ingest('退换货政策', 'policy', `policy://smoke-${suffix}`, [
    '# 退换货政策',
    '',
    '## 七天无理由',
    '',
    '自签收次日起 7 天内，商品完好可申请退货退款。吊牌、包装必须完整。',
    '',
    '## 质量问题',
    '',
    '出现破损、色差、起球等质量问题，拍照留证后可退换，运费由卖家承担。',
  ].join('\n'));
  const product = await ingest('风衣商品资料', 'product', `product://smoke-${suffix}`, [
    '# 风衣商品资料',
    '',
    '## 版型',
    '',
    '2026 秋季女士中长款风衣，收腰显瘦，适合通勤。',
    '',
    '## 面料',
    '',
    '聚酯纤维 95%，氨纶 5%，防风防泼水，克重 320g。',
  ].join('\n'));
  const size = await ingest('尺码表', 'size', `size://smoke-${suffix}`, [
    '# 尺码表',
    '',
    '## 2XL',
    '',
    '尺码 2XL：衣长 68cm，胸围 104cm，肩宽 46cm，袖长 61cm。建议身高 165–172cm。',
    '',
    '## XL',
    '',
    '尺码 XL：衣长 66cm，胸围 100cm，肩宽 45cm，袖长 60cm。建议身高 160–168cm。',
  ].join('\n'));

  const search = async (q: string, extra = '') => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/kb/search?q=${encodeURIComponent(q)}&k=5${extra}`,
      headers: sessionHeaders(cookiesFrom(adminLogin)),
    });
    return response.json() as Record<string, any>;
  };

  const cases = [
    { query: '外套', expected: product.body.data.document_id as string, label: '外套→风衣' },
    { query: '退换', expected: policy.body.data.document_id as string, label: '退换→退货' },
    { query: '尺寸', expected: size.body.data.document_id as string, label: '尺寸→尺码' },
  ];
  const searches: Array<Record<string, any>> = [];
  for (const item of cases) {
    const result = await search(item.query);
    const hits = result.data.hits as Array<Record<string, any>>;
    const position = hits.findIndex((hit) => hit.document_id === item.expected) + 1;
    searches.push({
      label: item.label,
      query: item.query,
      expected_position: position,
      degraded: result.data.degraded,
      mode: result.data.mode,
      took_ms: result.data.took_ms,
      top3: hits.slice(0, 3).map((hit) => ({
        title: hit.title,
        score: hit.score,
        vector_rank: hit.vector_rank,
        keyword_rank: hit.keyword_rank,
        citation: hit.citation,
      })),
    });
  }

  // 降级：暂停所有 embed 路由 → 纯关键词 + degraded:true。
  await prisma.modelRoute.updateMany({ where: { purpose: 'embed', status: 'active' }, data: { status: 'paused' } });
  const degraded = await search('尺码');
  await prisma.modelRoute.updateMany({ where: { purpose: 'embed', status: 'paused' }, data: { status: 'active' } });

  // 软删：删除 policy 文档后不再命中。
  const beforeDelete = await search('退货退款');
  const deleteResponse = await app.inject({
    method: 'DELETE',
    url: `/api/kb/documents/${String(policy.body.data.document_id)}`,
    headers: { ...adminHeaders, 'idempotency-key': randomUUID() },
    payload: { reason: 'M7 冒烟软删' },
  });
  const afterDelete = await search('退货退款');
  const afterDeleteHits = afterDelete.data.hits as Array<Record<string, any>>;

  const output = {
    model_route: route ? { id: route.id, model_id: route.modelId, priority: route.priority } : null,
    documents: {
      policy: { status: policy.status, body: policy.body.data },
      product: { status: product.status, body: product.body.data },
      size: { status: size.status, body: size.body.data },
    },
    searches,
    degrade: {
      degraded: degraded.data.degraded,
      mode: degraded.data.mode,
      reason: degraded.data.degrade_reason,
      hit_count: (degraded.data.hits as unknown[]).length,
    },
    soft_delete: {
      delete_status: deleteResponse.statusCode,
      delete_body: deleteResponse.json(),
      before_hits: (beforeDelete.data.hits as unknown[]).length,
      after_hits: afterDeleteHits.length,
      policy_still_hit: afterDeleteHits.some((hit) => hit.document_id === policy.body.data.document_id),
    },
  };
  console.log(JSON.stringify(output, null, 2));
  await app.close();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exitCode = 1;
});
