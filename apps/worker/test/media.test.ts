/**
 * M6 媒体管线机制测试（node:test + tsx）。
 * 覆盖：幂等不重复计费、取消清理、退避、失败分类、AIGC 标识、尺码表幂等、配额拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backoffDelayMs } from '../src/media/backoff.js';
import { MEDIA_BUCKET, RAW_BUCKET, VARIANTS_BUCKET, tempPrefix } from '../src/media/keys.js';
import { MemoryMediaRepository, makeJob } from '../src/media/memory-repository.js';
import { MediaPipeline, QuotaExceededError } from '../src/media/pipeline.js';
import { MockMediaProvider } from '../src/media/provider.js';
import { renderSizeChart } from '../src/media/render.js';
import { FsStorage } from '../src/media/storage.js';
import { S3Storage } from '../src/media/storage.js';
import type { MediaJobRecord } from '../src/media/types.js';

class FakeClock {
  constructor(private t = Date.UTC(2026, 9, 20, 10, 0, 0)) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const terminal = new Set(['succeeded', 'failed', 'expired', 'cancelled']);

async function drain(
  pipeline: MediaPipeline,
  repo: MemoryMediaRepository,
  clock: FakeClock,
  jobId: string,
  maxSteps = 12,
): Promise<MediaJobRecord> {
  let job = await repo.getJob(jobId);
  for (let step = 0; step < maxSteps && job && !terminal.has(job.status); step += 1) {
    if (job.pollAfter && job.pollAfter.getTime() > clock.now().getTime()) {
      clock.advance(job.pollAfter.getTime() - clock.now().getTime());
    }
    await pipeline.advance(jobId);
    job = await repo.getJob(jobId);
  }
  if (!job) throw new Error('job 丢失');
  return job;
}

async function withStorage(t: test.TestContext): Promise<FsStorage> {
  const dir = await mkdtemp(join(tmpdir(), 'dssaas-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return FsStorage.create(dir);
}

test('管线成功：3 个变体落库，成本只记一次，重复推进幂等', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository();
  const provider = new MockMediaProvider({ pendingPolls: 0, costCents: 4 });
  const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });
  const job = makeJob({ id: 'job-success', params: { kind: 'scene', source: 'ai_generated' } });
  repo.jobs.set(job.id, job);

  const finished = await drain(pipeline, repo, clock, job.id);
  assert.equal(finished.status, 'succeeded');
  assert.ok(finished.mediaAssetId);

  const asset = await repo.getAssetByJob(job.id);
  assert.ok(asset);
  assert.equal(asset.variants.length, 3);
  assert.deepEqual(
    asset.variants.map((v) => v.key).sort(),
    ['detail_1200', 'main_800', 'thumb_320'],
  );
  assert.equal(repo.ledgers.length, 1);
  assert.equal(repo.ledgers[0]?.amountCents, 4);
  assert.equal(repo.ledgers[0]?.kind, 'media');

  // 重复推进：不再提交、不再落库、不再计费
  await pipeline.advance(job.id);
  assert.equal(repo.ledgers.length, 1);
  assert.equal(repo.assets.size, 1);
  assert.equal(provider.getSubmitCount(), 1);

  // 三个变体与源对象都在对应桶里
  for (const variant of asset.variants) {
    assert.equal(variant.bucket, VARIANTS_BUCKET);
    assert.ok(await storage.exists(VARIANTS_BUCKET, variant.objectKey));
  }
  assert.ok(await storage.exists(MEDIA_BUCKET, asset.objectKey));
});

test('轮询退避：2s → 4s → 8s（由注入时钟验证，无真实 sleep）', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository();
  const provider = new MockMediaProvider({ pendingPolls: 10 });
  const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });
  const job = makeJob({ id: 'job-backoff' });
  repo.jobs.set(job.id, job);

  const submitted = await pipeline.advance(job.id);
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.pollAfter!.getTime() - clock.now().getTime(), 2000);

  clock.advance(2000);
  const first = await pipeline.advance(job.id);
  assert.equal(first.status, 'polling');
  assert.equal(first.pollCount, 1);
  assert.equal(first.pollAfter!.getTime() - clock.now().getTime(), 4000);

  clock.advance(4000);
  const second = await pipeline.advance(job.id);
  assert.equal(second.pollCount, 2);
  assert.equal(second.pollAfter!.getTime() - clock.now().getTime(), 8000);

  assert.deepEqual(
    [0, 1, 2].map((n) => backoffDelayMs('image', n, () => 0.5)),
    [2000, 4000, 8000],
  );
});

test('取消：终态 cancelled，临时对象被清理，重复取消幂等', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository();
  const pipeline = new MediaPipeline({
    repo,
    storage,
    provider: new MockMediaProvider(),
    clock,
    random: () => 0.5,
  });
  const job = makeJob({ id: 'job-cancel' });
  repo.jobs.set(job.id, job);
  await storage.put(RAW_BUCKET, `${tempPrefix(job.id)}source.png`, Buffer.from('tmp'), 'image/png');
  assert.equal((await storage.list(RAW_BUCKET, tempPrefix(job.id))).length, 1);

  const cancelled = await pipeline.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await storage.list(RAW_BUCKET, tempPrefix(job.id))).length, 0);
  assert.equal((await repo.getAssetByJob(job.id)), null);

  const again = await pipeline.cancel(job.id);
  assert.equal(again.status, 'cancelled');
});

test('失败分类：permanent / manual / retryable', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository();
  const provider = new MockMediaProvider({ pendingPolls: 0 });
  const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });

  async function failedWith(mode: 'permanent' | 'manual'): Promise<MediaJobRecord> {
    const job = makeJob({ id: `job-${mode}` });
    repo.jobs.set(job.id, job);
    const submitted = await pipeline.advance(job.id);
    provider.setFailMode(submitted.externalJobId!, mode);
    return pipeline.advance(job.id);
  }

  const permanent = await failedWith('permanent');
  assert.equal(permanent.status, 'failed');
  assert.equal(permanent.errorClass, 'permanent');

  const manual = await failedWith('manual');
  assert.equal(manual.status, 'failed');
  assert.equal(manual.errorClass, 'manual');

  // retryable：maxAttempts=1 → 第一次重投，第二次达到上限后失败
  const retryJob = makeJob({ id: 'job-retry', maxAttempts: 1 });
  repo.jobs.set(retryJob.id, retryJob);
  const submitted = await pipeline.advance(retryJob.id);
  provider.setFailMode(submitted.externalJobId!, 'retryable');
  const retried = await pipeline.advance(retryJob.id);
  assert.equal(retried.attempt, 1);
  assert.equal(retried.status, 'queued');
  clock.advance(60_000);
  const resubmitted = await pipeline.advance(retryJob.id);
  const final = await pipeline.advance(resubmitted.id);
  assert.equal(final.status, 'failed');
  assert.equal(final.errorClass, 'retryable');
});

test('AIGC：source=ai_generated 时所有变体强制带标识', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository();
  const provider = new MockMediaProvider({ pendingPolls: 0 });
  const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });
  const job = makeJob({
    id: 'job-aigc',
    params: { kind: 'scene', source: 'ai_generated' },
  });
  repo.jobs.set(job.id, job);

  await drain(pipeline, repo, clock, job.id);
  const asset = await repo.getAssetByJob(job.id);
  assert.ok(asset);
  assert.equal(asset.aigcLabeled, true);
  assert.equal(asset.source, 'ai_generated');
  assert.ok(asset.aigcMeta && asset.aigcMeta.text === 'AI 生成');
  assert.ok(asset.variants.every((variant) => variant.aigcLabeled));
});

test('尺码表渲染：同版本重复渲染字节级一致（幂等）', async () => {
  const input = {
    productName: '测试连衣裙',
    fit: 'slim',
    rows: [
      { sizeCode: 'S', sizeOrder: 1, measurements: { 衣长: 66, 胸围: 88, 肩宽: 36 } },
      { sizeCode: 'M', sizeOrder: 2, measurements: { 衣长: 68, 胸围: 92, 肩宽: 37 } },
      { sizeCode: 'L', sizeOrder: 3, measurements: { 衣长: 70, 胸围: 96, 肩宽: 38 } },
      { sizeCode: 'XL', sizeOrder: 4, measurements: { 衣长: 72, 胸围: 100, 肩宽: 39 } },
    ],
    versionNo: 3,
    effectiveFrom: new Date('2026-10-20T10:15:00Z'),
  };

  const first = await renderSizeChart(input);
  const second = await renderSizeChart(input);
  assert.equal(first.dataVersion, 'v20261020T101500Z');
  assert.equal(first.specHash, second.specHash);
  assert.deepEqual(
    first.charts.map((chart) => chart.sha256),
    second.charts.map((chart) => chart.sha256),
  );
  assert.deepEqual(first.columns, ['衣长', '胸围', '肩宽']);
  assert.deepEqual(first.charts.map((chart) => chart.key), ['chart_750', 'chart_1200']);
  for (const chart of first.charts) {
    assert.ok(chart.bytes > 1000);
    assert.equal(chart.mime, 'image/png');
  }
});

test('配额超限：拒绝并给可读错误，不产生资产/费用', async (t) => {
  const storage = await withStorage(t);
  const clock = new FakeClock();
  const repo = new MemoryMediaRepository({ quota: { maxImages: 0, used: 0 } });
  const pipeline = new MediaPipeline({
    repo,
    storage,
    provider: new MockMediaProvider({ pendingPolls: 0 }),
    clock,
    random: () => 0.5,
  });
  const job = makeJob({ id: 'job-quota' });
  repo.jobs.set(job.id, job);

  await assert.rejects(
    () => pipeline.advance(job.id),
    (error: unknown) => error instanceof QuotaExceededError && /配额已用完/.test(error.message),
  );
  const failed = await repo.getJob(job.id);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.errorCode, 'quota');
  assert.equal(repo.ledgers.length, 0);
  assert.equal(repo.assets.size, 0);
});

test('S3Storage：path-style 桶/键、SigV4 头、get/list/delete', async (t) => {
  const objects = new Map<string, Buffer>();
  let lastAuth = '';
  let lastPath = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
      const bucket = segments.shift() ?? '';
      const key = segments.join('/');
      lastAuth = String(req.headers.authorization ?? '');
      lastPath = url.pathname;
      if (req.method === 'PUT' && key === '') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'PUT') {
        objects.set(`${bucket}/${key}`, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()]
          .filter((object) => object.startsWith(`${bucket}/`))
          .map((object) => object.slice(bucket.length + 1))
          .filter((objectKey) => objectKey.startsWith(prefix));
        const xml = `<?xml version="1.0"?><ListBucketResult>${keys
          .map((objectKey) => `<Contents><Key>${objectKey}</Key></Contents>`)
          .join('')}</ListBucketResult>`;
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(xml);
        return;
      }
      if (req.method === 'GET') {
        const body = objects.get(`${bucket}/${key}`);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (req.method === 'HEAD') {
        res.writeHead(objects.has(`${bucket}/${key}`) ? 200 : 404);
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(`${bucket}/${key}`);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务未监听');
  const storage = new S3Storage({
    endpoint: `http://127.0.0.1:${address.port}`,
    accessKey: 'test',
    secretKey: 'secret',
  });
  const body = Buffer.from('hello s3');
  await storage.put('media', 'scene/1/abc/source.png', body);
  assert.match(lastAuth, /^AWS4-HMAC-SHA256 Credential=test\//);
  assert.equal(lastPath, '/media/scene/1/abc/source.png');
  assert.equal(await storage.exists('media', 'scene/1/abc/source.png'), true);
  assert.deepEqual(await storage.get('media', 'scene/1/abc/source.png'), body);
  assert.deepEqual(await storage.list('media', 'scene/1/'), ['scene/1/abc/source.png']);
  await storage.delete('media', 'scene/1/abc/source.png');
  assert.equal(await storage.exists('media', 'scene/1/abc/source.png'), false);
});
