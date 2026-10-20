import { randomUUID } from 'node:crypto';
import { buildTestApp, cookiesFrom, createUser, csrfFrom, login, prisma, sessionHeaders } from './helpers.js';

const suffix = randomUUID().slice(0, 8);
const app = await buildTestApp({ DSSAAS_MODEL_CREDENTIALS: JSON.stringify({ mock_cred: 'sk-mock' }) });
await app.listen({ host: '127.0.0.1', port: 0 });
const addr = app.server.address() as any;
const base = `http://127.0.0.1:${addr.port}`;
const admin = await createUser({ email: `kb.admin.${suffix}@test.local`, password: 'KbAdminPassword!2026', role: 'admin' });
const operator = await createUser({ email: `kb.op.${suffix}@test.local`, password: 'KbOperatorPassword!2026', role: 'operator' });
const loginRes = await login(app, admin.email, 'KbAdminPassword!2026');
const cookies = cookiesFrom(loginRes); const csrf = csrfFrom(loginRes);
const H = { ...sessionHeaders(cookies, csrf), 'content-type': 'application/json' };
const post = async (path: string, payload: unknown) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { ...H, 'idempotency-key': randomUUID() }, body: JSON.stringify(payload) });
  const j = await r.json(); console.log('POST', path, r.status, JSON.stringify(j).slice(0, 300)); return { status: r.status, body: j as any };
};
const provider = await post('/api/providers', { kind: 'embedding', name: `kb_embed_${suffix}`, base_url: 'https://kb-embed.mock.local', credential_ref: 'mock_cred', vendor: 'other', extra: { mock: true } });
await post(`/api/providers/${provider.body.data.id}/test`, {});
const model = await post('/api/models', { name: `emb.kb.${suffix}`, provider_id: provider.body.data.id, external_model_id: 'ext-emb-kb', display_name: 'KB 测试嵌入', capability: 'embedding', purpose_support: ['embed'], params_schema: { type: 'object', properties: { inputs: { type: 'array' } } }, default_params: {}, price: { embed: { per_1k_tokens_cents: 1 } }, embed_dim: 1024 });
await post(`/api/models/${model.body.data.id}/test`, {});
await post(`/api/models/${model.body.data.id}/publish`, {});
await post('/api/routes', { scope_type: 'org', purpose: 'embed', model_id: model.body.data.id, priority: 1, status: 'active', label: 'kb-test' });

const ingest = async (title: string, domain: string, content: string, sourceRef: string) => {
  const r = await fetch(`${base}/api/kb/documents`, { method: 'POST', headers: { ...H, 'idempotency-key': randomUUID() }, body: JSON.stringify({ title, domain, file_name: `${title}.md`, mime: 'text/markdown', content, source_ref: sourceRef }) });
  const j = await r.json(); console.log('INGEST', r.status, JSON.stringify(j).slice(0, 500)); return { status: r.status, body: j as any };
};
const policy = await ingest('退换货政策', 'policy', '# 退换货政策\n\n## 七天无理由\n\n自签收次日起 7 天内，商品完好可申请退货退款。吊牌必须完整。\n\n## 质量问题\n\n出现破损、色差、起球等质量问题，拍照留证后可退换，运费由卖家承担。\n\n## 尺码不合适\n\n可按尺码表复测后换码，换码运费由买家承担。', 'policy://return-2026');
const product = await ingest('风衣商品资料', 'product', '# 风衣商品资料\n\n## 版型\n\n2026 秋季女士中长款风衣，收腰显瘦，适合通勤。\n\n## 面料\n\n聚酯纤维 95%，氨纶 5%，防风防泼水，克重 320g。\n\n## 搭配\n\n适合搭配针织衫与短靴，小个子可选短款。', 'product://spu-2026-001');
const size = await ingest('尺码表', 'size', '# 尺码表\n\n## 2XL\n\n尺码 2XL：衣长 68cm，胸围 104cm，肩宽 46cm，袖长 61cm。建议身高 165–172cm，体重 65–72kg。\n\n## XL\n\n尺码 XL：衣长 66cm，胸围 100cm，肩宽 45cm，袖长 60cm。建议身高 160–168cm，体重 58–65kg。', 'size://spu-2026-001');

const search = async (q: string, extra = '') => {
  const r = await fetch(`${base}/api/kb/search?q=${encodeURIComponent(q)}&k=5${extra}`, { headers: sessionHeaders(cookies) });
  const j = await r.json(); console.log('SEARCH', q, r.status, JSON.stringify(j).slice(0, 1200)); return j as any;
};
await search('外套');
await search('退换');
await search('尺寸');
const r = await fetch(`${base}/api/kb/documents`, { headers: sessionHeaders(cookies) });
console.log('DOCS', r.status, JSON.stringify(await r.json()).slice(0, 600));
await app.close(); await prisma.$disconnect(); process.exit(0);
