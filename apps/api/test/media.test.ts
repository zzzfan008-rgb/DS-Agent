/** t39 验收：媒体 HTTP 主链路（generate → worker → job/asset → review → download）。 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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

const PASSWORD = 'TestMediaPassword!2026';
let app: FastifyInstance;
let fsRoot: string;
let adminHeaders: Record<string, string>;
let operatorHeaders: Record<string, string>;
let providerId: string;
let modelId: string;

function headersWith(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'application/json', 'idempotency-key': `t39-${randomUUID()}` };
}

async function post(path: string, body: unknown, headers = operatorHeaders) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: headersWith(headers),
    payload: body as Record<string, unknown>,
  });
}

function runWorker(jobId: string): { status: string; assetId: string | null; costCents: number } {
  const repoRoot = resolve(process.cwd(), '../..');
  const scriptPath = resolve(repoRoot, 'apps/worker/scripts/process-job.ts');
  const tsxCli = resolve(repoRoot, 'apps/worker/node_modules/tsx/dist/cli.mjs');
  const output = execFileSync(process.execPath, [tsxCli, scriptPath, jobId], {
    cwd: repoRoot,
    timeout: 180_000,
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '',
      MEDIA_FS_ROOT: fsRoot,
      MEDIA_PENDING_POLLS: '0',
    },
  });
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.trim().startsWith('{'));
  if (!line) throw new Error(`worker 未输出 JSON：${output}`);
  return JSON.parse(line) as { status: string; assetId: string | null; costCents: number };
}

before(async () => {
  fsRoot = await mkdtemp(resolve(tmpdir(), 'dssaas-t39-'));
  process.env.MEDIA_FS_ROOT = fsRoot;
  app = await buildTestApp();
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const admin = await createUser({ email: `admin.t39.${suffix}@test.local`, password: PASSWORD, role: 'admin' });
  const operator = await createUser({ email: `operator.t39.${suffix}@test.local`, password: PASSWORD, role: 'operator' });
  const adminLogin = await login(app, admin.email, PASSWORD);
  adminHeaders = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));
  const operatorLogin = await login(app, operator.email, PASSWORD);
  operatorHeaders = sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin));

  const provider = await prisma.provider.create({
    data: {
      name: `t39_provider_${suffix}`,
      kind: 'image',
      vendor: 'other',
      baseUrl: 'https://example.com',
      credentialRef: 'test/t39',
      status: 'active',
    },
  });
  providerId = provider.id;
  const model = await prisma.model.create({
    data: {
      providerId: provider.id,
      name: `t39_model_${suffix}`,
      externalModelId: 'mock-image',
      displayName: 'T39 Mock Image',
      capability: 'image',
      status: 'published',
      paramsSchema: {},
      price: {},
    },
  });
  modelId = model.id;
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
  if (fsRoot) await rm(fsRoot, { recursive: true, force: true });
});

test('媒体主链路：generate → worker → 状态/产物 → 人审 → 下载', async () => {
  const generated = await post('/api/media/generate', {
    kind: 'concept',
    purpose: 'image',
    provider_id: providerId,
    model_id: modelId,
    params: { prompt: '白色连衣裙，棚拍', count: 1, pending_polls: 0 },
  });
  assert.equal(generated.statusCode, 201, generated.body);
  const generatedData = (generated.json() as { data: { job_id: string; status: string; deduped: boolean; cost_reserved_cents: number } }).data;
  assert.equal(generatedData.status, 'queued');
  assert.equal(generatedData.deduped, false);
  const jobId = generatedData.job_id;

  const queued = await prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
  assert.equal(queued.status, 'queued');
  assert.equal(queued.purpose, 'image');
  assert.equal((queued.params as { kind?: string }).kind, 'concept');

  const worker = runWorker(jobId);
  assert.equal(worker.status, 'succeeded');
  assert.ok(worker.assetId);
  const assetId = worker.assetId!;

  const jobResponse = await app.inject({
    method: 'GET',
    url: `/api/media/jobs/${jobId}`,
    headers: operatorHeaders,
  });
  assert.equal(jobResponse.statusCode, 200, jobResponse.body);
  const job = (jobResponse.json() as { data: { status: string; result_asset_id: string; cost_actual_cents: number } }).data;
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result_asset_id, assetId);
  assert.equal(job.cost_actual_cents, 4);

  const jobList = await app.inject({
    method: 'GET',
    url: `/api/media/jobs?status=succeeded&kind=concept`,
    headers: operatorHeaders,
  });
  assert.equal(jobList.statusCode, 200, jobList.body);
  assert.ok((jobList.json() as { data: { items: { id: string }[] } }).data.items.some((item) => item.id === jobId));

  const assetResponse = await app.inject({
    method: 'GET',
    url: `/api/media/assets/${assetId}`,
    headers: operatorHeaders,
  });
  assert.equal(assetResponse.statusCode, 200, assetResponse.body);
  const asset = (assetResponse.json() as { data: { asset: { status: string; is_aigc: boolean }; variants: { key: string }[] } }).data;
  assert.equal(asset.asset.status, 'pending_review');
  assert.equal(asset.asset.is_aigc, true);
  assert.deepEqual(asset.variants.map((v) => v.key).sort(), ['detail_1200', 'main_800', 'thumb_320']);

  const listAssets = await app.inject({
    method: 'GET',
    url: `/api/media/assets?kind=concept&status=pending_review`,
    headers: operatorHeaders,
  });
  assert.equal(listAssets.statusCode, 200, listAssets.body);
  assert.ok((listAssets.json() as { data: { items: { id: string }[] } }).data.items.some((item) => item.id === assetId));

  const download = await app.inject({
    method: 'GET',
    url: `/api/media/assets/${assetId}/download`,
    headers: operatorHeaders,
  });
  assert.equal(download.statusCode, 200, download.body.slice(0, 200));
  assert.ok(download.rawPayload.length > 0);
  assert.match(String(download.headers['content-type']), /image\//);

  const variantDownload = await app.inject({
    method: 'GET',
    url: `/api/media/assets/${assetId}/download?variant=thumb_320`,
    headers: operatorHeaders,
  });
  assert.equal(variantDownload.statusCode, 200, variantDownload.body.slice(0, 200));
  assert.ok(variantDownload.rawPayload.length > 0);

  const review = await post(`/api/media/assets/${assetId}/review`, { result: 'approved', note: 't39 E2E' }, adminHeaders);
  assert.equal(review.statusCode, 200, review.body);
  assert.equal((review.json() as { data: { status: string } }).data.status, 'approved');
  const approved = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
  assert.equal(approved.status, 'approved');

  const ledger = await prisma.costLedger.findMany({
    where: { refType: 'media_job', refId: jobId },
  });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0]!.amountCents, 4);
});

test('幂等：同请求体重复 generate 返回同一 job，不重复建任务', async () => {
  const body = {
    kind: 'concept',
    purpose: 'image',
    provider_id: providerId,
    model_id: modelId,
    params: { prompt: '幂等测试', count: 1 },
  };
  const first = await post('/api/media/generate', body);
  assert.equal(first.statusCode, 201, first.body);
  const firstId = (first.json() as { data: { job_id: string } }).data.job_id;
  const countAfterFirst = await prisma.mediaJob.count();

  const second = await app.inject({
    method: 'POST',
    url: '/api/media/generate',
    headers: headersWith(operatorHeaders),
    payload: body,
  });
  assert.equal(second.statusCode, 200, second.body);
  const data = (second.json() as { data: { job_id: string; deduped: boolean } }).data;
  assert.equal(data.deduped, true);
  assert.equal(data.job_id, firstId);
  assert.equal(await prisma.mediaJob.count(), countAfterFirst);
  const jobs = await prisma.mediaJob.findMany({ where: { purpose: 'image', id: firstId } });
  assert.equal(jobs.length, 1);
});

test('校验：非法 purpose/provider 被拒；purpose=render 可落库', async () => {
  const badPurpose = await post('/api/media/generate', {
    kind: 'concept',
    purpose: 'bogus',
    provider_id: providerId,
    model_id: modelId,
    params: { prompt: 'x' },
  });
  assert.equal(badPurpose.statusCode, 422, badPurpose.body);

  const badProvider = await post('/api/media/generate', {
    kind: 'concept',
    purpose: 'image',
    provider_id: randomUUID(),
    model_id: modelId,
    params: { prompt: 'x' },
  });
  assert.ok([404, 422].includes(badProvider.statusCode), badProvider.body);

  const badRender = await post('/api/media/generate', {
    kind: 'scene',
    purpose: 'render',
    provider_id: providerId,
    model_id: modelId,
    params: { prompt: 'x' },
  });
  assert.equal(badRender.statusCode, 422, badRender.body);

  // F-E2E-02：render 可落库（DB CHECK 已放宽）；bogus 被 DB 拒绝
  const render = await prisma.mediaJob.create({
    data: {
      purpose: 'render',
      providerId,
      modelId,
      params: { kind: 'size_chart', size_chart: { rows: [] } },
      status: 'queued',
      idempotencyKey: `t39-render-${randomUUID()}`,
    },
  });
  assert.equal(render.purpose, 'render');
  await assert.rejects(
    prisma.mediaJob.create({
      data: {
        purpose: 'bogus',
        providerId,
        modelId,
        params: {},
        status: 'queued',
        idempotencyKey: `t39-bogus-${randomUUID()}`,
      },
    }),
  );
});
