/**
 * t34 证据脚本：一个 worker 进程跑一轮媒体轮询。
 * 运行：DATABASE_URL=... MEDIA_FS_ROOT=... tsx scripts/claim-worker.ts <workerId>
 */
import { PrismaClient } from '@dssaas/db';
import sharp from 'sharp';
import { mediaDemoProvider } from './demo-provider.js';
import { MediaPipeline } from '../src/media/pipeline.js';
import { PrismaMediaRepository } from '../src/media/prisma-repository.js';
import { runMediaWorkerOnce } from '../src/media/poller.js';
import { FsStorage } from '../src/media/storage.js';

async function main(): Promise<void> {
  const workerId = process.argv[2] ?? 'worker';
  const root = process.env.MEDIA_FS_ROOT ?? 'artifacts/t34';
  const prisma = new PrismaClient();
  const storage = await FsStorage.create(root);
  const pipeline = new MediaPipeline({
    repo: new PrismaMediaRepository(prisma),
    storage,
    provider: mediaDemoProvider(sharp),
    workerId,
    leaseMs: 5_000,
    heartbeatMs: 20,
  });
  const processed = await runMediaWorkerOnce(pipeline, 5);
  console.log(JSON.stringify({ worker: pipeline.workerId, processed }));
  await prisma.$disconnect();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
