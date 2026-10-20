/**
 * 对账/日报的服务上下文 —— 在 Fastify 路由与脚本之间复用同一组依赖。
 *
 * `drift_log` 未建表时按配置降级为文件存储；`auto` 的探测结果缓存在 app 上，
 * 避免每个请求都 `to_regclass`。
 */

import type { FastifyInstance } from 'fastify';
import { ReconcileService } from './service.js';
import { createPlatformReader, type ReaderMode } from './readers.js';
import { createDriftStore, type DriftStore } from './stores.js';

export interface ReconcileContext {
  store: DriftStore;
  note: string;
  /** 按 reader 模式构造服务（recorded 干跑 / adapter 硬拒绝）。 */
  serviceFor(mode: ReaderMode): ReconcileService;
}

const cache = new WeakMap<FastifyInstance, Promise<ReconcileContext>>();

export function getReconcileContext(app: FastifyInstance): Promise<ReconcileContext> {
  const cached = cache.get(app);
  if (cached) return cached;
  const pending = (async (): Promise<ReconcileContext> => {
    const bundle = await createDriftStore(app.prisma, {
      mode: app.config.reconcileStore,
      directory: app.config.reconcileDir,
    });
    return {
      store: bundle.store,
      note: bundle.note,
      serviceFor(mode: ReaderMode): ReconcileService {
        return new ReconcileService({
          prisma: app.prisma,
          store: bundle.store,
          storeNote: bundle.note,
          reader: createPlatformReader(mode),
          audit: app.audit,
        });
      },
    };
  })();
  cache.set(app, pending);
  return pending;
}
