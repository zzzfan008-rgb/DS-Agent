/**
 * M6 演示：用内存仓储 + 文件存储跑通两条管线，产出真实样例文件到 artifacts/media/。
 * 运行：pnpm --filter @dssaas/worker exec tsx scripts/media-demo.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MediaPipeline } from '../src/media/pipeline.js';
import { MemoryMediaRepository, makeJob } from '../src/media/memory-repository.js';
import { MockMediaProvider } from '../src/media/provider.js';
import { renderSizeChart } from '../src/media/render.js';
import { FsStorage } from '../src/media/storage.js';
import type { MediaJobRecord } from '../src/media/types.js';

const outRoot = resolve(process.cwd(), '../../artifacts/media');

class DemoClock {
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
  clock: DemoClock,
  jobId: string,
): Promise<MediaJobRecord> {
  let job = await repo.getJob(jobId);
  for (let i = 0; i < 20 && job && !terminal.has(job.status); i += 1) {
    if (job.pollAfter && job.pollAfter.getTime() > clock.now().getTime()) {
      clock.advance(job.pollAfter.getTime() - clock.now().getTime());
    }
    await pipeline.advance(jobId);
    job = await repo.getJob(jobId);
  }
  if (!job) throw new Error('job 丢失');
  return job;
}

async function main(): Promise<void> {
  await mkdir(outRoot, { recursive: true });
  const storage = await FsStorage.create(outRoot);
  const clock = new DemoClock();
  const repo = new MemoryMediaRepository();
  const provider = new MockMediaProvider({ pendingPolls: 1, costCents: 4 });
  const pipeline = new MediaPipeline({ repo, storage, provider, clock, random: () => 0.5 });

  // 1) AI 图任务：3 个变体 + AIGC 标识
  const imageJob = makeJob({
    id: 'demo-image-job',
    params: { kind: 'scene', source: 'ai_generated', pending_polls: 1 },
  });
  repo.jobs.set(imageJob.id, imageJob);
  const imageDone = await drain(pipeline, repo, clock, imageJob.id);
  const imageAsset = await repo.getAssetByJob(imageJob.id);
  if (!imageAsset) throw new Error('图片任务未产出 asset');

  // 2) 尺码表渲染任务：chart_750 + chart_1200
  const sizeChart = {
    productName: '秋季通勤连衣裙',
    fit: 'slim',
    versionNo: 3,
    effectiveFrom: new Date('2026-10-20T10:15:00Z'),
    rows: [
      { sizeCode: 'S', sizeOrder: 1, measurements: { 衣长: 104, 胸围: 88, 肩宽: 36, 袖长: 57 } },
      { sizeCode: 'M', sizeOrder: 2, measurements: { 衣长: 106, 胸围: 92, 肩宽: 37, 袖长: 58 } },
      { sizeCode: 'L', sizeOrder: 3, measurements: { 衣长: 108, 胸围: 96, 肩宽: 38, 袖长: 59 } },
      { sizeCode: 'XL', sizeOrder: 4, measurements: { 衣长: 110, 胸围: 100, 肩宽: 39, 袖长: 60 } },
    ],
  };
  const chartJob = makeJob({
    id: 'demo-size-chart-job',
    purpose: 'render',
    params: { kind: 'size_chart', size_chart: sizeChart },
    idempotencyKey: 'idem-demo-size-chart',
  });
  repo.jobs.set(chartJob.id, chartJob);
  const chartDone = await drain(pipeline, repo, clock, chartJob.id);
  const chartAsset = await repo.getAssetByJob(chartJob.id);
  if (!chartAsset) throw new Error('尺码表任务未产出 asset');

  // 3) 纯渲染函数再跑一次，验证同版本字节一致
  const rerender = await renderSizeChart(sizeChart);
  const rerenderSame = rerender.charts.every(
    (chart, index) => chart.sha256 === chartAsset.variants[index]?.sha256,
  );

  const manifest = {
    generated_at: new Date().toISOString(),
    pipeline: {
      image_job: {
        id: imageDone.id,
        status: imageDone.status,
        asset_id: imageAsset.id,
        aigc_labeled: imageAsset.aigcLabeled,
        cost_cents: imageDone.costCents,
        variants: imageAsset.variants.map((variant) => ({
          key: variant.key,
          bucket: variant.bucket,
          object_key: variant.objectKey,
          width: variant.width,
          height: variant.height,
          bytes: variant.bytes,
          sha256: variant.sha256,
          aigc_labeled: variant.aigcLabeled,
        })),
      },
      size_chart_job: {
        id: chartDone.id,
        status: chartDone.status,
        asset_id: chartAsset.id,
        data_version: rerender.dataVersion,
        spec_hash: rerender.specHash,
        variants: chartAsset.variants.map((variant) => ({
          key: variant.key,
          bucket: variant.bucket,
          object_key: variant.objectKey,
          width: variant.width,
          height: variant.height,
          bytes: variant.bytes,
          sha256: variant.sha256,
        })),
      },
    },
    idempotent_rerender: rerenderSame,
    cost_ledger: repo.ledgers.map((entry) => ({
      ref_id: entry.refId,
      kind: entry.kind,
      amount_cents: entry.amountCents,
      seconds: entry.seconds,
    })),
  };

  const manifestPath = resolve(outRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`image job: ${imageDone.status} (${imageDone.id}), asset=${imageAsset.id}`);
  for (const variant of imageAsset.variants) {
    console.log(`  ${variant.key}: ${variant.bucket}/${variant.objectKey} ${variant.width}x${variant.height} ${variant.bytes}B`);
  }
  console.log(`size chart: ${chartDone.status} (${chartDone.id}), asset=${chartAsset.id}, data_version=${rerender.dataVersion}`);
  for (const variant of chartAsset.variants) {
    console.log(`  ${variant.key}: ${variant.bucket}/${variant.objectKey} ${variant.width}x${variant.height} ${variant.bytes}B`);
  }
  console.log(`idempotent rerender: ${rerenderSame}`);
  console.log(`cost ledger: ${JSON.stringify(manifest.cost_ledger)}`);
  console.log(`manifest: ${manifestPath}`);
}

void main().catch((error: unknown) => {
  console.error('media demo failed', error);
  process.exit(1);
});
