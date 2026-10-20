/**
 * M8 对账与日报测试 —— 差异引擎、幂等存储、同步游标、端点与日报指标。
 *
 * 测试策略：
 * - 差异引擎/存储/阈值：纯单测，不连库；
 * - 端点/游标/日报指标：真实 Postgres + Fastify inject（与 t2 测试同一套 helpers）；
 * - 平台数据一律用**录制样本**（`recorded-samples.ts`，verified=false），不触网、不调平台写接口。
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { prisma, buildTestApp, createUser, login, cookiesFrom, csrfFrom, sessionHeaders } from './helpers.js';
import {
  collectDailyMetrics,
} from '../src/daily/metrics.js';
import { evaluateAlerts, parseAlertThresholds } from '../src/daily/thresholds.js';
import { buildDailyReport } from '../src/daily/report.js';
import { persistAlerts, listAlerts } from '../src/daily/alerts.js';
import { buildDriftKey, countByKind, diffSnapshots } from '../src/reconcile/engine.js';
import { MemoryDriftStore, FileDriftStore, createDriftStore } from '../src/reconcile/stores.js';
import { RecordedPlatformReader, AdapterPlatformReader } from '../src/reconcile/readers.js';
import { ReconcileService } from '../src/reconcile/service.js';
import { MemorySyncCursorStore, PrismaSyncCursorStore, MAX_CONSECUTIVE_FAILURES } from '../src/sync/cursor-store.js';
import { createSyncReaders, AdapterSyncReader } from '../src/sync/readers.js';
import { SyncService } from '../src/sync/service.js';
import { todayBusinessDay } from '../src/lib/day.js';
import { uuidv7 } from '../src/lib/ids.js';
import { ApiError } from '../src/lib/errors.js';
import { assertRecordedAllowed } from '../src/lib/adapter-refusal.js';
import type { LocalListingSnapshot, PlatformSnapshot } from '../src/reconcile/types.js';

const DAY = todayBusinessDay(new Date());
const PASSWORD = 'Passw0rd!Passw0rd!';
const IDEM = (suffix: string) => ({
  'idempotency-key': `t36-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
});

// ---------------------------------------------------------------- 单测：差异引擎

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

const LOCAL_FIXTURE: LocalListingSnapshot[] = [
  localListing('local-0001', 'ALI-2026-0001', 'published', { platformSkuId: 'ALI-SKU-0001', priceCents: 15800, stockQty: 480 }),
  localListing('local-0002', 'ALI-2026-0002', 'published', { platformSkuId: 'ALI-SKU-0002', priceCents: 15800, stockQty: 120 }),
  localListing('local-0003', 'ALI-2026-0003', 'published', { platformSkuId: 'ALI-SKU-0003', priceCents: 15800, stockQty: 88 }),
  localListing('local-0004', 'ALI-2026-0004', 'published', { platformSkuId: 'ALI-SKU-0004', priceCents: 15800, stockQty: 200 }),
  localListing('local-0005', 'ALI-2026-0005', 'published', { platformSkuId: 'ALI-SKU-0005', priceCents: 15800, stockQty: 200 }),
  localListing('local-0007', 'ALI-2026-0007', 'published', { platformSkuId: 'ALI-SKU-0007', priceCents: 15800, stockQty: 10 }),
];

async function recordedSnapshot(): Promise<PlatformSnapshot> {
  return new RecordedPlatformReader().read('1688', { day: DAY, now: new Date().toISOString() });
}

test('差异引擎：录制样本 6 类差异全部被识别，基线 0001 不报差异', async () => {
  const snapshot = await recordedSnapshot();
  const drifts = diffSnapshots(LOCAL_FIXTURE, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  const kinds = drifts.map((drift) => drift.kind).sort();
  assert.deepEqual(kinds, [
    'local_published_missing_platform',
    'local_published_platform_offline',
    'platform_only_listing',
    'price_mismatch',
    'state_mismatch',
    'stock_mismatch',
  ]);
  assert.equal(drifts.filter((drift) => drift.subject.platform_item_id === 'ALI-2026-0001').length, 0, '基线商品不应产生差异');
  assert.deepEqual(countByKind(drifts), {
    platform_only_listing: 1,
    local_published_missing_platform: 1,
    local_published_platform_offline: 1,
    price_mismatch: 1,
    stock_mismatch: 1,
    state_mismatch: 1,
  });

  const keys = drifts.map((drift) => drift.drift_key);
  assert.equal(new Set(keys).size, keys.length, 'drift_key 必须唯一');
  for (const drift of drifts) {
    assert.match(drift.drift_key, /^dk_[0-9a-f]{32}$/);
    assert.equal(drift.suggestion.auto_fixable, false, '只产出建议，不得自动修改');
    assert.ok(drift.suggestion.actions.length >= 2);
    assert.ok(drift.suggestion.doc_refs.length >= 1);
    assert.equal(drift.status, 'open');
  }

  // 可复现：同输入 → 同 key（同日重复对账靠它去重）
  const again = diffSnapshots(LOCAL_FIXTURE, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T03:00:00.000Z' });
  assert.deepEqual(again.map((drift) => drift.drift_key), keys);
});

test('drift_key 构造规则：platform/kind/listing_id/platform_item_id/platform_sku_id 参与，空值用空串', () => {
  const base = { platform: '1688', kind: 'price_mismatch' as const, listingId: 'l1', platformItemId: 'p1', platformSkuId: 's1' };
  assert.equal(buildDriftKey(base), buildDriftKey({ ...base }));
  assert.notEqual(buildDriftKey(base), buildDriftKey({ ...base, listingId: 'l2' }));
  assert.notEqual(buildDriftKey(base), buildDriftKey({ ...base, platformSkuId: 's2' }));
  assert.notEqual(buildDriftKey(base), buildDriftKey({ ...base, kind: 'stock_mismatch' }));
  assert.equal(
    buildDriftKey({ ...base, listingId: null }),
    buildDriftKey({ ...base, listingId: '' as unknown as null }),
    '空值按空串参与',
  );
});

test('不完整快照：跳过“本地 published 但平台不存在”的推断，避免样本不全导致全量误报', async () => {
  const incomplete: PlatformSnapshot = {
    platform: 'pdd',
    capturedAt: '2026-10-20T02:00:00.000Z',
    source: 'recorded',
    verified: false,
    complete: false,
    note: '不完整',
    items: [],
  };
  const drifts = diffSnapshots(LOCAL_FIXTURE, incomplete, { platform: 'pdd', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  assert.equal(drifts.length, 0);
});

// ---------------------------------------------------------------- 单测：存储幂等

test('文件/内存存储：同日重复 upsert 只更新不新增（seen_count 递增，first_detected_at 保留）', async () => {
  const snapshot = await recordedSnapshot();
  const detected = diffSnapshots(LOCAL_FIXTURE, snapshot, { platform: '1688', day: DAY, now: '2026-10-20T02:30:00.000Z' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-drift-'));
  try {
    for (const store of [new MemoryDriftStore(), new FileDriftStore(dir)]) {
      const first = await store.upsert('1688', DAY, detected);
      assert.equal(first.inserted, detected.length);
      assert.equal(first.updated, 0);

      const second = await store.upsert('1688', DAY, detected);
      assert.equal(second.inserted, 0, '重复对账不得新增');
      assert.equal(second.updated + second.unchanged, detected.length);

      const rows = await store.list(DAY, '1688');
      assert.equal(rows.length, detected.length);
      assert.ok(rows.every((row) => row.seen_count === 2));
      const firstSeen = rows[0]!.first_detected_at;
      await store.upsert('1688', DAY, detected);
      const rows3 = await store.list(DAY, '1688');
      assert.equal(rows3.length, detected.length);
      assert.equal(rows3[0]!.first_detected_at, firstSeen);
      assert.equal(rows3[0]!.seen_count, 3);
      assert.equal(await store.count(DAY, '1688'), detected.length);
      assert.equal(await store.count(DAY, '1688', 'price_mismatch'), 1);
      assert.deepEqual(await store.countByKind(DAY, '1688'), countByKind(detected));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('auto 存储：drift_log 不存在时显式降级为文件并返回原因', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-drift-auto-'));
  try {
    const bundle = await createDriftStore(prisma, { mode: 'auto', directory: dir });
    assert.equal(bundle.store.name, 'file');
    assert.match(bundle.note, /drift_log/);
    const probe = await bundle.store.probe();
    assert.equal(probe.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 单测：阈值

test('阈值：未配置不告警；非法 JSON / 未知键报错；严格大于才触发', () => {
  assert.deepEqual(parseAlertThresholds(undefined), { thresholds: null, issues: [] });
  assert.deepEqual(parseAlertThresholds('   '), { thresholds: null, issues: [] });
  const invalid = parseAlertThresholds('{"drift_total":-1}');
  assert.ok(invalid.issues.length > 0);
  const unknownKey = parseAlertThresholds('{"drfit_total":1}');
  assert.ok(unknownKey.issues.length > 0, '拼错键名必须报错，不能静默忽略');

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
    drift_total: 6,
    drift_by_kind: { price_mismatch: 2 },
  };
  assert.deepEqual(evaluateAlerts(metrics, null), []);
  const alerts = evaluateAlerts(metrics, { drift_total: 6, drift_by_kind: { price_mismatch: 1 }, approvals_pending: 3 });
  assert.deepEqual(alerts.map((alert) => alert.metric), ['drift_by_kind.price_mismatch'], '等于阈值不触发，只有 > 才触发');
  const all = evaluateAlerts(metrics, { drift_total: 5, rejected_listings: 1 });
  assert.deepEqual(all.map((alert) => alert.metric), ['drift_total', 'rejected_listings']);
});

// ---------------------------------------------------------------- 单测：同步游标续跑

test('同步游标：分页推进、断点续跑、状态查询', async () => {
  const store = new MemorySyncCursorStore();
  const service = new SyncService({ store, readers: createSyncReaders('recorded'), maxPages: 1 });
  const first = await service.run('1688', 'orders', { owner: 'worker-a' });
  assert.equal(first.pages, 1);
  assert.equal(first.stats.pulled, 2);
  assert.equal(first.cursor, 'ck-orders-1');
  assert.equal(first.resumed_from, null);

  const second = await service.run('1688', 'orders', { owner: 'worker-b' });
  assert.equal(second.resumed_from, 'ck-orders-1');
  assert.equal(second.stats.pulled, 1);
  assert.equal(second.cursor, 'ck-orders-2');

  const third = await service.run('1688', 'orders', { owner: 'worker-c' });
  assert.equal(third.stats.pulled, 0);
  assert.equal(third.cursor, 'ck-orders-2');

  const status = await service.status('1688', 3600);
  assert.equal(status.store, 'memory');
  assert.equal(status.items.length, 1);
  assert.equal(status.items[0]?.resource, 'orders');
  assert.equal(status.items[0]?.status, 'idle');
  assert.equal(status.items[0]?.cursor, 'ck-orders-2');
  assert.ok(status.items[0]?.last_success_at);
});

test('同步租约：同平台同 resource 并发跑返回 conflict', async () => {
  const store = new MemorySyncCursorStore();
  const service = new SyncService({ store, readers: createSyncReaders('recorded') });
  const row = await store.getOrCreate('1688', 'orders');
  const acquired = await store.tryAcquire(row.id, 'other-worker', new Date(), 60_000);
  assert.equal(acquired, true);
  await assert.rejects(
    () => service.run('1688', 'orders', { owner: 'worker-a' }),
    (error: unknown) => error instanceof ApiError && error.code === 'conflict',
  );
});

test('同步失败：连续失败计数到 5 置 error（docs/06 §4.5.2）', async () => {
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
  assert.equal(rows[0]?.errorCode, 'publish_blocked');
});

test('真实 reader 硬拒绝：publish_blocked + TODO 列表（不猜接口）', async () => {
  const reader = new AdapterSyncReader('orders');
  await assert.rejects(
    () => reader.read({ platform: '1688', resource: 'orders', cursor: null, since: null, pageSize: 100, pageIndex: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'publish_blocked');
      const detail = error.detail as { reason?: string; todo_ids?: string[] };
      assert.equal(detail.reason, 'adapter_contract_unverified');
      assert.ok((detail.todo_ids ?? []).some((id) => id.startsWith('TODO-1688-')));
      return true;
    },
  );
  await assert.rejects(
    () => new AdapterPlatformReader().read('1688', { day: DAY, now: new Date().toISOString() }),
    (error: unknown) => error instanceof ApiError && error.code === 'publish_blocked',
  );
});

// ---------------------------------------------------------------- 集成：端点

interface Fixture {
  app: FastifyInstance;
  admin: ReturnType<typeof sessionHeaders>;
  viewer: ReturnType<typeof sessionHeaders>;
  operator: ReturnType<typeof sessionHeaders>;
  dir: string;
  listingIds: Record<string, string>;
}

let fixture!: Fixture;

async function seedUsersAndListings(app: FastifyInstance): Promise<Omit<Fixture, 'app' | 'dir'>> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const adminUser = await createUser({ email: `t36-admin-${suffix}@example.com`, password: PASSWORD, role: 'admin' });
  const viewerUser = await createUser({ email: `t36-viewer-${suffix}@example.com`, password: PASSWORD, role: 'viewer' });
  const operatorUser = await createUser({ email: `t36-operator-${suffix}@example.com`, password: PASSWORD, role: 'operator' });

  const adminLogin = await login(app, adminUser.email, PASSWORD);
  const viewerLogin = await login(app, viewerUser.email, PASSWORD);
  const operatorLogin = await login(app, operatorUser.email, PASSWORD);
  assert.equal(adminLogin.statusCode, 200);
  assert.equal(viewerLogin.statusCode, 200);
  assert.equal(operatorLogin.statusCode, 200);

  const listingIds: Record<string, string> = {};
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
  const specs: Array<[string, string, string, number, number]> = [
    ['ALI-2026-0001', 'published', 'ALI-SKU-0001', 15800, 480],
    ['ALI-2026-0002', 'published', 'ALI-SKU-0002', 15800, 120],
    ['ALI-2026-0003', 'published', 'ALI-SKU-0003', 15800, 88],
    ['ALI-2026-0004', 'published', 'ALI-SKU-0004', 15800, 200],
    ['ALI-2026-0005', 'published', 'ALI-SKU-0005', 15800, 200],
    ['ALI-2026-0007', 'published', 'ALI-SKU-0007', 15800, 10],
  ];
  for (const [itemId, status, skuId, priceCents, stockQty] of specs) {
    const product = await prisma.product.create({
      data: {
        spuCode: `SPU-${suffix}-${itemId.slice(-4)}`,
        name: `测试商品 ${itemId}`,
        categoryCode: 'A0202',
        status: 'active',
      },
    });
    const listing = await prisma.listing.create({
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
    listingIds[itemId] = listing.id;
  }

  // 驳回 listing（日报 rejected 口径）
  const rejectedProduct = await prisma.product.create({
    data: { spuCode: `SPU-${suffix}-REJ`, name: '驳回商品', categoryCode: 'A0202', status: 'active' },
  });
  await prisma.listing.create({
    data: { platform: '1688', productId: rejectedProduct.id, platformItemId: 'ALI-2026-REJ', status: 'rejected', rejectMeta: { code: 'QUALITY' } },
  });

  // 待审批 + 消息 + 媒体成本（日报指标）
  await prisma.approval.create({
    data: {
      subjectType: 'listing',
      subjectId: listingIds['ALI-2026-0002']!,
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
    data: {
      kind: 'media',
      refType: 'media_job',
      refId: uuidv7(),
      amountCents: 1234,
      seconds: '0.5',
    },
  });

  return {
    admin: sessionHeaders(cookiesFrom(adminLogin), csrfFrom(adminLogin)),
    viewer: sessionHeaders(cookiesFrom(viewerLogin), csrfFrom(viewerLogin)),
    operator: sessionHeaders(cookiesFrom(operatorLogin), csrfFrom(operatorLogin)),
    listingIds,
  };
}

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-t36-'));
  const app = await buildTestApp({
    RECONCILE_STORE: 'auto',
    RECONCILE_DIR: dir,
    DAILY_ALERT_THRESHOLDS: '{"drift_total":5}',
    SYNC_READER: 'recorded',
  });
  const partial = await seedUsersAndListings(app);
  fixture = { app, dir, ...partial };
});

after(async () => {
  if (fixture?.app) await fixture.app.close();
  if (fixture?.dir) await rm(fixture.dir, { recursive: true, force: true });
});

test('POST /api/reconcile/:platform：6 类差异、落文件存储、同日重复对账不新增', async () => {
  const first = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, ...IDEM('rec1'), 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(first.statusCode, 200, first.body);
  const body = JSON.parse(first.body).data as {
    summary: { total: number; by_kind: Record<string, number> };
    persisted: { inserted: number; updated: number };
    store: string;
    store_note: string;
    snapshot: { source: string; verified: boolean; complete: boolean };
    checked: { orders: { checked: boolean }; after_sale: { checked: boolean }; local_missing_check: { checked: boolean } };
    diffs: Array<{ kind: string; suggestion: { actions: unknown[] }; drift_key: string }>;
    reader_mode: string;
  };
  assert.equal(body.summary.total, 6);
  assert.equal(body.summary.by_kind.price_mismatch, 1);
  assert.equal(body.summary.by_kind.stock_mismatch, 1);
  assert.equal(body.store, 'file');
  assert.match(body.store_note, /drift_log/);
  assert.equal(body.reader_mode, 'recorded');
  assert.equal(body.snapshot.verified, false);
  assert.equal(body.snapshot.complete, true);
  assert.equal(body.checked.orders.checked, false);
  assert.equal(body.checked.after_sale.checked, false);
  assert.equal(body.checked.local_missing_check.checked, true);
  assert.equal(body.persisted.inserted, 6);
  assert.ok(body.diffs.every((drift) => Array.isArray(drift.suggestion.actions)));

  // 文件落盘可复核
  const file = await readFile(path.join(fixture.dir, DAY, '1688.json'), 'utf8');
  const payloadFile = JSON.parse(file) as { items: Array<{ seen_count: number; first_detected_at: string }> };
  assert.equal(payloadFile.items.length, 6);

  const second = await fixture.app.inject({
    method: 'POST',
    url: '/api/reconcile/1688',
    headers: { ...fixture.admin, ...IDEM('rec2'), 'content-type': 'application/json' },
    payload: { day: DAY },
  });
  assert.equal(second.statusCode, 200, second.body);
  const secondBody = JSON.parse(second.body).data as { persisted: { inserted: number; updated: number }; summary: { total: number } };
  assert.equal(secondBody.summary.total, 6);
  assert.equal(secondBody.persisted.inserted, 0, '同一天重复对账不得新增差异行');
  assert.ok(secondBody.persisted.updated >= 6);

  const fileAfter = JSON.parse(await readFile(path.join(fixture.dir, DAY, '1688.json'), 'utf8')) as {
    items: Array<{ seen_count: number; first_detected_at: string }>;
  };
  assert.equal(fileAfter.items.length, 6);
  assert.ok(fileAfter.items.every((item) => item.seen_count >= 2));
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
  assert.ok(error.detail.todo_ids.length > 0);
});

test('POST /api/sync/:platform + GET /api/sync/status：游标落库、续跑、状态可读', async () => {
  const first = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/1688',
    headers: { ...fixture.operator, ...IDEM('sync1'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  assert.equal(first.statusCode, 202, first.body);
  const body = JSON.parse(first.body).data as { pages: number; stats: { pulled: number }; cursor: string; dry_run: boolean; source: string };
  assert.equal(body.dry_run, true);
  assert.equal(body.source, 'recorded');
  assert.equal(body.pages, 2);
  assert.equal(body.stats.pulled, 3);
  assert.equal(body.cursor, 'ck-orders-2');

  const second = await fixture.app.inject({
    method: 'POST',
    url: '/api/sync/1688',
    headers: { ...fixture.operator, ...IDEM('sync2'), 'content-type': 'application/json' },
    payload: { resource: 'orders' },
  });
  assert.equal(second.statusCode, 202, second.body);
  const secondBody = JSON.parse(second.body).data as { resumed_from: string; stats: { pulled: number } };
  assert.equal(secondBody.resumed_from, 'ck-orders-2');
  assert.equal(secondBody.stats.pulled, 0);

  const status = await fixture.app.inject({
    method: 'GET',
    url: '/api/sync/status?platform=1688',
    headers: { cookie: fixture.viewer.cookie },
  });
  assert.equal(status.statusCode, 200, status.body);
  const statusBody = JSON.parse(status.body).data as {
    store: string;
    items: Array<{ resource: string; status: string; cursor: string | null; last_success_at: string | null }>;
    stale: boolean;
  };
  assert.equal(statusBody.store, 'postgres');
  const orders = statusBody.items.find((item) => item.resource === 'orders');
  assert.ok(orders);
  assert.equal(orders!.cursor, 'ck-orders-2');
  assert.equal(orders!.status, 'idle');
  assert.ok(orders!.last_success_at);
});

test('GET /api/dashboard/daily：指标完整、差异数来自存储、阈值告警随响应返回', async () => {
  const response = await fixture.app.inject({
    method: 'GET',
    url: `/api/dashboard/daily?date=${DAY}&platform=1688`,
    headers: { cookie: fixture.viewer.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = JSON.parse(response.body).data as {
    date: string;
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
  assert.equal(data.date, DAY);
  assert.equal(data.metrics.listed, 1);
  assert.equal(data.metrics.rejected, 1);
  assert.ok(data.metrics.approvals_pending >= 1);
  assert.ok(data.metrics.messages >= 1);
  assert.equal(data.metrics.media_cost_cents, 1234);
  assert.equal(data.metrics.drift_total, 6);
  assert.equal(data.metrics.drift_by_kind.price_mismatch, 1);
  assert.equal(data.thresholds_configured, true);
  assert.equal(data.drift_store.name, 'file');
  assert.ok(data.alerts.some((alert) => alert.metric === 'drift_total' && alert.value === 6 && alert.threshold === 5));
});

test('日报组装 + 告警落库幂等：同日同指标只写一条 event_log', async () => {
  const store = new FileDriftStore(fixture.dir);
  const report = await buildDailyReport({
    prisma,
    driftStore: store,
    driftStoreNote: 'test',
    day: DAY,
    platform: null,
    thresholds: { drift_total: 5 },
  });
  assert.equal(report.metrics.drift_total, 6);
  assert.ok(report.alerts.some((alert) => alert.metric === 'drift_total'));

  const first = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  const second = await persistAlerts({ prisma, day: DAY, platform: null, alerts: report.alerts });
  assert.equal(first.inserted, report.alerts.length);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, report.alerts.length);

  const alerts = await listAlerts(prisma, DAY);
  assert.ok(alerts.some((alert) => alert.metric === 'drift_total' && alert.level === 'P2'));
});

test('未配置阈值时：日报只报事实、alerts 为空', async () => {
  const report = await buildDailyReport({
    prisma,
    driftStore: new FileDriftStore(fixture.dir),
    driftStoreNote: 'test',
    day: DAY,
    platform: '1688',
    thresholds: null,
  });
  assert.equal(report.alerts.length, 0);
  assert.equal(report.thresholds_configured, false);
  assert.ok(report.metrics.drift_total > 0);
});

test('日报指标：collectDailyMetrics 的平台过滤与成本口径（global）', async () => {
  const metrics = await collectDailyMetrics({
    prisma,
    driftStore: new FileDriftStore(fixture.dir),
    day: DAY,
    platform: '1688',
  });
  assert.equal(metrics.platform, '1688');
  assert.equal(metrics.media_cost_scope, 'global');
  assert.equal(metrics.media_cost_cents, 1234);
  assert.ok(metrics.listed >= 1);
});

test('生产环境禁止 recorded 样本对账（避免样本不全导致全量误报）', () => {
  assert.throws(
    () => assertRecordedAllowed('production', 'recorded', '对账'),
    (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
  );
  assert.doesNotThrow(() => assertRecordedAllowed('test', 'recorded', '对账'));
  assert.doesNotThrow(() => assertRecordedAllowed('production', 'adapter', '对账'));
});

test('Prisma 游标存储：真实 sync_cursor 行可创建、抢占、checkpoint、失败计数', async () => {
  const store = new PrismaSyncCursorStore(prisma);
  const row = await store.getOrCreate('1688', 'stock');
  assert.equal(row.platform, '1688');
  assert.equal(row.resource, 'stock');
  const now = new Date();
  assert.equal(await store.tryAcquire(row.id, 'test-worker', now, 60_000), true);
  assert.equal(await store.tryAcquire(row.id, 'another-worker', now, 60_000), false);
  const checkpoint = await store.checkpoint(row.id, { cursor: 'ck-stock-1', watermarkAt: now, stats: { pulled: 2 } }, now);
  assert.equal(checkpoint.cursor, 'ck-stock-1');
  assert.equal(checkpoint.consecutiveFailures, 0);
  const failed = await store.recordFailure(row.id, { errorCode: 'upstream_5xx' }, now);
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(failed.errorCode, 'upstream_5xx');
  await store.release(row.id);
});
