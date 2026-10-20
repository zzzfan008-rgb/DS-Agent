/**
 * apps/worker —— worker 入口。
 *
 * M6：媒体管线已实现（轮询 media_job → mock provider → MinIO → 变体 → 成本/配额）。
 * 设置 MEDIA_WORKER_ENABLED=1 时启动媒体轮询循环；未设置时只导出模块，便于测试与后续
 * BullMQ 队列接入（sync / reconcile / notify / batch 仍待实现）。
 */
export { WORKER_SERVICE } from './service.js';

export * from './media/index.js';

import { startMediaWorker } from './media/poller.js';

if (process.env.MEDIA_WORKER_ENABLED === '1') {
  const stop = startMediaWorker();
  process.on('SIGINT', () => {
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
}
