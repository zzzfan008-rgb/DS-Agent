/**
 * t50 手工证据脚本 —— **CI 不跑，需手动执行**。
 *
 * 为什么单独一个文件：它验证的是"三种时序下的 pending 重放行为"，需要人工看输出，
 * 不是断言型测试。因此**故意不命名为 `*.test.ts`**，`apps/api/test/run.ts` 的
 * `.filter((file) => file.endsWith('.test.ts'))` 不会把它纳入 `pnpm test`。
 *
 * 运行：
 *   cd apps/api && npx tsx test/t50-evidence.ts
 *
 * **防腐提示**：改动以下任一处后，必须手动重跑本脚本并核对输出：
 * - `src/sync/after-sale-sink.ts`（`replayPendingAfterSales` / `MemoryAfterSaleSink`）
 * - `src/sync/service.ts`（`replayPendingAfterOrders` 触发条件）
 * - `src/sync/readers.ts` 的 `after_sale` 录制样本
 * - `src/sync/order-sink.ts`（`MemoryOrderSink`）
 *
 * 断言型覆盖在 `test/reconcile.test.ts` 的 5 条 `t50` 用例里；本脚本只负责"人眼可读的证据"。
 */
import { MemorySyncCursorStore } from '../src/sync/cursor-store.js';
import { createSyncReaders } from '../src/sync/readers.js';
import { MemoryOrderSink } from '../src/sync/order-sink.js';
import { MemoryAfterSaleSink, replayPendingAfterSales } from '../src/sync/after-sale-sink.js';
import { SyncService } from '../src/sync/service.js';

async function main(): Promise<void> {
  const sink = new MemoryAfterSaleSink();
  const orderSink = new MemoryOrderSink();
  const readers = createSyncReaders('recorded');
  let calls = 0;
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: orderSink, after_sale: sink },
    replayPendingAfterOrders: async (platform, ctx) => {
      calls += 1;
      for (const order of orderSink.orders.values()) sink.knownOrders.add(order.order_id);
      const result = await replayPendingAfterSales(readers.after_sale, sink, platform, ctx.now);
      return {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        pending: result.pending,
        degraded: result.degraded,
      };
    },
  });

  const first = await service.run('1688', 'after_sale', { owner: 'w1' });
  console.log(
    '① 售后先到 :',
    JSON.stringify({ pulled: first.stats.pulled, created: first.stats.created, pending: first.stats.pending, reasons: first.stats.pending_reasons }),
  );

  const orders = await service.run('1688', 'orders', { owner: 'w2' });
  console.log('② 订单后到 :', JSON.stringify(orders.after_sale_retry));
  console.log('   落库售后 :', [...sink.rows.keys()].sort().join(', '));

  const third = await service.run('1688', 'orders', { owner: 'w3' });
  console.log(
    '③ 重复触发 :',
    `created=${third.stats.created}`,
    `retry=${JSON.stringify(third.after_sale_retry)}`,
    `replayCalls=${calls}`,
  );

  const forced = await replayPendingAfterSales(readers.after_sale, sink, '1688', new Date());
  console.log('   强制再放 :', JSON.stringify({ created: forced.created, skipped: forced.skipped, pending: forced.pending }));

  const degraded = await replayPendingAfterSales(readers.after_sale, new MemoryAfterSaleSink(), '1688', new Date(), { maxItems: 2 });
  console.log('④ 超上限   :', JSON.stringify(degraded));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
