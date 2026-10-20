/**
 * t39 证据脚本：把一个 API 创建的 media_job 推到终态（真实 DB + FsStorage + mock provider）。
 * 运行：DATABASE_URL=... MEDIA_FS_ROOT=... tsx scripts/process-job.ts <jobId>
 */
import { PrismaClient } from '@dssaas/db';
import { MockMediaProvider } from '../src/media/provider.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { PrismaMediaRepository } from '../src/media/prisma-repository.js';
import { FsStorage } from '../src/media/storage.js';

class FakeClock {
  constructor(private t = Date.now()) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'expired', 'cancelled']);

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('用法：tsx scripts/process-job.ts <jobId>');
  const prisma = new PrismaClient();
  try {
    const clock = new FakeClock();
    const storage = await FsStorage.create(process.env.MEDIA_FS_ROOT ?? 'artifacts/media-e2e');
    const pipeline = new MediaPipeline({
      repo: new PrismaMediaRepository(prisma),
      storage,
      provider: new MockMediaProvider({
        pendingPolls: Number(process.env.MEDIA_PENDING_POLLS ?? 0),
        costCents: 4,
      }),
      clock,
      workerId: 'e2e-worker',
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    });

    let status = 'queued';
    for (let i = 0; i < 40; i += 1) {
      const job = await pipeline.advance(jobId);
      status = job.status;
      if (TERMINAL.has(status)) break;
      const wait = job.pollAfter ? job.pollAfter.getTime() - clock.now().getTime() : 0;
      clock.advance(Math.max(wait, 1_000));
    }
    const final = await prisma.mediaJob.findUniqueOrThrow({ where: { id: jobId } });
    console.log(
      JSON.stringify({
        jobId,
        status: final.status,
        assetId: final.mediaAssetId,
        costCents: final.costCents,
        attempts: final.pollCount,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
