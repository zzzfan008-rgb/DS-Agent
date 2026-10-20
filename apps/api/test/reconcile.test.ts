/**
 * M8/t43 对账与日报测试 —— 商品 + 订单 + 售后差异、双存储（file/postgres）、同步落库、日报。
 *
 * 测试原则（t43 修正）：
 * - **不依赖"库里没有表"这种环境事实**：存储选择一律显式配置；`auto` 用纯函数 + 一条
 *   "迁移已应用 → 选 postgres"的集成断言；
 * - 平台数据用录制样本（verified=false），不触网、不调平台写接口；
 * - 订单/售后维度使用 t37 的真实表（orders/order_items/after_sale），同步落库幂等按
 *   `(platform, platform_order_id)` 验证。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma, buildTestApp, createUser, login, cookiesFrom, csrfFrom, sessionHeaders } from './helpers.js';
import { collectDailyMetrics } from '../src/daily/metrics.js';
import { evaluateAlerts, parseAlertThresholds } from '../src/daily/thresholds.js';
import { buildDailyReport } from '../src/daily/report.js';
import { persistAlerts, listAlerts } from '../src/daily/alerts.js';
import {
  buildDriftKey,
  countByKind,
  diffAfterSales,
  diffAll,
  diffOrders,
  diffSnapshots,
} from '../src/reconcile/engine.js';
import {
  MemoryDriftStore,
  FileDriftStore,
  PgDriftStore,
  createDriftStore,
  decideDriftStore,
} from '../src/reconcile/stores.js';
import { RecordedPlatformReader, AdapterPlatformReader } from '../src/reconcile/readers.js';
import { MemorySyncCursorStore, PrismaSyncCursorStore, MAX_CONSECUTIVE_FAILURES } from '../src/sync/cursor-store.js';
import { createSyncReaders, AdapterSyncReader } from '../src/sync/readers.js';
import { MemoryOrderSink } from '../src/sync/order-sink.js';
import { SyncService } from '../src/sync/service.js';
import { todayBusinessDay, addDays } from '../src/lib/day.js';
import { uuidv7 } from '../src/lib/ids.js';
import { ApiError } from '../src/lib/errors.js';
import { assertRecordedAllowed } from '../src/lib/adapter-refusal.js';
import type {
  LocalAfterSaleSnapshot,
  LocalListingSnapshot,
  LocalOrderSnapshot,
  PlatformSnapshot,
} from '../src/reconcile/types.js';

const DAY = todayBusinessDay(new Date());
const PASSWORD = 'Passw0rd!Passw0rd!';
const IDEM = (suffix: string) => ({
  'idempotency-key': `t43-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
});

// ---------------------------------------------------------------- 商品维度 fixture

function localListing(
  listingId: string,
  platformItemId: string | null,
  status: string,
  binding: { platformSkuId: string; priceCents: number | null; stockQty: number | null } | null,
): LocalListingSnapshot {
  return {
    listingId,
    platformItemId,
    status,
    platformState: null,
    title: `标题-${listingId}`,
    updatedAt: '2026-10-20T01:00:00.000Z',
    rejectMeta: {},
    skuBindings: binding
      ? [{ skuId: null, platformSkuId: binding.platformSkuId, priceCents: binding.priceCents, stockQty: binding.stockQty }]
      : [],
  };
}

const LOCAL_LISTINGS: LocalListingSnapshot[] = [
  localListing('local-0001', 'ALI-2026-0001', 'published', { platformSkuId: 'ALI-SKU-0001', priceCents: 15800, stockQty: 480 }),
  localListing('local-0002', 'ALI-2026-0002', 'published', { platformSkuId: 'ALI-SKU-0002', priceCents: 15800, stockQty: 120 }),
  localListing('local-0003', 'ALI-2026-0003', 'published', { platformSkuId: 'ALI-SKU-0003', priceCents: 15800, stockQty: 88 }),
  localListing('local-0004', 'ALI-2026-0004', 'published', { platformSkuId: 'ALI-SKU-0004', priceCents: 15800, stockQty: 200 }),
  localListing('local-0005', 'ALI-2026-0005', 'published', { platformSkuId: 'ALI-SKU-0005', priceCents: 15800, stockQty: 200 }),
  localListing('local-0007', 'ALI-2026-0007', 'published', { platformSkuId: 'ALI-SKU-0007', priceCents: 15800, stockQty: 10 }),
];

// ---------------------------------------------------------------- 订单/售后 fixture

function localOrder(
  orderId: string,
  platformOrderId: string,
  status: string,
  totalCents: number,
  paidCents: number,
  items: Array<{ platformSkuRef: string; qty: number; unitPriceCents: number; amountCents: number }>,
): LocalOrderSnapshot {
  return {
    orderId,
    platformOrderId,
    status,
    totalCents,
    paidCents,
    refundStatus: null, // 由售后推导（与 ReconcileService.run 同口径）
    items: items.map((item, index) => ({
      orderItemId: `${orderId}-item-${index + 1}`,
      platformSkuRef: item.platformSkuRef,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
      amountCents: item.amountCents,
    })),
  };
}

const LOCAL_ORDERS: LocalOrderSnapshot[] = [
  // 1001 基线
  localOrder('local-order-1001', 'ALI-ORDER-1001', 'paid', 31600, 31600, [
    { platformSkuRef: 'ALI-SKU-0001', qty: 2, unitPriceCents: 15800, amountCents: 31600 },
  ]),
  // 1002 本地有、平台无
  localOrder('local-order-1002', 'ALI-ORDER-1002', 'paid', 9999, 9999, [
    { platformSkuRef: 'ALI-SKU-0009', qty: 1, unitPriceCents: 9999, amountCents: 9999 },
  ]),
  // 1004 金额不符（平台 30000）；明细与平台一致，避免混入 item 差异
  localOrder('local-order-1004', 'ALI-ORDER-1004', 'paid', 31600, 31600, [
    { platformSkuRef: 'ALI-SKU-0002', qty: 2, unitPriceCents: 15000, amountCents: 30000 },
  ]),
  // 1005 状态+退款状态不符
  localOrder('local-order-1005', 'ALI-ORDER-1005', 'paid', 15800, 15800, [
    { platformSkuRef: 'ALI-SKU-0003', qty: 1, unitPriceCents: 15800, amountCents: 15800 },
  ]),
  // 1006 明细单价不符（平台 15800，本地 31600）；总额一致，避免混入金额差异
  localOrder('local-order-1006', 'ALI-ORDER-1006', 'paid', 31600, 31600, [
    { platformSkuRef: 'ALI-SKU-0001', qty: 1, unitPriceCents: 31600, amountCents: 31600 },
  ]),
];

const LOCAL_AFTER_SALES: LocalAfterSaleSnapshot[] = [
  { afterSaleId: 'local-as-9001', platformAfterSaleId: 'ALI-AS-9001', platformOrderId: 'ALI-ORDER-1004', status: 'open', amountCents: 4000 },
  { afterSaleId: 'local-as-9002', platformAfterSaleId: 'ALI-AS-9002', platformOrderId: 'ALI-ORDER-1005', status: 'open', amountCents: 15800 },
];

function withRefundStatus(orders: LocalOrderSnapshot[], afterSales: LocalAfterSaleSnapshot[]): LocalOrderSnapshot[] {
  const byOrder = new Map<string, string[]>();
  for (const row of afterSales) {
    const list = byOrder.get(row.platformOrderId) ?? [];
    list.push(row.status);
    byOrder.set(row.platformOrderId, list);
  }
  return orders.map((order) => {
    const statuses = byOrder.get(order.platformOrderId) ?? [];
    const refundStatus = statuses.some((status) => ['refunded', 'completed', 'success'].includes(status))
      ? 'refunded'
      : statuses.some((status) => ['open', 'refunding', 'pending', 'processing'].includes(status))
        ? 'refunding'
        : 'none';
    return { ...order, refundStatus };
  });
}

async function recordedSnapshot(): Promise<PlatformSnapshot> {
  return new RecordedPlatformReader().read('1688', { day: DAY, now: new Date().toISOString() });
}

// ---------------------------------------------------------------- 单测：差异引擎

test('商品差异：录制样本 6 类全部被识别，基线 0001 不报差异', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffSnapshots(LOCAL_LISTINGS, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  assert.deepEqual(drifts.map((drift) => drift.kind).sort(), [
    'local_published_missing_platform',
    'local_published_platform_offline',
    'platform_only_listing',
    'price_mismatch',
    'state_mismatch',
    'stock_mismatch',
  ]);
  assert.equal(drifts.filter((drift) => drift.subject.platform_item_id === 'ALI-2026-0001').length, 0);
  for (const drift of drifts) {
    assert.match(drift.drift_key, /^dk_[0-9a-f]{32}$/);
    assert.equal(drift.suggestion.auto_fixable, false);
    assert.ok(drift.suggestion.actions.length >= 2);
  }
});

test('订单差异：平台有本地无 / 本地有平台无 / 金额 / 状态（含退款）/ 明细 5 类各一条', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffOrders(withRefundStatus(LOCAL_ORDERS, LOCAL_AFTER_SALES), snapshot, {
    platform: '1688',
    day: DAY,
    now: '2026-10-20T02:30:00.000Z',
  });
  const byKind = countByKind(drifts);
  assert.deepEqual(byKind, {
    order_platform_only: 1,
    order_local_only: 1,
    order_amount_mismatch: 1,
    order_status_mismatch: 1,
    order_item_mismatch: 1,
  });
  const platformOnly = drifts.find((drift) => drift.kind === 'order_platform_only');
  assert.equal(platformOnly?.subject.platform_order_id, 'ALI-ORDER-1003');
  const localOnly = drifts.find((drift) => drift.kind === 'order_local_only');
  assert.equal(localOnly?.subject.platform_order_id, 'ALI-ORDER-1002');
  const amount = drifts.find((drift) => drift.kind === 'order_amount_mismatch');
  assert.match(amount!.detail, /30000/);
  const status = drifts.find((drift) => drift.kind === 'order_status_mismatch');
  assert.equal(status?.subject.platform_order_id, 'ALI-ORDER-1005');
  assert.match(status!.detail, /退款状态/);
  const item = drifts.find((drift) => drift.kind === 'order_item_mismatch');
  assert.equal(item?.subject.platform_sku_ref, 'ALI-SKU-0001');
  for (const drift of drifts) {
    assert.equal(drift.suggestion.auto_fixable, false);
    assert.ok(drift.suggestion.actions.length >= 2);
  }
  // 可复现
  const again = diffOrders(withRefundStatus(LOCAL_ORDERS, LOCAL_AFTER_SALES), snapshot, {
    platform: '1688',
    day: DAY,
    now: '2026-10-20T03:00:00.000Z',
  });
  assert.deepEqual(again.map((drift) => drift.drift_key), drifts.map((drift) => drift.drift_key));
});

test('售后差异：退款金额不符 / 平台已关闭本地仍 open 2 类各一条', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffAfterSales(LOCAL_AFTER_SALES, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  assert.deepEqual(drifts.map((drift) => drift.kind).sort(), ['after_sale_amount_mismatch', 'after_sale_status_mismatch']);
  const status = drifts.find((drift) => drift.kind === 'after_sale_status_mismatch');
  assert.match(status!.detail, /平台已关闭，本地仍 open/);
  assert.equal(status?.severity, 'high');
  for (const drift of drifts) {
    assert.equal(drift.suggestion.auto_fixable, false);
    assert.equal(drift.subject.type, 'after_sale');
  }
});

test('全维度对账：商品 6 + 订单 5 + 售后 2 = 13 条，drift_key 唯一', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffAll(
    {
      listings: LOCAL_LISTINGS,
      orders: withRefundStatus(LOCAL_ORDERS, LOCAL_AFTER_SALES),
      afterSales: LOCAL_AFTER_SALES,
    },
    snapshot,
    { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' },
  );
  assert.equal(drifts.length, 13);
  assert.equal(new Set(drifts.map((drift) => drift.drift_key)).size, 13);
  assert.deepEqual(countByKind(drifts), {
    platform_only_listing: 1,
    local_published_missing_platform: 1,
    local_published_platform_offline: 1,
    price_mismatch: 1,
    stock_mismatch: 1,
    state_mismatch: 1,
    order_platform_only: 1,
    order_local_only: 1,
    order_amount_mismatch: 1,
    order_status_mismatch: 1,
    order_item_mismatch: 1,
    after_sale_amount_mismatch: 1,
    after_sale_status_mismatch: 1,
  });
});

test('drift_key 规则：商品/订单/售后分别由对象 id 定位；空值按空串；订单维度可区分', () => {
  const base = {
    platform: '1688',
    kind: 'order_amount_mismatch' as const,
    listingId: null,
    platformItemId: null,
    platformSkuId: null,
    platformOrderId: 'ALI-ORDER-1001',
  };
  assert.equal(buildDriftKey(base), buildDriftKey({ ...base }));
  assert.notEqual(buildDriftKey(base), buildDriftKey({ ...base, platformOrderId: 'ALI-ORDER-1002' }));
  assert.notEqual(buildDriftKey(base), buildDriftKey({ ...base, platformAfterSaleId: 'ALI-AS-9001' }));
  assert.equal(
    buildDriftKey({ ...base, listingId: null }),
    buildDriftKey({ ...base, listingId: '' as unknown as null }),
  );
  const listingKey = buildDriftKey({
    platform: '1688',
    kind: 'price_mismatch',
    listingId: 'l1',
    platformItemId: 'p1',
    platformSkuId: 's1',
  });
  assert.notEqual(
    listingKey,
    buildDriftKey({ platform: '1688', kind: 'price_mismatch', listingId: 'l2', platformItemId: 'p1', platformSkuId: 's1' }),
  );
});

test('suggested_action：13 类差异都带 {level,kind}，级别取最重的写/人工动作', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffAll(
    {
      listings: LOCAL_LISTINGS,
      orders: withRefundStatus(LOCAL_ORDERS, LOCAL_AFTER_SALES),
      afterSales: LOCAL_AFTER_SALES,
    },
    snapshot,
    { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' },
  );
  const expected: Record<string, { level: 'A' | 'B' | 'C' | null; kind: string }> = {
    // 商品维度：只有库存是 A 级可逆写，其余是 B/C 级或纯人工
    stock_mismatch: { level: 'A', kind: 'write' },
    price_mismatch: { level: 'C', kind: 'write' },
    state_mismatch: { level: 'B', kind: 'write' },
    local_published_platform_offline: { level: 'B', kind: 'write' },
    local_published_missing_platform: { level: 'B', kind: 'write' },
    platform_only_listing: { level: null, kind: 'manual' },
    // 订单维度
    order_platform_only: { level: null, kind: 'manual' },
    order_local_only: { level: 'B', kind: 'manual' },
    order_amount_mismatch: { level: 'B', kind: 'manual' },
    order_status_mismatch: { level: 'B', kind: 'manual' },
    order_item_mismatch: { level: 'B', kind: 'manual' },
    // 售后维度：退款金额涉及资金 → C 级人工；状态 B 级人工
    after_sale_amount_mismatch: { level: 'C', kind: 'manual' },
    after_sale_status_mismatch: { level: 'B', kind: 'manual' },
  };
  assert.equal(drifts.length, Object.keys(expected).length);
  for (const drift of drifts) {
    assert.deepEqual(drift.suggested_action, expected[drift.kind], `${drift.kind} 的主修复动作不符`);
    // 主动作必须是 suggestion.actions 里真实存在的一条（派生，不是新造）。
    assert.ok(
      drift.suggestion.actions.some(
        (action) => action.level === drift.suggested_action.level && action.kind === drift.suggested_action.kind,
      ),
      `${drift.kind} 的 suggested_action 不在 actions 里`,
    );
    assert.equal(drift.suggestion.auto_fixable, false);
  }
  // 派生是纯函数：同输入同输出（用于断言"不因重复对账漂移"）。
  assert.deepEqual(drifts[0]!.suggested_action, diffAll(
    { listings: LOCAL_LISTINGS, orders: withRefundStatus(LOCAL_ORDERS, LOCAL_AFTER_SALES), afterSales: LOCAL_AFTER_SALES },
    snapshot,
    { platform: '1688', day: DAY, now: '2026-10-20T09:00:00.000Z' },
  )[0]!.suggested_action);
});

test('不完整快照：跳过“本地有平台无”的推断（商品/订单/售后），避免样本不全误报', async () => {  const incomplete: PlatformSnapshot = {
    platform: 'pdd',
    capturedAt: '2026-10-20T02:00:00.000Z',
    source: 'recorded',
    verified: false,
    complete: false,
    ordersComplete: false,
    afterSalesComplete: false,
    note: '不完整',
    items: [],
    orders: [],
    afterSales: [],
  };
  const drifts = diffAll(
    { listings: LOCAL_LISTINGS, orders: LOCAL_ORDERS, afterSales: LOCAL_AFTER_SALES },
    incomplete,
    { platform: 'pdd', day: DAY, now: '2026-10-20T02:30:00.000Z' },
  );
  assert.equal(drifts.length, 0);
});

// ---------------------------------------------------------------- 单测：存储

test('存储决策：file/postgres/auto 分支由纯函数决定，不依赖真实库', () => {
  assert.equal(decideDriftStore('file', { ok: true, reason: null }).kind, 'file');
  assert.equal(decideDriftStore('postgres', { ok: false, reason: 'missing' }).kind, 'postgres');
  assert.equal(decideDriftStore('auto', { ok: true, reason: null }).kind, 'postgres');
  const fallback = decideDriftStore('auto', { ok: false, reason: 'drift_log 表不存在' });
  assert.equal(fallback.kind, 'file');
  assert.match(fallback.note, /drift_log 表不存在/);
});

test('文件/内存存储：同日重复 upsert 只更新不新增（seen_count 递增，first_detected_at 保留）', async () => {
  const snapshot = await recordedSnapshot();
  const detected = diffSnapshots(LOCAL_LISTINGS, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-drift-'));
  try {
    for (const store of [new MemoryDriftStore(), new FileDriftStore(dir)]) {
      const first = await store.upsert('1688', DAY, detected);
      assert.equal(first.inserted, detected.length);
      const second = await store.upsert('1688', DAY, detected);
      assert.equal(second.inserted, 0);
      assert.equal(second.updated + second.unchanged, detected.length);
      const rows = await store.list(DAY, '1688');
      assert.equal(rows.length, detected.length);
      assert.ok(rows.every((row) => row.seen_count === 2));
      const firstSeen = rows[0]!.first_detected_at;
      await store.upsert('1688', DAY, detected);
      const rows3 = await store.list(DAY, '1688');
      assert.equal(rows3[0]!.first_detected_at, firstSeen);
      assert.equal(rows3[0]!.seen_count, 3);
      assert.equal(await store.count(DAY, '1688'), detected.length);
      assert.equal(await store.count(DAY, '1688', 'price_mismatch'), 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto 存储（集成）：t37 迁移已应用 → 选 postgres；显式 file 仍可用', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-drift-auto-'));
  try {
    const auto = await createDriftStore(prisma, { mode: 'auto', directory: dir });
    assert.equal(auto.store.name, 'postgres', '迁移已应用时 auto 必须选 drift_log');
    assert.match(auto.note, /drift_log/);
    const file = await createDriftStore(prisma, { mode: 'file', directory: dir });
    assert.equal(file.store.name, 'file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PgDriftStore：真实 drift_log upsert 幂等、detail jsonb 承载扩展字段', async () => {
  const store = new PgDriftStore(prisma);
  const snapshot = await recordedSnapshot();
  const day = addDays(DAY, 1);
  const detected = diffSnapshots(LOCAL_LISTINGS, snapshot, { platform: '1688', day, now: '2026-10-21T02:30:00.000Z' });
  try {
    const first = await store.upsert('1688', day, detected);
    assert.equal(first.inserted, detected.length);
    const second = await store.upsert('1688', day, detected);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, detected.length);
    const rows = await store.list(day, '1688');
    assert.equal(rows.length, detected.length);
    const row = rows.find((item) => item.kind === 'price_mismatch');
    assert.ok(row);
    assert.equal(row!.subject.type, 'sku');
    assert.equal(row!.suggestion.auto_fixable, false);
    assert.equal(row!.seen_count, 2);
    assert.equal(row!.first_detected_at, row!.detected_at);
    assert.equal(await store.count(day, '1688', 'price_mismatch'), 1);
    assert.equal((await store.countByKind(day, '1688')).price_mismatch, 1);
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM drift_log WHERE day = $1::date AND platform = '1688'`, day);
  }
});

// ---------------------------------------------------------------- 单测：阈值

test('阈值：未配置不告警；非法 JSON / 未知键报错；严格大于才触发', () => {
  assert.deepEqual(parseAlertThresholds(undefined), { thresholds: null, issues: [] });
  assert.deepEqual(parseAlertThresholds('   '), { thresholds: null, issues: [] });
  assert.ok(parseAlertThresholds('{"drift_total":-1}').issues.length > 0);
  assert.ok(parseAlertThresholds('{"drfit_total":1}').issues.length > 0);

  const metrics = {
    date: DAY,
    platform: '1688' as const,
    listed: 1,
    rejected: 2,
    approvals_pending: 3,
    approvals_oldest_minutes: 5,
    messages: 4,
    media_cost_cents: 500,
    media_cost_scope: 'global' as const,
    drift_total: 13,
    drift_by_kind: { price_mismatch: 2 },
  };
  assert.deepEqual(evaluateAlerts(metrics, null), []);
  assert.deepEqual(evaluateAlerts(metrics, { drift_total: 13 }).map((alert) => alert.metric), []);
  assert.deepEqual(evaluateAlerts(metrics, { drift_total: 12 }).map((alert) => alert.metric), ['drift_total']);
  assert.deepEqual(
    evaluateAlerts(metrics, { drift_by_kind: { price_mismatch: 1 } }).map((alert) => alert.metric),
    ['drift_by_kind.price_mismatch'],
  );
});

// ---------------------------------------------------------------- 单测：同步

test('同步游标：分页推进、断点续跑、状态查询', async () => {
  const store = new MemorySyncCursorStore();
  const service = new SyncService({ store, readers: createSyncReaders('recorded'), maxPages: 1 });
  const first = await service.run('1688', 'orders', { owner: 'worker-a' });
  assert.equal(first.pages, 1);
  assert.equal(first.stats.pulled, 3);
  assert.equal(first.cursor, 'ck-orders-1');
  const second = await service.run('1688', 'orders', { owner: 'worker-b' });
  assert.equal(second.resumed_from, 'ck-orders-1');
  assert.equal(second.stats.pulled, 2);
  assert.equal(second.cursor, 'ck-orders-2');
  const third = await service.run('1688', 'orders', { owner: 'worker-c' });
  assert.equal(third.stats.pulled, 0);
  const status = await service.status('1688', 3600);
  assert.equal(status.items[0]?.status, 'idle');
  assert.equal(status.items[0]?.cursor, 'ck-orders-2');
});

test('同步租约：同平台同 resource 并发跑返回 conflict', async () => {
  const store = new MemorySyncCursorStore();
  const service = new SyncService({ store, readers: createSyncReaders('recorded') });
  const row = await store.getOrCreate('1688', 'orders');
  assert.equal(await store.tryAcquire(row.id, 'other-worker', new Date(), 60_000), true);
  await assert.rejects(
    () => service.run('1688', 'orders', { owner: 'worker-a' }),
    (error: unknown) => error instanceof ApiError && error.code === 'conflict',
  );
});

test('同步失败：连续失败 5 次置 error；真实 reader 硬拒绝带 TODO', async () => {
  const store = new MemorySyncCursorStore();
  const service = new SyncService({ store, readers: { ...createSyncReaders('recorded'), orders: new AdapterSyncReader('orders') } });
  for (let attempt = 1; attempt <= MAX_CONSECUTIVE_FAILURES; attempt += 1) {
    await assert.rejects(
      () => service.run('1688', 'orders', { owner: `worker-${attempt}` }),
      (error: unknown) => error instanceof ApiError && error.code === 'publish_blocked',
    );
  }
  const rows = await store.list('1688');
  assert.equal(rows[0]?.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
  assert.equal(rows[0]?.status, 'error');

  await assert.rejects(
    () => new AdapterPlatformReader().read('1688', { day: DAY, now: new Date().toISOString() }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'publish_blocked');
      const detail = error.detail as { reason?: string; todo_ids?: string[] };
      assert.equal(detail.reason, 'adapter_contract_unverified');
      assert.ok((detail.todo_ids ?? []).some((id) => id.startsWith('TODO-1688-')));
      return true;
    },
  );
});

test('订单落库（内存 sink）：按 (platform, platform_order_id) 幂等', async () => {
  const sink = new MemoryOrderSink();
  const reader = createSyncReaders('recorded').orders;
  const page1 = await reader.read({ platform: '1688', resource: 'orders', cursor: null, since: null, pageSize: 100, pageIndex: 0 });
  const page2 = await reader.read({ platform: '1688', resource: 'orders', cursor: page1.nextCursor, since: null, pageSize: 100, pageIndex: 1 });
  const now = new Date('2026-10-20T02:00:00.000Z');
  const first = await sink.apply([...page1.items, ...page2.items], { platform: '1688', now });
  assert.deepEqual(first, { created: 5, updated: 0, skipped: 0 });
  const second = await sink.apply([...page1.items, ...page2.items], { platform: '1688', now });
  assert.deepEqual(second, { created: 0, updated: 0, skipped: 5 });
  assert.equal(sink.orders.size, 5);
});

test('buyer_ref 必须是 sha256 hex：明文买家信息被拒绝（隐私保护）', async () => {
  const sink = new MemoryOrderSink();
  await assert.rejects(
    () =>
      sink.apply(
        [
          {
            order_id: 'ALI-ORDER-BAD',
            status: 'paid',
            total_cents: 100,
            paid_cents: 100,
            buyer_ref: '张三 13800138000',
            platform_created_at: '2026-10-20T02:00:00.000Z',
            items: [{ platform_sku_ref: 'X', qty: 1, unit_price_cents: 100, amount_cents: 100 }],
          },
        ],
        { platform: '1688', now: new Date() },
      ),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
});

test('生产环境禁止 recorded 样本对账', () => {
  assert.throws(
    () => assertRecordedAllowed('production', 'recorded', '对账'),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
  assert.doesNotThrow(() => assertRecordedAllowed('test', 'recorded', '对账'));
  assert.doesNotThrow(() => assertRecordedAllowed('production', 'adapter', '对账'));
});

// ---------------------------------------------------------------- 集成 fixture

interface Fixture {
  app: FastifyInstance;
  admin: ReturnType<typeof sessionHeaders>;
  viewer: ReturnType<typeof sessionHeaders>;
  operator: ReturnType<typeof sessionHeaders>;
  dir: string;
  adminEmail: string;
  viewerEmail: string;
  operatorEmail: string;
}

let fixture!: Fixture;

async function seedOrder(
  platform: '1688' | 'pdd',
  platformOrderId: string,
  fields: { status: string; totalCents: number; paidCents: number; buyerRef: string },
  items: Array<{ platformSkuRef: string; qty: number; unitPriceCents: number; amountCents: number }>,
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      platform,
      platformOrderId,
      status: fields.status,
      totalCents: fields.totalCents,
      paidCents: fields.paidCents,
      buyerRef: fields.buyerRef.padEnd(64, '0').slice(0, 64),
      platformCreatedAt: new Date('2026-10-18T02:00:00.000Z'),
    },
  });
  for (const item of items) {
    await prisma.orderItem.create({
      data: {
        orderId: order.id,
        platformSkuRef: item.platformSkuRef,
        title: `测试明细 ${item.platformSkuRef}`,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        amountCents: item.amountCents,
      },
    });
  }
  return order.id;
}

async function seedAfterSale(
  platform: '1688' | 'pdd',
  platformAfterSaleId: string,
  orderId: string,
  status: string,
  amountCents: number,
): Promise<string> {
  const row = await prisma.afterSale.create({
    data: {
      platform,
      platformAfterSaleId,
      orderId,
      kind: 'refund_only',
      status,
      amountCents,
      openedAt: new Date('2026-10-19T06:00:00.000Z'),
    },
  });
  return row.id;
}

async function seedUsersAndData(app: FastifyInstance): Promise<Omit<Fixture, 'app' | 'dir'>> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const adminEmail = `t43-admin-${suffix}@example.com`;
  const viewerEmail = `t43-viewer-${suffix}@example.com`;
  const operatorEmail = `t43-operator-${suffix}@example.com`;
  await createUser({ email: adminEmail, password: PASSWORD, role: 'admin' });
  await createUser({ email: viewerEmail, password: PASSWORD, role: 'viewer' });
  await createUser({ email: operatorEmail, password: PASSWORD, role: 'operator' });

  const adminLogin = await login(app, adminEmail, PASSWORD);
  const viewerLogin = await login(app, viewerEmail, PASSWORD);
  const operatorLogin = await login(app, operatorEmail, PASSWORD);
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(viewerLogin.statusCode, 200);
  assert.equal(operatorLogin.statusCode, 200);

  // ---- 商品 ----
  const category = await prisma.platformCategory.create({
    data: {
      platform: '1688',
      externalCategoryId: `cat-${suffix}`,
      name: '测试类目（1688）',
      path: ['测试类目（1688）'],
      isLeaf: true,
      status: 'active',
    },
  });
  const listingSpecs: Array<[string, string, string, number, number]> = [
    ['ALI-2026-0001', 'published', 'ALI-SKU-0001', 15800, 480],
    ['ALI-2026-0002', 'published', 'ALI-SKU-0002', 15800, 120],
    ['ALI-2026-0003', 'published', 'ALI-SKU-0003', 15800, 88],
    ['ALI-2026-0004', 'published', 'ALI-SKU-0004', 15800, 200],
    ['ALI-2026-0005', 'published', 'ALI-SKU-0005', 15800, 200],
    ['ALI-2026-0007', 'published', 'ALI-SKU-0007', 15800, 10],
  ];
  for (const [itemId, status, skuId, priceCents, stockQty] of listingSpecs) {
    const product = await prisma.product.create({
      data: { spuCode: `SPU-${suffix}-${itemId.slice(-4)}`, name: `测试商品 ${itemId}`, categoryCode: 'A0202', status: 'active' },
    });
    await prisma.listing.create({
      data: {
        platform: '1688',
        productId: product.id,
        platformCategoryId: category.id,
        platformItemId: itemId,
        status,
        title: `测试商品 ${itemId}`,
        publishedAt: itemId === 'ALI-2026-0001' ? new Date() : null,
        skuBindings: [{ sku_id: null, platform_sku_id: skuId, price_cents: priceCents, stock_qty: stockQty }],
      },
    });
  }
  const rejectedProduct = await prisma.product.create({
    data: { spuCode: `SPU-${suffix}-REJ`, name: '驳回商品', categoryCode: 'A0202', status: 'active' },
  });
  await prisma.listing.create({
    data: { platform: '1688', productId: rejectedProduct.id, platformCategoryId: category.id, platformItemId: 'ALI-2026-REJ', status: 'rejected', rejectMeta: { code: 'QUALITY' } },
  });

  // ---- 订单 / 明细 / 售后（对应录制样本，构造 5+2 类差异） ----
  const order1001 = await seedOrder(
    '1688',
    'ALI-ORDER-1001',
    { status: 'paid', totalCents: 31600, paidCents: 31600, buyerRef: '1a2b3c' },
    [{ platformSkuRef: 'ALI-SKU-0001', qty: 2, unitPriceCents: 15800, amountCents: 31600 }],
  );
  await seedOrder(
    '1688',
    'ALI-ORDER-1002',
    { status: 'paid', totalCents: 9999, paidCents: 9999, buyerRef: '2b3c4d' },
    [{ platformSkuRef: 'ALI-SKU-0009', qty: 1, unitPriceCents: 9999, amountCents: 9999 }],
  );
  const order1004 = await seedOrder(
    '1688',
    'ALI-ORDER-1004',
    { status: 'paid', totalCents: 31600, paidCents: 31600, buyerRef: '7a8b9c' },
    [{ platformSkuRef: 'ALI-SKU-0002', qty: 2, unitPriceCents: 15000, amountCents: 30000 }],
  );
  const order1005 = await seedOrder(
    '1688',
    'ALI-ORDER-1005',
    { status: 'paid', totalCents: 15800, paidCents: 15800, buyerRef: 'abcdef' },
    [{ platformSkuRef: 'ALI-SKU-0003', qty: 1, unitPriceCents: 15800, amountCents: 15800 }],
  );
  await seedOrder(
    '1688',
    'ALI-ORDER-1006',
    { status: 'paid', totalCents: 31600, paidCents: 31600, buyerRef: '0f1e2d' },
    [{ platformSkuRef: 'ALI-SKU-0001', qty: 1, unitPriceCents: 31600, amountCents: 31600 }],
  );
  await seedAfterSale('1688', 'ALI-AS-9001', order1004, 'open', 4000);
  await seedAfterSale('1688', 'ALI-AS-9002', order1005, 'open', 15800);
  // 1005 有 open 售后 → refundStatus=refunding，与平台 refunded 不符

  // ---- 日报指标 ----
  await prisma.approval.create({
    data: {
      subjectType: 'listing',
      subjectId: order1001,
      action: 'publish',
      platform: '1688',
      operationLevel: 'B',
      status: 'pending',
      targetHash: 'a'.repeat(64),
      requestId: `req-${suffix}`,
    },
  });
  const conversation = await prisma.conversation.create({
    data: { platform: '1688', platformConversationId: `conv-${suffix}`, buyerRef: `buyer-${suffix}` },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'inbound', platform: '1688', content: '询价', status: 'received' },
  });
  await prisma.costLedger.create({
    data: { kind: 'media', refType: 'media_job', refId: uuidv7(), amountCents: 1234, seconds: '0.5' },
  });

  return {
    admin: sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin)),
    viewer: sessionHeaders(cookiesFrom(viewerLogin), csrfFrom(viewerLogin)),
    operator: sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin)),
    adminEmail,
    viewerEmail,
    operatorEmail,
  };
}

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-t43-'));
  const app = await buildTestApp({
    RECONCILE_STORE: 'postgres',
    RECONCILE_DIR: dir,
    DAILY_ALERT_THRESHOLDS: '{"drift_total":12}',
    SYNC_READER: 'recorded',
  });
  const partial = await seedUsersAndData(app);
  fixture = { app, dir, ...partial };
});

after(async () => {
  if (fixture?.app) await fixture.app.close();
  if (fixture?.dir) await rm(fixture.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 集成：对账（postgres）

test('POST /api/reconcile/1688（postgres）：13 条差异（商品6+订单5+售后2），同日重复 inserted=0/updated=13', async () => {
  const first = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, ...IDEM('rec-pg-1'), 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(first.statusCode, 200, first.body);
  const body = JSON.parse(first.body).data as {
    summary: { total: number; by_kind: Record<string, number> };
    persisted: { inserted: number; updated: number };
    drift: { inserted: number; updated: number; unchanged: number };
    store: string;
    store_note: string;
    snapshot: { source: string; verified: boolean; complete: boolean; orders_complete: boolean };
    checked: {
      orders: { checked: boolean; local_orders: number; platform_orders: number };
      after_sale: { checked: boolean; local_after_sales: number; platform_after_sales: number };
    };
    diffs: Array<{ kind: string; suggestion: { actions: unknown[] }; drift_key: string }>;
    items: Array<{
      drift_key: string;
      kind: string;
      severity: string;
      subject_ref: { type: string; platform_order_id: string | null };
      suggested_action: { level: string | null; kind: string };
      auto_fixable: boolean;
    }>;
  };
  assert.equal(body.store, 'postgres');
  assert.equal(body.store_note, 'RECONCILE_STORE=postgres（drift_log）');
  assert.equal(body.summary.total, 13);
  assert.equal(body.summary.by_kind.price_mismatch, 1);
  assert.equal(body.summary.by_kind.order_platform_only, 1);
  assert.equal(body.summary.by_kind.order_local_only, 1);
  assert.equal(body.summary.by_kind.order_amount_mismatch, 1);
  assert.equal(body.summary.by_kind.order_status_mismatch, 1);
  assert.equal(body.summary.by_kind.order_item_mismatch, 1);
  assert.equal(body.summary.by_kind.after_sale_amount_mismatch, 1);
  assert.equal(body.summary.by_kind.after_sale_status_mismatch, 1);
  assert.equal(body.checked.orders.checked, true);
  assert.equal(body.checked.orders.local_orders, 5);
  assert.equal(body.checked.orders.platform_orders, 5);
  assert.equal(body.checked.after_sale.checked, true);
  assert.equal(body.checked.after_sale.local_after_sales, 2);
  assert.equal(body.checked.after_sale.platform_after_sales, 2);
  assert.equal(body.snapshot.orders_complete, true);
  assert.equal(body.persisted.inserted, 13);
  assert.ok(body.diffs.every((drift) => Array.isArray(drift.suggestion.actions)));
  assert.equal(new Set(body.diffs.map((drift) => drift.drift_key)).size, 13);

  // docs/12 §3.11 契约视图：items[{drift_key,kind,severity,subject_ref,suggested_action,auto_fixable}]
  assert.equal(body.items.length, 13);
  assert.deepEqual(
    body.items.map((item) => item.drift_key).sort(),
    body.diffs.map((drift) => drift.drift_key).sort(),
  );
  assert.ok(body.items.every((item) => item.auto_fixable === false));
  assert.ok(body.items.every((item) => item.subject_ref && typeof item.subject_ref.type === 'string'));
  const orderOnlyItem = body.items.find((item) => item.kind === 'order_platform_only');
  assert.equal(orderOnlyItem?.subject_ref.type, 'order');
  assert.equal(orderOnlyItem?.subject_ref.platform_order_id, 'ALI-ORDER-1003');
  assert.deepEqual(orderOnlyItem?.suggested_action, { level: null, kind: 'manual' });
  assert.deepEqual(body.drift, { inserted: 13, updated: 0, unchanged: 0 });

  const dbRows = await prisma.$queryRawUnsafe<Array<{ kind: string; n: number }>>(
    `SELECT kind, count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL GROUP BY kind`,
    DAY,
  );
  assert.equal(dbRows.reduce((sum, row) => sum + row.n, 0), 13);
  assert.ok(dbRows.some((row) => row.kind === 'after_sale_status_mismatch'));

  const second = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, ...IDEM('rec-pg-2'), 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(second.statusCode, 200, second.body);
  const secondBody = JSON.parse(second.body).data as {
    persisted: { inserted: number; updated: number };
    summary: { total: number };
  };
  assert.equal(secondBody.summary.total, 13);
  assert.equal(secondBody.persisted.inserted, 0, '同日重复对账不得新增');
  assert.equal(secondBody.persisted.updated, 13);

  const count = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL`,
    DAY,
  );
  assert.equal(count[0]?.n, 13);
  const seen = await prisma.$queryRawUnsafe<Array<{ seen: string | null }>>(
    `SELECT detail->>'seen_count' AS seen FROM drift_log WHERE platform = '1688' AND day = $1::date AND kind = 'price_mismatch' LIMIT 1`,
    DAY,
  );
  assert.equal(seen[0]?.seen, '2');
});

test('POST /api/reconcile/1688（file，显式）：store=file、13 条、同日重复不新增', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-t43-file-'));
  const fileApp = await buildTestApp({
    RECONCILE_STORE: 'file',
    RECONCILE_DIR: dir,
    RECONCILE_READER: 'recorded',
  });
  try {
    const adminLogin = await login(fileApp, fixture.adminEmail, PASSWORD);
    assert.equal(adminLogin.statusCode, 200);
    const admin = sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin));

    const first = await fileApp.inject({
      method: 'POST',
      url: '/api/reconcile/1688',
      headers: { ...admin, ...IDEM('rec-file-1'), 'content-type': 'application/json' },
      payload: { day: DAY },
    });
    assert.equal(first.statusCode, 200, first.body);
    const firstBody = JSON.parse(first.body).data as { store: string; summary: { total: number }; persisted: { inserted: number } };
    assert.equal(firstBody.store, 'file');
    assert.equal(firstBody.summary.total, 13);
    assert.equal(firstBody.persisted.inserted, 13);

    const second = await fileApp.inject({
      method: 'POST',
      url: '/api/reconcile/1688',
      headers: { ...admin, ...IDEM('rec-file-2'), 'content-type': 'application/json' },
      payload: { day: DAY },
    });
    const secondBody = JSON.parse(second.body).data as { persisted: { inserted: number; updated: number } };
    assert.equal(secondBody.persisted.inserted, 0);
    assert.equal(secondBody.persisted.updated, 13);

    const file = JSON.parse(await readFile(path.join(dir, DAY, '1688.json'), 'utf8')) as {
      items: Array<{ seen_count: number; kind: string }>;
    };
    assert.equal(file.items.length, 13);
    assert.ok(file.items.every((item) => item.seen_count >= 2));
    assert.ok(file.items.some((item) => item.kind === 'order_item_mismatch'));
  } finally {
    await fileApp.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('POST /api/reconcile：viewer 403；缺 Idempotency-Key 422；adapter 模式硬拒绝 409', async () => {
  const forbidden = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.viewer, ...IDEM('rec-view'), 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(forbidden.statusCode, 403);

  const missingKey = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(missingKey.statusCode, 422, missingKey.body);

  const adapter = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, ...IDEM('rec-adapter'), 'content-type': 'application/json' },
    payload: { day: DAY, mode: 'adapter' },
  });
  assert.equal(adapter.statusCode, 409, adapter.body);
  const error = JSON.parse(adapter.body).error as { code: string; detail: { reason: string; todo_ids: string[] } };
  assert.equal(error.code, 'publish_blocked');
  assert.equal(error.detail.reason, 'adapter_contract_unverified');
});

// ---------------------------------------------------------------- 集成：同步落库

test('POST /api/sync/pdd orders：真实落库 orders+order_items，幂等（第二次 skipped=5）', async () => {
  const first = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-1'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  assert.equal(first.statusCode, 202, first.body);
  const body = JSON.parse(first.body).data as {
    pages: number;
    stats: { pulled: number; created: number; updated: number; skipped: number };
    cursor: string;
    dry_run: boolean;
  };
  assert.equal(body.pages, 2);
  assert.equal(body.stats.pulled, 5);
  assert.equal(body.stats.created, 5);
  assert.equal(body.cursor, 'ck-orders-2');
  assert.equal(body.dry_run, false, 'orders 有真实 sink，不得再标 dry_run=true');

  const orders = await prisma.order.findMany({
    where: { platform: 'pdd' },
    select: { id: true, platformOrderId: true, buyerRef: true },
  });
  assert.equal(orders.length, 5, '不得重复插入订单');
  assert.ok(orders.every((order) => /^[0-9a-f]{64}$/.test(order.buyerRef)), 'buyer_ref 必须 sha256 hex');
  const itemCount = await prisma.orderItem.count({ where: { orderId: { in: orders.map((order) => order.id) } } });
  assert.equal(itemCount, 5);

  const second = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-2'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  assert.equal(second.statusCode, 202, second.body);
  const secondBody = JSON.parse(second.body).data as { resumed_from: string; stats: { pulled: number; created: number; skipped: number } };
  assert.equal(secondBody.resumed_from, 'ck-orders-2');
  assert.equal(secondBody.stats.pulled, 0);
  assert.equal(secondBody.stats.created, 0);
  assert.equal(await prisma.order.count({ where: { platform: 'pdd' } }), 5);

  const status = await fixture.app.inject({
    method: 'GET',
    url: '/api/sync/status?platform=pdd',
    headers: { cookie: fixture.viewer.cookie },
  });
  assert.equal(status.statusCode, 200, status.body);
  const statusBody = JSON.parse(status.body).data as {
    store: string;
    items: Array<{ resource: string; status: string; cursor: string | null }>;
  };
  assert.equal(statusBody.store, 'postgres');
  assert.equal(statusBody.items.find((item) => item.resource === 'orders')?.cursor, 'ck-orders-2');
});

test('POST /api/sync/pdd stock：无 sink → 只推进游标，dry_run=true', async () => {
  const response = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-stock'), 'content-type': 'application/json' },
    payload: { resource: 'stock' },
  });
  assert.equal(response.statusCode, 202, response.body);
  const body = JSON.parse(response.body).data as {
    dry_run: boolean;
    stats: { pulled: number; created: number; updated: number; skipped: number };
    cursor: string;
  };
  assert.equal(body.dry_run, true, '未接 sink 的资源仍是干跑');
  assert.equal(body.stats.pulled, 2);
  assert.deepEqual(
    { created: body.stats.created, updated: body.stats.updated, skipped: body.stats.skipped },
    { created: 0, updated: 0, skipped: 0 },
  );
  assert.equal(body.cursor, 'ck-stock-1');
});

// ---------------------------------------------------------------- 集成：日报

test('GET /api/dashboard/daily：指标完整、差异数来自 drift_log（13）、阈值告警随响应', async () => {
  const response = await fixture.app.inject({
    method: 'GET',
    url: `/api/dashboard/daily?date=${DAY}&platform=1688`,
    headers: { cookie: fixture.viewer.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = JSON.parse(response.body).data as {
    metrics: {
      listed: number;
      rejected: number;
      approvals_pending: number;
      messages: number;
      media_cost_cents: number;
      drift_total: number;
      drift_by_kind: Record<string, number>;
    };
    alerts: Array<{ metric: string; threshold: number; value: number }>;
    thresholds_configured: boolean;
    drift_store: { name: string; note: string };
  };
  assert.ok(data.metrics.listed >= 1, '当日上架数（可能包含其他用例写入，按 >=1 断言）');
  assert.ok(data.metrics.rejected >= 1, '当日驳回数（可能包含其他用例写入，按 >=1 断言）');
  assert.ok(data.metrics.approvals_pending >= 1);
  assert.ok(data.metrics.messages >= 1);
  assert.ok(data.metrics.media_cost_cents >= 1234, '媒体成本为全局口径，可能包含其他用例写入');
  assert.equal(data.metrics.drift_total, 13);
  assert.equal(data.metrics.drift_by_kind.order_item_mismatch, 1);
  assert.equal(data.thresholds_configured, true);
  assert.equal(data.drift_store.name, 'postgres');
  assert.ok(data.alerts.some((alert) => alert.metric === 'drift_total' && alert.value === 13 && alert.threshold === 12));
});

test('日报组装 + 告警落库幂等：同日同指标只写一条 event_log', async () => {
  const store = new PgDriftStore(prisma);
  const report = await buildDailyReport({
    prisma,
    driftStore: store,
    driftStoreNote: 'postgres',
    day: DAY,
    platform: null,
    thresholds: { drift_total: 12 },
  });
  assert.equal(report.metrics.drift_total, 13);
  assert.ok(report.alerts.some((alert) => alert.metric === 'drift_total'));

  const first = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  const second = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  assert.equal(first.inserted + first.skipped, report.alerts.length);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, report.alerts.length);

  const alerts = await listAlerts(prisma, DAY);
  assert.ok(alerts.some((alert) => alert.metric === 'drift_total' && alert.level === 'P2'));
});

test('未配置阈值：日报只报事实、alerts 为空', async () => {
  const report = await buildDailyReport({
    prisma,
    driftStore: new PgDriftStore(prisma),
    driftStoreNote: 'postgres',
    day: DAY,
    platform: '1688',
    thresholds: null,
  });
  assert.equal(report.alerts.length, 0);
  assert.equal(report.thresholds_configured, false);
  assert.equal(report.metrics.drift_total, 13);
});

test('日报指标：平台过滤与成本口径（global）', async () => {
  const metrics = await collectDailyMetrics({
    prisma,
    driftStore: new PgDriftStore(prisma),
    day: DAY,
    platform: '1688',
  });
  assert.equal(metrics.platform, '1688');
  assert.equal(metrics.media_cost_scope, 'global');
  assert.ok(metrics.media_cost_cents >= 1234);
  assert.ok(metrics.listed >= 1);
});

test('Prisma 游标存储：真实 sync_cursor 行可创建、抢占、checkpoint、失败计数', async () => {
  const store = new PrismaSyncCursorStore(prisma);
  const row = await store.getOrCreate('1688', 'stock');
  const now = new Date();
  assert.equal(await store.tryAcquire(row.id, 'test-worker', now, 60_000), true);
  assert.equal(await store.tryAcquire(row.id, 'another-worker', now, 60_000), false);
  const checkpoint = await store.checkpoint(row.id, { cursor: 'ck-stock-1', watermarkAt: now, stats: { pulled: 2 } }, now);
  assert.equal(checkpoint.cursor, 'ck-stock-1');
  assert.equal(checkpoint.consecutiveFailures, 0);
  const failed = await store.recordFailure(row.id, { errorCode: 'upstream_5xx' }, now);
  assert.equal(failed.consecutiveFailures, 1);
  await store.release(row.id);
});
