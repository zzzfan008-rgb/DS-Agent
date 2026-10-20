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
import { evaluateAlerts, parseAlertThresholds, criticalThresholdStatus, REQUIRED_ALERT_KINDS } from '../src/daily/thresholds.js';
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
import { MemoryAfterSaleSink, replayPendingAfterSales } from '../src/sync/after-sale-sink.js';
import { SyncService } from '../src/sync/service.js';
import { todayBusinessDay, addDays } from '../src/lib/day.js';
import { uuidv7 } from '../src/lib/ids.js';
import { ApiError } from '../src/lib/errors.js';
import { assertRecordedAllowed } from '../src/lib/adapter-refusal.js';
import type {
  DetectedDrift,
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

test('售后差异：退款金额不符 / 平台已关闭本地仍 open / 平台有本地无（D12）3 类各一条', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffAfterSales(LOCAL_AFTER_SALES, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  assert.deepEqual(drifts.map((drift) => drift.kind).sort(), [
    'after_sale_amount_mismatch',
    'after_sale_platform_only',
    'after_sale_status_mismatch',
  ]);
  const status = drifts.find((drift) => drift.kind === 'after_sale_status_mismatch');
  assert.match(status!.detail, /平台已关闭，本地仍 open/);
  assert.equal(status?.severity, 'high');

  // D12：平台有 ALI-AS-9003，本地完全没有 → 报 high + manual，local 为 null
  const platformOnly = drifts.find((drift) => drift.kind === 'after_sale_platform_only');
  assert.equal(platformOnly?.subject.platform_after_sale_id, 'ALI-AS-9003');
  assert.equal(platformOnly?.subject.platform_order_id, 'ALI-ORDER-1003');
  assert.equal(platformOnly?.severity, 'high');
  assert.equal(platformOnly?.local, null);
  assert.deepEqual(platformOnly?.suggested_action, { level: 'B', kind: 'manual' });
  assert.match(platformOnly!.detail, /没有任何记录/);
  assert.match(platformOnly!.detail, /绕过系统退款/);

  // 本地有同 id 的售后单（9001/9002）只报金额/状态差异，不重复报"本地无"
  const reportedIds = drifts
    .filter((drift) => drift.kind === 'after_sale_platform_only')
    .map((drift) => drift.subject.platform_after_sale_id);
  assert.deepEqual(reportedIds, ['ALI-AS-9003']);

  for (const drift of drifts) {
    assert.equal(drift.suggestion.auto_fixable, false);
    assert.equal(drift.subject.type, 'after_sale');
    assert.equal(drift.key_version, 2);
  }
});

test('D12 三种情形：平台有本地无 → 报；平台有本地有但金额不同 → 只报金额；一致 → 不报', async () => {
  const snapshot = await recordedSnapshot();
  const options = { platform: '1688' as const, day: DAY, now: '2026-10-20T02:30:00.000Z' };

  // ① 平台有、本地无（9003 本地没有任何记录）
  const onlyPlatform = diffAfterSales(LOCAL_AFTER_SALES, snapshot, options);
  assert.deepEqual(
    onlyPlatform.filter((drift) => drift.kind === 'after_sale_platform_only').map((drift) => drift.subject.platform_after_sale_id),
    ['ALI-AS-9003'],
  );

  // ② 平台有、本地有但金额不同（9001）：只报 amount，不报 platform_only
  const localWithMismatch = [{ ...LOCAL_AFTER_SALES[0]!, amountCents: 4000 }];
  const mismatch = diffAfterSales(localWithMismatch, snapshot, options);
  const kindsFor9001 = mismatch
    .filter((drift) => drift.subject.platform_after_sale_id === 'ALI-AS-9001')
    .map((drift) => drift.kind)
    .sort();
  assert.deepEqual(kindsFor9001, ['after_sale_amount_mismatch']);

  // ③ 两边都有且完全一致 → 该售后单零差异（9002 平台 closed / 本地也 closed / 金额同）
  const allConsistent = [
    { afterSaleId: 'l-9001', platformAfterSaleId: 'ALI-AS-9001', platformOrderId: 'ALI-ORDER-1004', status: 'open', amountCents: 5000 },
    { afterSaleId: 'l-9002', platformAfterSaleId: 'ALI-AS-9002', platformOrderId: 'ALI-ORDER-1005', status: 'closed', amountCents: 15800 },
    { afterSaleId: 'l-9003', platformAfterSaleId: 'ALI-AS-9003', platformOrderId: 'ALI-ORDER-1003', status: 'refunding', amountCents: 15800 },
  ];
  assert.deepEqual(diffAfterSales(allConsistent, snapshot, options), []);
});

test('全维度对账：商品 6 + 订单 5 + 售后 3 = 14 条，drift_key 唯一', async () => {
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
  assert.equal(drifts.length, 14);
  assert.equal(new Set(drifts.map((drift) => drift.drift_key)).size, 14);
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
    after_sale_platform_only: 1,
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

test('suggested_action：14 类差异都带 {level,kind}，级别取最重的写/人工动作', async () => {
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
    // 售后维度：退款金额涉及资金 → C 级人工；状态 B 级人工；平台独有 → 人工核对同步/绕过系统
    after_sale_amount_mismatch: { level: 'C', kind: 'manual' },
    after_sale_status_mismatch: { level: 'B', kind: 'manual' },
    after_sale_platform_only: { level: 'B', kind: 'manual' },
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

test('不完整快照：跳过“本地有平台无”的推断（商品/订单/售后），避免样本不全误报', async () => {
  const incomplete: PlatformSnapshot = {
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
    assert.equal(row!.key_version, 2, 'detail->>key_version 必须写当前版本');
    assert.equal(row!.seen_count, 2);
    assert.equal(row!.first_detected_at, row!.detected_at);
    assert.equal(await store.count(day, '1688', 'price_mismatch'), 1);
    assert.equal((await store.countByKind(day, '1688')).price_mismatch, 1);
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM drift_log WHERE day = $1::date AND platform = '1688'`, day);
  }
});

test('D13：旧 key_version 行保留但不参与统计；切版本零风险（无需人工清理）', async () => {
  const store = new PgDriftStore(prisma);
  const snapshot = await recordedSnapshot();
  const day = addDays(DAY, 2);
  const detected = diffSnapshots(LOCAL_LISTINGS, snapshot, { platform: '1688', day, now: '2026-10-22T02:30:00.000Z' });
  const v2Count = detected.length;
  try {
    await store.upsert('1688', day, detected);
    assert.equal(await store.count(day, '1688'), v2Count);

    // 手工插入一条 v1 行（模拟切换前遗留）：不同 drift_key，detail 里没有 key_version。
    const legacyKey = `dk_${'1'.repeat(32)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO drift_log (id, org_id, platform, day, drift_key, kind, severity, detail, detected_at)
       VALUES (gen_random_uuid(), 1, '1688', $1::date, $2, 'price_mismatch', 'medium',
               '{"text":"v1 遗留行","status":"open","seen_count":1,"first_detected_at":"2026-10-22T00:00:00.000Z","last_detected_at":"2026-10-22T00:00:00.000Z"}'::jsonb,
               '2026-10-22T00:00:00.000Z'::timestamptz)`,
      day,
      legacyKey,
    );

    // 统计只计当前版本 → v1 行被排除，总数不变。
    assert.equal(await store.count(day, '1688'), v2Count, 'v1 行不得计入统计');
    assert.equal((await store.countByKind(day, '1688')).price_mismatch, 1, 'v1 行的 kind 不得计入');
    const listed = await store.list(day, '1688');
    assert.equal(listed.length, v2Count);
    assert.ok(listed.every((row) => row.key_version === 2));

    // 库里两版共存（v1 没被删），证明"保留但不参与"而不是"删掉"。
    const physical = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL`,
      day,
    );
    assert.equal(physical[0]?.n, v2Count + 1, 'v1 行必须仍在表里（不删）');

    // 同日重跑：只更新 v2 行，不因 v1 存在而多出行。
    const again = await store.upsert('1688', day, detected);
    assert.equal(again.inserted, 0);
    assert.equal(await store.count(day, '1688'), v2Count);
    const after = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL`,
      day,
    );
    assert.equal(after[0]?.n, v2Count + 1, '重跑不得新增行');
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM drift_log WHERE day = $1::date AND platform = '1688'`, day);
  }
});

test('D13：内存/文件存储同样只统计当前 key_version', async () => {
  const snapshot = await recordedSnapshot();
  const detected = diffSnapshots(LOCAL_LISTINGS, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-drift-keyver-'));
  try {
    for (const store of [new MemoryDriftStore(), new FileDriftStore(dir)]) {
      await store.upsert('1688', DAY, detected);
      const current = detected.length;
      assert.equal(await store.count(DAY, '1688'), current);
      // 混入一条 v1 记录：list/count 都只取当前版本。
      const legacy: DetectedDrift = {
        ...detected[0]!,
        drift_key: `dk_${'2'.repeat(32)}`,
        key_version: 1,
      };
      await store.upsert('1688', DAY, [legacy]);
      assert.equal(await store.count(DAY, '1688'), current, `${store.name}: v1 行不得计入统计`);
      const rows = await store.list(DAY, '1688');
      assert.ok(rows.every((row) => row.key_version === 2), `${store.name}: list 只返回当前版本`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
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

test('t49 告警：drift_by_kind 的 key 必须是已知差异类型（拼错 = 配了等于没配）', () => {
  // 拼错 kind：必须 fail fast，不能静默忽略
  const typo = parseAlertThresholds('{"drift_by_kind":{"after_sale_platform_onyl":0}}');
  assert.equal(typo.thresholds, null);
  assert.ok(typo.issues.length > 0);
  assert.match(typo.issues[0]!, /未知差异类型/);
  assert.match(typo.issues[0]!, /after_sale_platform_only/, '错误信息要列出合法值，便于纠正');

  // 正确 kind 通过
  const ok = parseAlertThresholds('{"drift_by_kind":{"after_sale_platform_only":0}}');
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.thresholds?.drift_by_kind?.after_sale_platform_only, 0);

  // 未知顶层键仍然报错（原有行为不变）
  assert.ok(parseAlertThresholds('{"drift_by_kindd":{}}').issues.length > 0);
});

test('t49 告警：after_sale_platform_only 阈值 0 = 出现即告警；未配置则不告警', () => {
  const metrics = {
    date: DAY,
    platform: '1688' as const,
    listed: 1,
    rejected: 0,
    approvals_pending: 0,
    approvals_oldest_minutes: null,
    messages: 0,
    media_cost_cents: 0,
    media_cost_scope: 'global' as const,
    drift_total: 14,
    drift_by_kind: { after_sale_platform_only: 1 },
  };
  // 出现 1 条 → 阈值 0 触发
  const alerts = evaluateAlerts(metrics, { drift_by_kind: { after_sale_platform_only: 0 } });
  assert.deepEqual(alerts.map((alert) => alert.metric), ['drift_by_kind.after_sale_platform_only']);
  assert.equal(alerts[0]!.value, 1);
  assert.equal(alerts[0]!.threshold, 0);
  assert.equal(alerts[0]!.level, 'P2');
  assert.match(alerts[0]!.message, /after_sale_platform_only/);

  // 未配置 → 只报事实、不告警
  assert.deepEqual(evaluateAlerts(metrics, null), []);
  assert.deepEqual(evaluateAlerts(metrics, { drift_total: 20 }), []);

  // 0 条 → 不触发（value <= threshold）
  assert.deepEqual(
    evaluateAlerts({ ...metrics, drift_by_kind: {} }, { drift_by_kind: { after_sale_platform_only: 0 } }),
    [],
  );
});

test('t49 告警：criticalThresholdStatus 显式回报关键类型是否已配', () => {
  assert.deepEqual(criticalThresholdStatus(null), [
    {
      kind: 'after_sale_platform_only',
      configured: false,
      threshold: null,
      recommended: 0,
      reason: '平台有退款、本地零记录：可能是同步失败或绕过系统退款，必须出现即告警',
    },
  ]);
  const configured = criticalThresholdStatus({ drift_by_kind: { after_sale_platform_only: 0 } });
  assert.equal(configured[0]!.configured, true);
  assert.equal(configured[0]!.threshold, 0);
  assert.deepEqual(REQUIRED_ALERT_KINDS, ['after_sale_platform_only']);
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

test('售后落库（内存 sink）：按 (platform, platform_after_sale_id) 幂等；缺订单计入 pending 不丢', async () => {
  const sink = new MemoryAfterSaleSink();
  // 只认识 1004/1005 两笔订单；9004 挂的 9999 不存在。
  sink.knownOrders.add('ALI-ORDER-1004');
  sink.knownOrders.add('ALI-ORDER-1005');
  const reader = createSyncReaders('recorded').after_sale;
  const page = await reader.read({
    platform: '1688',
    resource: 'after_sale',
    cursor: null,
    since: null,
    pageSize: 100,
    pageIndex: 0,
  });
  const now = new Date('2026-10-20T02:00:00.000Z');

  const first = await sink.apply(page.items, { platform: '1688', now });
  assert.deepEqual(
    { created: first.created, updated: first.updated, skipped: first.skipped },
    { created: 2, updated: 0, skipped: 0 },
  );
  assert.equal(first.pending, 1, '缺订单的售后必须计入 pending');
  assert.deepEqual(first.pending_reasons, { order_missing: 1 });

  const second = await sink.apply(page.items, { platform: '1688', now });
  assert.deepEqual(
    { created: second.created, updated: second.updated, skipped: second.skipped },
    { created: 0, updated: 0, skipped: 2 },
  );
  assert.equal(sink.rows.size, 2, '缺订单的那条不得写入');
});

test('售后 sink 数据校验：未知 kind / 负金额被拒（DB CHECK 对齐）', async () => {
  const sink = new MemoryAfterSaleSink();
  sink.knownOrders.add('ALI-ORDER-1004');
  await assert.rejects(
    () =>
      sink.apply(
        [
          {
            after_sale_id: 'ALI-AS-BAD',
            order_id: 'ALI-ORDER-1004',
            kind: 'chargeback',
            status: 'open',
            amount_cents: 100,
            opened_at: '2026-10-19T06:00:00.000Z',
          },
        ],
        { platform: '1688', now: new Date() },
      ),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
  await assert.rejects(
    () =>
      sink.apply(
        [
          {
            after_sale_id: 'ALI-AS-BAD2',
            order_id: 'ALI-ORDER-1004',
            kind: 'refund_only',
            status: 'open',
            amount_cents: -1,
            opened_at: '2026-10-19T06:00:00.000Z',
          },
        ],
        { platform: '1688', now: new Date() },
      ),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
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

test('POST /api/reconcile/1688（postgres）：14 条差异（商品6+订单5+售后3），同日重复 inserted=0/updated=14', async () => {
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
    key_version: number;
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
  assert.equal(body.summary.total, 14);
  assert.equal(body.summary.by_kind.price_mismatch, 1);
  assert.equal(body.summary.by_kind.order_platform_only, 1);
  assert.equal(body.summary.by_kind.order_local_only, 1);
  assert.equal(body.summary.by_kind.order_amount_mismatch, 1);
  assert.equal(body.summary.by_kind.order_status_mismatch, 1);
  assert.equal(body.summary.by_kind.order_item_mismatch, 1);
  assert.equal(body.summary.by_kind.after_sale_amount_mismatch, 1);
  assert.equal(body.summary.by_kind.after_sale_status_mismatch, 1);
  assert.equal(body.summary.by_kind.after_sale_platform_only, 1, 'D12：平台有本地无的售后必须报');
  assert.equal(body.key_version, 2, 'D13：响应必须声明当前 key_version');
  assert.equal(body.checked.orders.checked, true);
  assert.equal(body.checked.orders.local_orders, 5);
  assert.equal(body.checked.orders.platform_orders, 5);
  assert.equal(body.checked.after_sale.checked, true);
  assert.equal(body.checked.after_sale.local_after_sales, 2);
  assert.equal(body.checked.after_sale.platform_after_sales, 3);
  assert.equal(body.snapshot.orders_complete, true);
  assert.equal(body.persisted.inserted, 14);
  assert.ok(body.diffs.every((drift) => Array.isArray(drift.suggestion.actions)));
  assert.equal(new Set(body.diffs.map((drift) => drift.drift_key)).size, 14);

  // docs/12 §3.11 契约视图：items[{drift_key,kind,severity,subject_ref,suggested_action,auto_fixable}]
  assert.equal(body.items.length, 14);
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
  assert.deepEqual(body.drift, { inserted: 14, updated: 0, unchanged: 0 });

  const dbRows = await prisma.$queryRawUnsafe<Array<{ kind: string; n: number }>>(
    `SELECT kind, count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL GROUP BY kind`,
    DAY,
  );
  assert.equal(dbRows.reduce((sum, row) => sum + row.n, 0), 14);
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
  assert.equal(secondBody.summary.total, 14);
  assert.equal(secondBody.persisted.inserted, 0, '同日重复对账不得新增');
  assert.equal(secondBody.persisted.updated, 14);

  const count = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM drift_log WHERE platform = '1688' AND day = $1::date AND archived_at IS NULL`,
    DAY,
  );
  assert.equal(count[0]?.n, 14);
  const seen = await prisma.$queryRawUnsafe<Array<{ seen: string | null }>>(
    `SELECT detail->>'seen_count' AS seen FROM drift_log WHERE platform = '1688' AND day = $1::date AND kind = 'price_mismatch' LIMIT 1`,
    DAY,
  );
  assert.equal(seen[0]?.seen, '2');
});

test('POST /api/reconcile/1688（file，显式）：store=file、14 条、同日重复不新增', async () => {
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
    assert.equal(firstBody.summary.total, 14);
    assert.equal(firstBody.persisted.inserted, 14);

    const second = await fileApp.inject({
      method: 'POST',
      url: '/api/reconcile/1688',
      headers: { ...admin, ...IDEM('rec-file-2'), 'content-type': 'application/json' },
      payload: { day: DAY },
    });
    const secondBody = JSON.parse(second.body).data as { persisted: { inserted: number; updated: number } };
    assert.equal(secondBody.persisted.inserted, 0);
    assert.equal(secondBody.persisted.updated, 14);

    const file = JSON.parse(await readFile(path.join(dir, DAY, '1688.json'), 'utf8')) as {
      items: Array<{ seen_count: number; kind: string }>;
    };
    assert.equal(file.items.length, 14);
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

test('POST /api/sync/pdd after_sale：真实落库 after_sale，幂等；缺订单的售后计入 pending 不丢', async () => {
  // 本用例要验证「售后先到、订单后到」的真实时序，所以先把 pdd 的售后/订单/游标清干净，
  // 避免受前面用例（已经同步过 pdd 订单）影响 —— 那种情况下 created=0，按设计不会触发重放。
  await prisma.afterSale.deleteMany({ where: { platform: 'pdd' } });
  const staleOrders = await prisma.order.findMany({ where: { platform: 'pdd' }, select: { id: true } });
  if (staleOrders.length > 0) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: staleOrders.map((row) => row.id) } } });
    await prisma.order.deleteMany({ where: { id: { in: staleOrders.map((row) => row.id) } } });
  }
  await prisma.syncCursor.deleteMany({ where: { platform: 'pdd' } });

  // 第一步：售后先到，本地还没有订单 → 全部 pending（真实走 after_sale sink）
  const first = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-as-1'), 'content-type': 'application/json' },
    payload: { resource: 'after_sale' },
  });
  assert.equal(first.statusCode, 202, first.body);
  const body = JSON.parse(first.body).data as {
    dry_run: boolean;
    pages: number;
    stats: {
      pulled: number;
      created: number;
      updated: number;
      skipped: number;
      pending: number;
      pending_reasons: Record<string, number>;
    };
    cursor: string;
  };
  assert.equal(body.dry_run, false, 'after_sale 已有 sink，不得再标 dry_run');
  assert.equal(body.pages, 1);
  assert.equal(body.stats.pulled, 3);
  assert.equal(body.stats.created, 0, '订单还没到，一笔都落不了库');
  assert.equal(body.stats.pending, 3, '三笔售后全部 pending');
  assert.deepEqual(body.stats.pending_reasons, { order_missing: 3 });
  assert.equal(body.cursor, 'ck-aftersale-1');

  // 第二步：订单后到 → t50 自动重放，救回 9001/9002；9004 的订单不存在，保持 pending
  const ordersSync = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-as-orders'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  assert.equal(ordersSync.statusCode, 202, ordersSync.body);
  const ordersBody = JSON.parse(ordersSync.body).data as {
    after_sale_retry?: { created: number; pending: number; skipped: number };
  };
  assert.ok(ordersBody.after_sale_retry, 'orders 写入新订单后必须自动触发 pending 重放');
  assert.equal(ordersBody.after_sale_retry!.created, 2, '重放直接救回两笔有订单的售后');
  assert.equal(ordersBody.after_sale_retry!.pending, 1, '缺订单的那笔仍 pending');

  const rows = await prisma.afterSale.findMany({
    where: { platform: 'pdd' },
    select: { platformAfterSaleId: true, orderId: true, kind: true, status: true, amountCents: true, reason: true, closedAt: true },
  });
  assert.equal(rows.length, 2, '缺订单的售后不得落库');
  const byId = new Map(rows.map((row) => [row.platformAfterSaleId, row]));
  const closed = byId.get('ALI-AS-9002');
  assert.equal(closed?.status, 'closed');
  assert.equal(closed?.amountCents, 15800);
  assert.equal(closed?.kind, 'return_refund');
  assert.ok(closed?.closedAt, 'closed 状态必须带 closed_at');
  assert.equal(closed?.reason, '面料与描述不符，退货退款');
  const open = byId.get('ALI-AS-9001');
  assert.equal(open?.status, 'open');
  assert.equal(open?.closedAt, null, 'open 状态不得有 closed_at');

  // 幂等：第二次全 skipped，pending 仍为 1（缺订单那条还在 pending）。
  const second = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-as-2'), 'content-type': 'application/json' },
    payload: { resource: 'after_sale' },
  });
  assert.equal(second.statusCode, 202, second.body);
  const secondBody = JSON.parse(second.body).data as {
    resumed_from: string;
    stats: { pulled: number; created: number; skipped: number; pending: number };
  };
  assert.equal(secondBody.resumed_from, 'ck-aftersale-1');
  assert.equal(secondBody.stats.pulled, 0);
  assert.equal(secondBody.stats.created, 0);
  assert.equal(await prisma.afterSale.count({ where: { platform: 'pdd' } }), 2, '不得重复插入售后');
});

test('同步落库后 after_sale_platform_only 不再误报：本地有记录 → 只比字段，不报「本地无」', async () => {
  // 同步 pdd 的售后（9001/9002 有订单 → 落库；9004 缺订单 → pending）
  await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-as-noresp-orders'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/pdd',
    headers: { ...fixture.operator, ...IDEM('sync-as-noresp'), 'content-type': 'application/json' },
    payload: { resource: 'after_sale' },
  });

  // 从真实表读回本地售后快照（与 ReconcileService.loadLocalAfterSales 同口径）
  const rows = await prisma.afterSale.findMany({
    where: { platform: 'pdd', archivedAt: null },
    select: { id: true, platformAfterSaleId: true, orderId: true, status: true, amountCents: true },
  });
  const orderIds = [...new Set(rows.map((row) => row.orderId))];
  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, platformOrderId: true },
  });
  const platformOrderByLocalId = new Map(orders.map((order) => [order.id, order.platformOrderId]));
  const localAfterSales: LocalAfterSaleSnapshot[] = rows
    .map((row) => {
      const platformOrderId = platformOrderByLocalId.get(row.orderId);
      if (!platformOrderId) return null;
      return {
        afterSaleId: row.id,
        platformAfterSaleId: row.platformAfterSaleId,
        platformOrderId,
        status: row.status,
        amountCents: row.amountCents,
      } satisfies LocalAfterSaleSnapshot;
    })
    .filter((row): row is LocalAfterSaleSnapshot => row !== null);

  // 平台快照：9001/9002 与本地一致（金额/状态同），9004 本地没有。
  const snapshot: PlatformSnapshot = {
    platform: 'pdd',
    capturedAt: '2026-10-20T02:00:00.000Z',
    source: 'recorded',
    verified: false,
    complete: false,
    ordersComplete: false,
    afterSalesComplete: false,
    note: '同步后回归：验证已落库的售后不再被报「本地无」',
    items: [],
    orders: [],
    afterSales: [
      { platformAfterSaleId: 'ALI-AS-9001', platformOrderId: 'ALI-ORDER-1004', kind: 'refund_only', status: 'open', amountCents: 5000 },
      { platformAfterSaleId: 'ALI-AS-9002', platformOrderId: 'ALI-ORDER-1005', kind: 'return_refund', status: 'closed', amountCents: 15800 },
      { platformAfterSaleId: 'ALI-AS-9004', platformOrderId: 'ALI-ORDER-9999', kind: 'refund_only', status: 'refunding', amountCents: 8000 },
    ],
  };
  const drifts = diffAfterSales(localAfterSales, snapshot, {
    platform: 'pdd',
    day: DAY,
    now: '2026-10-20T02:30:00.000Z',
  });

  // 已同步的两条：字段一致 → 零差异（不再误报"本地无"）。
  const reportedIds = drifts.map((drift) => drift.subject.platform_after_sale_id).sort();
  assert.deepEqual(reportedIds, ['ALI-AS-9004'], '只有真正缺本地记录的 9004 该报');
  const only = drifts[0]!;
  assert.equal(only.kind, 'after_sale_platform_only');
  assert.equal(only.severity, 'high');
  assert.equal(only.local, null);
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

// ---------------------------------------------------------------- t50：orders 后到自动重放

test('t50 ①：售后先到、订单后到 → 订单同步后售后自动落库，pending 清零', async () => {
  const sink = new MemoryAfterSaleSink();
  const orderSink = new MemoryOrderSink();
  const readers = createSyncReaders('recorded');
  let replayCalls = 0;
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: orderSink, after_sale: sink },
    replayPendingAfterOrders: async (platform, ctx) => {
      replayCalls += 1;
      // 内存版：把已落库订单同步进 after_sale sink 的 knownOrders（模拟 Prisma 版查 orders 表）
      for (const order of orderSink.orders.values()) sink.knownOrders.add(order.order_id);
      const outcome = await replayPendingAfterSales(readers.after_sale, sink, platform, ctx.now);
      return {
        created: outcome.created,
        updated: outcome.updated,
        skipped: outcome.skipped,
        pending: outcome.pending,
        degraded: outcome.degraded,
      };
    },
  });

  // 第一步：售后先到，本地还没有任何订单 → 3 笔全部 pending
  const firstAfterSale = await service.run('1688', 'after_sale', { owner: 'w1' });
  assert.equal(firstAfterSale.stats.created, 0);
  assert.equal(firstAfterSale.stats.pending, 3);
  assert.equal(sink.rows.size, 0);

  // 第二步：订单后到 → 自动重放，命中 1004/1005 两笔
  const orders = await service.run('1688', 'orders', { owner: 'w2' });
  assert.equal(replayCalls, 1, 'orders 写入新订单后必须自动触发一次重放');
  assert.equal(orders.after_sale_retry?.created, 2, '重放救回两笔有订单的售后');
  assert.equal(orders.after_sale_retry?.pending, 1, '9004 的订单仍不存在，保持 pending');
  assert.equal(sink.rows.size, 2);
  assert.ok(sink.rows.has('1688|ALI-AS-9001'));
  assert.ok(sink.rows.has('1688|ALI-AS-9002'));
  assert.ok(!sink.rows.has('1688|ALI-AS-9004'));
});

test('t50 ②：售后先到、订单永不到 → 保持 pending，after_sale_platform_only 持续报差异', async () => {
  const sink = new MemoryAfterSaleSink();
  const orderSink = new MemoryOrderSink();
  const readers = createSyncReaders('recorded');
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: orderSink, after_sale: sink },
    replayPendingAfterOrders: async (platform, ctx) => {
      for (const order of orderSink.orders.values()) sink.knownOrders.add(order.order_id);
      const outcome = await replayPendingAfterSales(readers.after_sale, sink, platform, ctx.now);
      return {
        created: outcome.created,
        updated: outcome.updated,
        skipped: outcome.skipped,
        pending: outcome.pending,
        degraded: outcome.degraded,
      };
    },
  });

  await service.run('1688', 'after_sale', { owner: 'w1' });
  const orders = await service.run('1688', 'orders', { owner: 'w2' });
  // 重放跑了，但 9004 的订单（ALI-ORDER-9999）永远不在录制订单里
  assert.equal(orders.after_sale_retry?.pending, 1);
  assert.ok(!sink.rows.has('1688|ALI-AS-9004'));

  // 对账仍然报它（本地无记录）—— 风险不会因为 pending 而消失
  const localAfterSales: LocalAfterSaleSnapshot[] = [...sink.rows.values()]
    .filter((row): row is typeof row & { orderId: string } => row.orderId !== null)
    .map((row) => ({
      afterSaleId: `local-${row.after_sale_id}`,
      platformAfterSaleId: row.after_sale_id,
      platformOrderId: row.orderId,
      status: row.status,
      amountCents: row.amount_cents,
    }));
  // 注意：sync reader 的售后是 9001/9002/9004（9004 挂 ALI-ORDER-9999）；
  // reconcile 录制样本是 9001/9002/9003（9003 挂 ALI-ORDER-1003）。
  // 这里用 sync reader 的平台快照来对齐 9004，验证"订单永不到 → 持续报"。
  const syncSnapshot: PlatformSnapshot = {
    platform: '1688',
    capturedAt: '2026-10-20T02:00:00.000Z',
    source: 'recorded',
    verified: false,
    complete: false,
    ordersComplete: false,
    afterSalesComplete: false,
    note: 't50 ②：用 sync reader 的售后集验证 pending 持续可见',
    items: [],
    orders: [],
    afterSales: [
      { platformAfterSaleId: 'ALI-AS-9001', platformOrderId: 'ALI-ORDER-1004', kind: 'refund_only', status: 'open', amountCents: 5000 },
      { platformAfterSaleId: 'ALI-AS-9002', platformOrderId: 'ALI-ORDER-1005', kind: 'return_refund', status: 'closed', amountCents: 15800 },
      { platformAfterSaleId: 'ALI-AS-9004', platformOrderId: 'ALI-ORDER-9999', kind: 'refund_only', status: 'refunding', amountCents: 8000 },
    ],
  };
  const drifts = diffAfterSales(localAfterSales, syncSnapshot, {
    platform: '1688',
    day: DAY,
    now: '2026-10-20T02:30:00.000Z',
  });
  assert.deepEqual(
    drifts.map((drift) => drift.subject.platform_after_sale_id),
    ['ALI-AS-9004'],
    '订单永不到时，after_sale_platform_only 必须持续报',
  );
  assert.equal(drifts[0]!.kind, 'after_sale_platform_only');
  assert.equal(drifts[0]!.severity, 'high');
});

test('t50 ③：重复触发幂等 —— 不重复落库、pending 不变', async () => {
  const sink = new MemoryAfterSaleSink();
  const orderSink = new MemoryOrderSink();
  const readers = createSyncReaders('recorded');
  let replayCalls = 0;
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: orderSink, after_sale: sink },
    replayPendingAfterOrders: async (platform, ctx) => {
      replayCalls += 1;
      for (const order of orderSink.orders.values()) sink.knownOrders.add(order.order_id);
      const outcome = await replayPendingAfterSales(readers.after_sale, sink, platform, ctx.now);
      return {
        created: outcome.created,
        updated: outcome.updated,
        skipped: outcome.skipped,
        pending: outcome.pending,
        degraded: outcome.degraded,
      };
    },
  });

  await service.run('1688', 'after_sale', { owner: 'w1' });
  const firstOrders = await service.run('1688', 'orders', { owner: 'w2' });
  assert.equal(firstOrders.after_sale_retry?.created, 2);
  const sizeAfterFirst = sink.rows.size;

  // 第二次 orders 同步：录制 reader 游标已到末尾，pulled=0、created=0 → **不触发重放**
  const secondOrders = await service.run('1688', 'orders', { owner: 'w3' });
  assert.equal(secondOrders.stats.created, 0);
  assert.equal(secondOrders.after_sale_retry, undefined, '没有新订单时不触发重放（省一次全量读）');
  assert.equal(replayCalls, 1, '重放只跑了一次');
  assert.equal(sink.rows.size, sizeAfterFirst, '不得重复落库');

  // 即使强制再触发一次，也只会 skipped（靠 (platform, after_sale_id) 幂等）
  const forced = await replayPendingAfterSales(readers.after_sale, sink, '1688', new Date());
  assert.equal(forced.created, 0);
  assert.equal(forced.updated, 0);
  assert.equal(forced.skipped, 2, '已落库的两笔全部 skipped');
  assert.equal(forced.pending, 1, 'pending 仍是那笔缺订单的');
  assert.equal(sink.rows.size, sizeAfterFirst);
});

test('t50：重放超过 AFTER_SALE_RETRY_MAX_ITEMS → 降级只处理前 N 条并标记 degraded', async () => {
  const sink = new MemoryAfterSaleSink();
  sink.knownOrders.add('ALI-ORDER-1004');
  sink.knownOrders.add('ALI-ORDER-1005');
  const readers = createSyncReaders('recorded');
  const outcome = await replayPendingAfterSales(readers.after_sale, sink, '1688', new Date(), { maxItems: 2 });
  assert.equal(outcome.scanned, 3);
  assert.equal(outcome.degraded, true, '超过上限必须显式标记降级');
  assert.equal(outcome.created, 2, '只处理前 2 条（9001/9002 都命中订单）');
  assert.equal(sink.rows.size, 2);

  // 上限足够时不做降级
  const sink2 = new MemoryAfterSaleSink();
  sink2.knownOrders.add('ALI-ORDER-1004');
  const full = await replayPendingAfterSales(readers.after_sale, sink2, '1688', new Date(), { maxItems: 100 });
  assert.equal(full.degraded, false);
  assert.equal(full.scanned, 3);
});

test('t50：重放失败不回滚已成功的 orders 同步（只记 error）', async () => {
  const readers = createSyncReaders('recorded');
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: new MemoryOrderSink(), after_sale: new MemoryAfterSaleSink() },
    replayPendingAfterOrders: async () => {
      throw new Error('boom: after_sale reader 不可用');
    },
  });
  const orders = await service.run('1688', 'orders', { owner: 'w1' });
  assert.equal(orders.status, 'succeeded', '订单已经落库成功，不能因为重放异常误报失败');
  assert.equal(orders.stats.created, 5);
  assert.match(orders.after_sale_retry?.error ?? '', /boom/);
  assert.equal(orders.after_sale_retry?.created, 0);
});

// ---------------------------------------------------------------- 集成：日报

test('GET /api/dashboard/daily：指标完整、差异数来自 drift_log（14）、阈值告警随响应', async () => {
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
  assert.equal(data.metrics.drift_total, 14);
  assert.equal(data.metrics.drift_by_kind.order_item_mismatch, 1);
  assert.equal(data.thresholds_configured, true);
  assert.equal(data.drift_store.name, 'postgres');
  assert.ok(data.alerts.some((alert) => alert.metric === 'drift_total' && alert.value === 14 && alert.threshold === 12));
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
  assert.equal(report.metrics.drift_total, 14);
  assert.ok(report.alerts.some((alert) => alert.metric === 'drift_total'));

  const first = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  const second = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  assert.equal(first.inserted + first.skipped, report.alerts.length);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, report.alerts.length);

  const alerts = await listAlerts(prisma, DAY);
  assert.ok(alerts.some((alert) => alert.metric === 'drift_total' && alert.level === 'P2'));
});

test('t49 告警落库：配置 after_sale_platform_only=0 → 出现即写 event_log；未配置不写', async () => {
  // 用 pdd 平台承载本用例的差异：与 1688 的 14 条集成数据完全隔离，不干扰后续计数断言。
  // day 必须是当前业务日 —— persistAlerts/listAlerts 按 event_log.createdAt（DB now()）落在 day 窗口内。
  const store = new PgDriftStore(prisma);
  const day = DAY;
  const platform = 'pdd' as const;

  const before = await store.countByKind(day, platform);
  const baseline = before.after_sale_platform_only ?? 0;

  // 本地零售后 → 平台 3 条全部报「本地无」（纯函数，不读库）
  const snapshot = await recordedSnapshot();
  const detected = diffAfterSales([], snapshot, { platform, day, now: '2026-10-25T02:30:00.000Z' }).filter(
    (drift) => drift.kind === 'after_sale_platform_only',
  );
  assert.equal(detected.length, 3, '本地零售后时，平台 3 条售后都该报');
  await store.upsert(platform, day, detected);
  const expected = baseline + 3;

  try {
    const report = await buildDailyReport({
      prisma,
      driftStore: store,
      driftStoreNote: 'postgres',
      day,
      platform,
      thresholds: { drift_by_kind: { after_sale_platform_only: 0 } },
    });
    assert.equal(report.metrics.drift_by_kind.after_sale_platform_only, expected);
    assert.deepEqual(
      report.alerts.map((alert) => alert.metric),
      ['drift_by_kind.after_sale_platform_only'],
    );
    assert.equal(report.critical_thresholds[0]!.configured, true);

    // 落库：真实写 event_log
    const persisted = await persistAlerts({ prisma, day, platform, alerts: report.alerts });
    assert.equal(persisted.inserted, 1);
    const rows = await listAlerts(prisma, day);
    const alert = rows.find(
      (row) => row.metric === 'drift_by_kind.after_sale_platform_only' && row.platform === platform,
    );
    assert.ok(alert, '必须写 event_log');
    assert.equal(alert!.level, 'P2');
    assert.equal(alert!.value, expected);
    assert.equal(alert!.threshold, 0);

    // 未配置阈值 → 同一份数据不产生告警（也不写 event_log）
    const noThreshold = await buildDailyReport({
      prisma,
      driftStore: store,
      driftStoreNote: 'postgres',
      day,
      platform,
      thresholds: null,
    });
    assert.deepEqual(noThreshold.alerts, []);
    assert.equal(noThreshold.critical_thresholds_missing, true, '未配置时必须显式标记');
    const persistedNoThreshold = await persistAlerts({
      prisma,
      day,
      platform,
      alerts: noThreshold.alerts,
    });
    assert.deepEqual(persistedNoThreshold, { inserted: 0, skipped: 0 });
  } finally {
    await prisma.$executeRawUnsafe(`DELETE FROM drift_log WHERE day = $1::date AND platform = 'pdd'`, day);
  }
});

test('t50 延伸：日报里的 pending 重放 —— 无新订单也能把售后救回（不必等 orders 同步）', async () => {
  const sink = new MemoryAfterSaleSink();
  const readers = createSyncReaders('recorded');
  // 模拟"店铺停售/淡季"：售后先到，订单一直没有新单 → orders 同步永远不会触发重放。
  const service = new SyncService({
    store: new MemorySyncCursorStore(),
    readers,
    sinks: { orders: new MemoryOrderSink(), after_sale: sink },
  });
  const first = await service.run('1688', 'after_sale', { owner: 'w1' });
  assert.equal(first.stats.pending, 3, '三笔全部 pending（本地无订单）');

  // 日报里的重放：订单补齐后（这里直接注入已知订单，模拟别的途径补上了订单）
  sink.knownOrders.add('ALI-ORDER-1004');
  sink.knownOrders.add('ALI-ORDER-1005');
  const replay = await replayPendingAfterSales(readers.after_sale, sink, '1688', new Date());
  assert.equal(replay.created, 2, '日报重放救回两笔');
  assert.equal(replay.pending, 1, '缺订单的那笔仍 pending');
  assert.equal(sink.rows.size, 2);
});

test('t50 延伸：日报重放失败不影响日报生成（只记 error）', async () => {
  // 直接验证"重放抛错 → 外层仍然拿到 error 字段而不是整体失败"的契约。
  // daily-report 脚本里用 try/catch 包住，这里断言 catch 分支产生的结构。
  const failing = async (): Promise<Record<string, unknown>> => {
    try {
      await replayPendingAfterSales(
        {
          source: 'recorded',
          read: async () => {
            throw new Error('reader down');
          },
        },
        new MemoryAfterSaleSink(),
        '1688',
        new Date(),
      );
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const outcome = await failing();
  assert.equal(outcome.ok, undefined, '重放必须失败');
  assert.match(String(outcome.error), /reader down/, '失败原因要能落到日报里');
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
  assert.equal(report.metrics.drift_total, 14);
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
