/** worker 中的媒体轮询器：扫描到期 job → 推进一步 → 清理已取消任务的临时对象。 */
import { getPrisma } from '@dssaas/db';
import { MockMediaProvider } from './provider.js';
import { MediaPipeline } from './pipeline.js';
import { PrismaMediaRepository } from './prisma-repository.js';
import { s3StorageFromEnv } from './storage.js';

export interface MediaWorkerOptions {
  intervalMs?: number;
  limit?: number;
  pipeline?: MediaPipeline;
}

export function createRuntimePipeline(): MediaPipeline {
  const repo = new PrismaMediaRepository(getPrisma());
  return new MediaPipeline({
    repo,
    storage: s3StorageFromEnv(),
    provider: new MockMediaProvider(),
    log: { warn: (obj, msg) => console.warn(msg ?? 'media warning', obj) },
  });
}

export async function runMediaWorkerOnce(pipeline: MediaPipeline, limit = 10): Promise<number> {
  const processed = await pipeline.runDue(limit);
  await pipeline.cleanupCancelled(limit);
  return processed.length;
}

/** 启动轮询循环；返回停止函数（测试/优雅退出用）。 */
export function startMediaWorker(options: MediaWorkerOptions = {}): () => void {
  const pipeline = options.pipeline ?? createRuntimePipeline();
  const intervalMs = options.intervalMs ?? 5_000;
  const limit = options.limit ?? 10;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runMediaWorkerOnce(pipeline, limit)
      .catch((error: unknown) => {
        console.error('media worker tick failed', error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
