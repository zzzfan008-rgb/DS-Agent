/**
 * apps/worker —— BullMQ worker 入口（M1 骨架）。
 *
 * 后续在此注册队列：media / sync / reconcile / notify / batch。
 * 约束：worker 不对外提供 API，只消费队列并把状态写回 Postgres。
 */
export const WORKER_SERVICE = '@dssaas/worker';
