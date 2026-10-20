/**
 * 对账差异引擎（纯函数）—— 输入本地快照 + 平台快照，输出差异清单。
 *
 * 维度：
 * - 商品/上架（6 类）：platform_only_listing / local_published_missing_platform /
 *   local_published_platform_offline / price_mismatch / stock_mismatch / state_mismatch；
 * - 订单（5 类，t43）：order_platform_only / order_local_only / order_amount_mismatch /
 *   order_status_mismatch（含退款状态）/ order_item_mismatch（数量或单价）；
 * - 售后（2 类，t43）：after_sale_amount_mismatch / after_sale_status_mismatch。
 *
 * 设计约束：
 * - **只读**：函数无副作用，不碰数据库；
 * - **不猜**：任一侧为 `null` 的值不比较（未知 ≠ 不一致）；
 * - **可复现**：`drift_key` 由 platform + kind + 5 个对象 id 决定（不含 day）。
 */

import { createHash } from 'node:crypto';
import {
  type DetectedDrift,
  type DiffOptions,
  type DriftKind,
  type FixSuggestion,
  type LocalAfterSaleSnapshot,
  type LocalListingSnapshot,
  type LocalOrderSnapshot,
  type PlatformAfterSaleSnapshot,
  type PlatformItemSnapshot,
  type PlatformOrderSnapshot,
  type PlatformSnapshot,
  DRIFT_KINDS,
  CURRENT_DRIFT_KEY_VERSION,
  isLocallyLive,
  normalizePlatformState,
  primaryAction,
} from './types.js';

const KIND_ORDER = new Map<DriftKind, number>(DRIFT_KINDS.map((kind, index) => [kind, index]));

/** `drift_key` 的参与字段（顺序固定，改动即视为键规则变更，见验收文档 §4）。 */
export interface DriftKeyParts {
  platform: string;
  kind: DriftKind;
  listingId: string | null;
  platformItemId: string | null;
  platformSkuId: string | null;
  /** t43：订单维度（平台订单号）。 */
  platformOrderId?: string | null;
  /** t43：售后维度（平台售后单号）。 */
  platformAfterSaleId?: string | null;
}

/**
 * 去重键 = `dk_` + sha256(
 *   `platform|kind|listing_id|platform_item_id|platform_sku_id|platform_order_id|platform_after_sale_id`
 * )[0..31]。
 *
 * - 空值以空串参与；不含 day（存储层用 `(platform, day, drift_key)` 唯一）；
 * - t43 在**末尾追加**订单/售后两个字段，商品维度历史 key 不变（追加空串不改变既有字段顺序语义，
 *   但哈希值会变化 —— 这是一次显式的键规则版本变更，已在验收记录 §4.4 登记）。
 */
export function buildDriftKey(parts: DriftKeyParts): string {
  const canonical = [
    parts.platform,
    parts.kind,
    parts.listingId ?? '',
    parts.platformItemId ?? '',
    parts.platformSkuId ?? '',
    parts.platformOrderId ?? '',
    parts.platformAfterSaleId ?? '',
  ].join('|');
  return `dk_${createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32)}`;
}

const SUGGESTIONS: Record<DriftKind, FixSuggestion> = {
  platform_only_listing: {
    summary: '平台存在本地未登记的商品：先在本地建 listing 草稿并绑定 platform_item_id，再决定是否接管',
    actions: [
      {
        kind: 'read',
        action: 'listing.query',
        level: null,
        requires_approval: false,
        endpoint: 'GET /api/listings',
        note: '确认本地是否已有同商品但未绑定平台 id',
      },
      {
        kind: 'manual',
        action: 'listing.adopt',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '人工建档：创建 product/listing 草稿并写入 platform_item_id（不自动发布）',
      },
    ],
    doc_refs: ['docs/12 §3.6', 'docs/06 §3.4'],
    auto_fixable: false,
  },
  local_published_missing_platform: {
    summary: '本地显示在架但平台查不到该商品：核对是否被删除，确认后本地置 rejected/archived 并登记止损',
    actions: [
      {
        kind: 'read',
        action: 'item.query',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '真实平台查询依赖 adapter 契约（未核验时硬拒绝）',
      },
      {
        kind: 'write',
        action: 'listing.stop_loss',
        level: 'B',
        requires_approval: true,
        endpoint: 'POST /api/listings/stop-loss',
        note: '生成补偿工单/止损记录；不自动改 listing 状态',
      },
    ],
    doc_refs: ['docs/12 §3.6', 'docs/11 §6.2'],
    auto_fixable: false,
  },
  local_published_platform_offline: {
    summary: '本地在架、平台已下架：先查下架原因（违规/主动/活动），再决定重新上架或止损',
    actions: [
      {
        kind: 'read',
        action: 'item.query',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '读取平台下架原因（未核验接口前人工核对后台）',
      },
      {
        kind: 'write',
        action: 'listing.online',
        level: 'B',
        requires_approval: true,
        endpoint: 'POST /api/listings/write',
        note: '重新上架不可撤回，需审批；违规下架须先修复',
      },
    ],
    doc_refs: ['docs/12 §3.6', 'docs/11 §6.2'],
    auto_fixable: false,
  },
  price_mismatch: {
    summary: '平台价与本地不一致：确认哪一侧为准（主数据 or 平台活动），走改价（C 级）并留快照',
    actions: [
      {
        kind: 'read',
        action: 'price.query',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '写前拉取平台现价做 diff（依赖只读接口核验）',
      },
      {
        kind: 'write',
        action: 'listing.update_price',
        level: 'C',
        requires_approval: true,
        endpoint: 'POST /api/listings/write',
        note: 'C 级不可回滚：需审批 + confirm_token + 低峰窗口；禁止用旧值覆盖伪装回滚',
      },
    ],
    doc_refs: ['docs/11 §6.2', 'docs/02 §2.4', 'docs/12 §3.6'],
    auto_fixable: false,
  },
  stock_mismatch: {
    summary: '平台库存与本地不一致：确认以哪一侧为准，覆盖写前先做快照（A 级可逆）',
    actions: [
      {
        kind: 'read',
        action: 'stock.query',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '核对平台可售/占用/锁定三套数字（未核验前只看平台后台）',
      },
      {
        kind: 'write',
        action: 'listing.update_stock',
        level: 'A',
        requires_approval: false,
        endpoint: 'POST /api/listings/write',
        note: '覆盖写 + 写前快照；单 SKU 超阈值按 docs/11 升级 B',
      },
    ],
    doc_refs: ['docs/11 §6.2', 'docs/02 §2.2'],
    auto_fixable: false,
  },
  state_mismatch: {
    summary: '平台驳回/违规下架，本地仍在架：读取驳回原因与修复项，修复后重提；同时登记止损',
    actions: [
      {
        kind: 'read',
        action: 'item.query',
        level: null,
        requires_approval: false,
        endpoint: 'GET /api/listings/:id',
        note: '本地 reject_meta 可能已过期，需与平台驳回原因核对',
      },
      {
        kind: 'write',
        action: 'listing.stop_loss',
        level: 'B',
        requires_approval: true,
        endpoint: 'POST /api/listings/stop-loss',
        note: '违规下架优先止损（下架/补偿），修复后走重新发布审批',
      },
    ],
    doc_refs: ['docs/12 §3.6', 'docs/11 §6.2', 'docs/02 §4.3'],
    auto_fixable: false,
  },
  // ---------------- 订单维度（t43） ----------------
  order_platform_only: {
    summary: '平台有订单、本地没有：先只读核对，再人工补录或确认是否为测试单（不自动落库）',
    actions: [
      {
        kind: 'read',
        action: 'order.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '真实平台订单详情依赖 adapter 契约（未核验时硬拒绝）',
      },
      {
        kind: 'manual',
        action: 'order.adopt',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '人工补录订单/明细，或标记为测试单；补录后再次对账确认',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 orders）'],
    auto_fixable: false,
  },
  order_local_only: {
    summary: '本地有订单、平台没有：核对平台是否删除/测试单，确认后登记止损或归档（不自动删单）',
    actions: [
      {
        kind: 'read',
        action: 'order.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '平台侧查不到时需人工核对后台，禁止直接删除本地订单',
      },
      {
        kind: 'manual',
        action: 'order.archive_or_ticket',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '确认后归档本地订单或建补偿工单；订单删除属不可逆，必须人工',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/11 §6.2'],
    auto_fixable: false,
  },
  order_amount_mismatch: {
    summary: '订单金额与平台不一致：先对账实收/优惠/运费，再走财务核对或工单（不自动改金额）',
    actions: [
      {
        kind: 'read',
        action: 'order.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '核对 total/paid/freight/discount 四项，避免只看一个数字',
      },
      {
        kind: 'manual',
        action: 'finance.reconcile_ticket',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '金额差异涉及结算，人工核对后建工单；不得自动改单',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 orders）'],
    auto_fixable: false,
  },
  order_status_mismatch: {
    summary: '订单状态（含退款状态）与平台不一致：核对平台真实状态后人工修正或登记差异',
    actions: [
      {
        kind: 'read',
        action: 'order.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '需同时看订单状态与退款状态（refunding/refunded）',
      },
      {
        kind: 'manual',
        action: 'order.status_fix',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '状态回写影响履约与售后，必须人工确认；禁止自动覆盖',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 orders）'],
    auto_fixable: false,
  },
  order_item_mismatch: {
    summary: '订单明细的数量或单价与平台不一致：核对 SKU/数量/单价后人工修正并留证',
    actions: [
      {
        kind: 'read',
        action: 'order.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '按 platform_sku_ref 对齐明细，逐个比较 qty/unit_price/amount',
      },
      {
        kind: 'manual',
        action: 'order.item_fix',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '明细影响发货与结算，人工处理后重新对账',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 order_items）'],
    auto_fixable: false,
  },
  // ---------------- 售后维度（t43） ----------------
  after_sale_amount_mismatch: {
    summary: '售后退款金额与平台不一致：人工核对退款流水，禁止自动改金额或重复退款',
    actions: [
      {
        kind: 'read',
        action: 'after_sale.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '核对平台退款金额与本地 amount_cents',
      },
      {
        kind: 'manual',
        action: 'finance.refund_check',
        level: 'C',
        requires_approval: true,
        endpoint: null,
        note: '涉及资金，必须人工复核；禁止任何自动退款/改金额',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 after_sale）'],
    auto_fixable: false,
  },
  after_sale_status_mismatch: {
    summary: '售后状态与平台不一致（如平台已关闭、本地仍 open）：核对后人工关闭或重开',
    actions: [
      {
        kind: 'read',
        action: 'after_sale.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '平台 closed 与本地 open 同时存在时，以平台为准人工核对',
      },
      {
        kind: 'manual',
        action: 'after_sale.status_fix',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '状态变更影响客服考核与退款流程，人工确认后执行',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 after_sale）'],
    auto_fixable: false,
  },
  // ---------------- 售后维度：平台有、本地无（t48 / D12） ----------------
  after_sale_platform_only: {
    summary:
      '平台存在售后单、本地完全没有记录：先核对是同步失败（漏拉/游标丢）还是有人绕过系统退款，' +
      '确认后人工补录或按异常处置（不自动落库、不自动退款）',
    actions: [
      {
        kind: 'read',
        action: 'after_sale.detail',
        level: null,
        requires_approval: false,
        endpoint: null,
        note: '先查 sync_cursor 的 after_sale 游标与最近成功时间，判断是否同步中断',
      },
      {
        kind: 'manual',
        action: 'after_sale.adopt_or_ticket',
        level: 'B',
        requires_approval: true,
        endpoint: null,
        note: '同步失败 → 修游标后重跑；疑似绕过系统 → 建异常工单并人工补录，禁止自动补单/退款',
      },
    ],
    doc_refs: ['docs/12 §3.9', 'docs/06 §4.5（t37 after_sale）', 'docs/18 §4'],
    auto_fixable: false,
  },
};

export function suggestionFor(kind: DriftKind): FixSuggestion {
  // 返回深拷贝，避免调用方修改共享常量。
  return JSON.parse(JSON.stringify(SUGGESTIONS[kind])) as FixSuggestion;
}

function baseRecord(
  options: DiffOptions,
  input: {
    kind: DriftKind;
    severity: DetectedDrift['severity'];
    listingId: string | null;
    platformItemId: string | null;
    platformSkuId: string | null;
    skuId: string | null;
    orderId?: string | null;
    platformOrderId?: string | null;
    orderItemId?: string | null;
    platformSkuRef?: string | null;
    afterSaleId?: string | null;
    platformAfterSaleId?: string | null;
    local: Record<string, unknown> | null;
    platformValue: Record<string, unknown> | null;
    detail: string;
  },
): DetectedDrift {
  const orderId = input.orderId ?? null;
  const platformOrderId = input.platformOrderId ?? null;
  const platformSkuRef = input.platformSkuRef ?? null;
  const afterSaleId = input.afterSaleId ?? null;
  const platformAfterSaleId = input.platformAfterSaleId ?? null;
  const drift_key = buildDriftKey({
    platform: options.platform,
    kind: input.kind,
    listingId: input.listingId,
    platformItemId: input.platformItemId,
    platformSkuId: input.platformSkuId,
    platformOrderId,
    platformAfterSaleId,
  });
  const subjectType: DetectedDrift['subject']['type'] = platformAfterSaleId
    ? 'after_sale'
    : platformOrderId && platformSkuRef
      ? 'order_item'
      : platformOrderId
        ? 'order'
        : input.platformSkuId
          ? 'sku'
          : input.listingId
            ? 'listing'
            : 'platform_item';
  const suggestion = suggestionFor(input.kind);
  return {
    drift_key,
    key_version: CURRENT_DRIFT_KEY_VERSION,
    platform: options.platform,
    day: options.day,
    kind: input.kind,
    severity: input.severity,
    subject: {
      type: subjectType,
      listing_id: input.listingId,
      platform_item_id: input.platformItemId,
      sku_id: input.skuId,
      platform_sku_id: input.platformSkuId,
      order_id: orderId,
      platform_order_id: platformOrderId,
      order_item_id: input.orderItemId ?? null,
      platform_sku_ref: platformSkuRef,
      after_sale_id: afterSaleId,
      platform_after_sale_id: platformAfterSaleId,
    },
    local: input.local,
    platform_value: input.platformValue,
    detail: input.detail,
    suggestion,
    suggested_action: primaryAction(suggestion),
    status: 'open',
    detected_at: options.now,
  };
}

function itemSummary(item: PlatformItemSnapshot): Record<string, unknown> {
  return {
    item_id: item.itemId,
    title: item.title,
    state: item.state,
    updated_at: item.updatedAt,
    sku_count: item.skus.length,
  };
}

function listingSummary(listing: LocalListingSnapshot): Record<string, unknown> {
  return {
    listing_id: listing.listingId,
    status: listing.status,
    platform_item_id: listing.platformItemId,
    platform_state: listing.platformState,
    title: listing.title,
    updated_at: listing.updatedAt,
    binding_count: listing.skuBindings.length,
  };
}

/**
 * 比对入口。本地 listing 按 `platform_item_id` 与平台 item 对齐；
 * 同一平台 item 被多个本地 listing 绑定时只取第一条（数据本身异常，交给人工）。
 */
export function diffSnapshots(
  localListings: readonly LocalListingSnapshot[],
  snapshot: PlatformSnapshot,
  options: DiffOptions,
): DetectedDrift[] {
  const drifts: DetectedDrift[] = [];
  const localByItem = new Map<string, LocalListingSnapshot>();
  for (const listing of localListings) {
    if (listing.platformItemId && !localByItem.has(listing.platformItemId)) {
      localByItem.set(listing.platformItemId, listing);
    }
  }
  const platformItems = new Map(snapshot.items.map((item) => [item.itemId, item]));

  for (const item of snapshot.items) {
    const listing = localByItem.get(item.itemId);
    if (!listing) {
      drifts.push(
        baseRecord(options, {
          kind: 'platform_only_listing',
          severity: 'medium',
          listingId: null,
          platformItemId: item.itemId,
          platformSkuId: null,
          skuId: null,
          local: null,
          platformValue: itemSummary(item),
          detail: `平台商品 ${item.itemId}（${item.title ?? '无标题'}）在本地没有对应 listing`,
        }),
      );
      continue;
    }

    const live = isLocallyLive(listing.status);
    const normalized = normalizePlatformState(item.state);
    if (live && normalized === 'rejected') {
      drifts.push(
        baseRecord(options, {
          kind: 'state_mismatch',
          severity: 'high',
          listingId: listing.listingId,
          platformItemId: item.itemId,
          platformSkuId: null,
          skuId: null,
          local: listingSummary(listing),
          platformValue: itemSummary(item),
          detail: `本地 listing 状态 ${listing.status}，平台态 ${item.state}（驳回/违规），需按驳回原因修复后重提`,
        }),
      );
    } else if (live && normalized === 'offline') {
      drifts.push(
        baseRecord(options, {
          kind: 'local_published_platform_offline',
          severity: 'medium',
          listingId: listing.listingId,
          platformItemId: item.itemId,
          platformSkuId: null,
          skuId: null,
          local: listingSummary(listing),
          platformValue: itemSummary(item),
          detail: `本地 listing 状态 ${listing.status}，平台态 ${item.state}（已下架）`,
        }),
      );
    }

    const bindingByPlatformSku = new Map(
      listing.skuBindings
        .filter((binding): binding is typeof binding & { platformSkuId: string } => Boolean(binding.platformSkuId))
        .map((binding) => [binding.platformSkuId, binding]),
    );
    for (const platformSku of item.skus) {
      const binding = bindingByPlatformSku.get(platformSku.platformSkuId);
      if (!binding) continue;
      const localPrice = binding.priceCents;
      const platformPrice = platformSku.priceCents;
      if (localPrice !== null && platformPrice !== null && localPrice !== platformPrice) {
        drifts.push(
          baseRecord(options, {
            kind: 'price_mismatch',
            severity: 'medium',
            listingId: listing.listingId,
            platformItemId: item.itemId,
            platformSkuId: platformSku.platformSkuId,
            skuId: binding.skuId,
            local: { price_cents: localPrice, sku_id: binding.skuId, sku_code: null },
            platformValue: { price_cents: platformPrice, platform_sku_id: platformSku.platformSkuId, state: item.state },
            detail: `平台 SKU ${platformSku.platformSkuId} 价格 ${platformPrice} 分，本地绑定价 ${localPrice} 分`,
          }),
        );
      }
      const localStock = binding.stockQty;
      const platformStock = platformSku.stockQty;
      if (localStock !== null && platformStock !== null && localStock !== platformStock) {
        drifts.push(
          baseRecord(options, {
            kind: 'stock_mismatch',
            severity: 'low',
            listingId: listing.listingId,
            platformItemId: item.itemId,
            platformSkuId: platformSku.platformSkuId,
            skuId: binding.skuId,
            local: { stock_qty: localStock, sku_id: binding.skuId },
            platformValue: { stock_qty: platformStock, platform_sku_id: platformSku.platformSkuId, state: item.state },
            detail: `平台 SKU ${platformSku.platformSkuId} 库存 ${platformStock}，本地绑定库存 ${localStock}`,
          }),
        );
      }
    }
  }

  for (const listing of localListings) {
    if (!isLocallyLive(listing.status)) continue;
    if (listing.platformItemId && platformItems.has(listing.platformItemId)) continue;
    // 快照不完整（如合成样本只覆盖部分商品）时不能推断"平台不存在"，否则会全量误报。
    if (snapshot.complete === false) continue;
    drifts.push(
      baseRecord(options, {
        kind: 'local_published_missing_platform',
        severity: 'high',
        listingId: listing.listingId,
        platformItemId: listing.platformItemId,
        platformSkuId: null,
        skuId: null,
        local: listingSummary(listing),
        platformValue: null,
        detail: listing.platformItemId
          ? `本地 listing 状态 ${listing.status}，但平台快照中不存在商品 ${listing.platformItemId}`
          : `本地 listing 状态 ${listing.status}，但没有绑定 platform_item_id，无法在平台侧定位`,
      }),
    );
  }

  const deduped = new Map<string, DetectedDrift>();
  for (const drift of drifts) {
    if (!deduped.has(drift.drift_key)) deduped.set(drift.drift_key, drift);
  }
  return finalizeDrifts([...deduped.values()]);
}

// ---------------------------------------------------------------- 订单维度（t43）

function orderSummary(order: LocalOrderSnapshot): Record<string, unknown> {
  return {
    order_id: order.orderId,
    platform_order_id: order.platformOrderId,
    status: order.status,
    refund_status: order.refundStatus,
    total_cents: order.totalCents,
    paid_cents: order.paidCents,
    item_count: order.items.length,
  };
}

function platformOrderSummary(order: PlatformOrderSnapshot): Record<string, unknown> {
  return {
    platform_order_id: order.platformOrderId,
    status: order.status,
    refund_status: order.refundStatus,
    total_cents: order.totalCents,
    paid_cents: order.paidCents,
    platform_created_at: order.platformCreatedAt,
    item_count: order.items.length,
  };
}

/**
 * 订单差异：平台有本地无 / 本地有平台无 / 金额不符 / 状态不符（含退款状态）/ 明细不符。
 * 金额取 `total_cents + paid_cents` 一起比较（只看一个数字容易漏运费/优惠差异）。
 */
export function diffOrders(
  localOrders: readonly LocalOrderSnapshot[],
  snapshot: PlatformSnapshot,
  options: DiffOptions,
): DetectedDrift[] {
  const drifts: DetectedDrift[] = [];
  const localByOrder = new Map(localOrders.map((order) => [order.platformOrderId, order]));
  const platformOrders = new Map(snapshot.orders.map((order) => [order.platformOrderId, order]));

  for (const order of snapshot.orders) {
    const local = localByOrder.get(order.platformOrderId);
    if (!local) {
      drifts.push(
        baseRecord(options, {
          kind: 'order_platform_only',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          platformOrderId: order.platformOrderId,
          local: null,
          platformValue: platformOrderSummary(order),
          detail: `平台订单 ${order.platformOrderId} 在本地不存在（金额 ${order.paidCents} 分，状态 ${order.status}）`,
        }),
      );
      continue;
    }

    if (local.totalCents !== order.totalCents || local.paidCents !== order.paidCents) {
      drifts.push(
        baseRecord(options, {
          kind: 'order_amount_mismatch',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          orderId: local.orderId,
          platformOrderId: order.platformOrderId,
          local: orderSummary(local),
          platformValue: platformOrderSummary(order),
          detail:
            `平台订单 ${order.platformOrderId} 金额不一致：` +
            `total ${local.totalCents}→${order.totalCents} 分，paid ${local.paidCents}→${order.paidCents} 分`,
        }),
      );
    }

    const statusDiff = local.status !== order.status;
    const refundDiff =
      local.refundStatus !== null &&
      order.refundStatus !== null &&
      local.refundStatus !== order.refundStatus;
    if (statusDiff || refundDiff) {
      drifts.push(
        baseRecord(options, {
          kind: 'order_status_mismatch',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          orderId: local.orderId,
          platformOrderId: order.platformOrderId,
          local: orderSummary(local),
          platformValue: platformOrderSummary(order),
          detail:
            `平台订单 ${order.platformOrderId} 状态不一致：` +
            `订单状态 ${local.status}→${order.status}${statusDiff ? '（不符）' : '（一致）'}，` +
            `退款状态 ${local.refundStatus ?? 'null'} vs ${order.refundStatus ?? 'null'}`,
        }),
      );
    }

    const localItems = new Map(local.items.map((item) => [item.platformSkuRef, item]));
    const platformRefs = new Set<string>();
    for (const item of order.items) {
      platformRefs.add(item.platformSkuRef);
      const localItem = localItems.get(item.platformSkuRef);
      if (!localItem) {
        drifts.push(
          baseRecord(options, {
            kind: 'order_item_mismatch',
            severity: 'medium',
            listingId: null,
            platformItemId: null,
            platformSkuId: null,
            skuId: null,
            orderId: local.orderId,
            platformOrderId: order.platformOrderId,
            platformSkuRef: item.platformSkuRef,
            local: null,
            platformValue: { platform_sku_ref: item.platformSkuRef, qty: item.qty, unit_price_cents: item.unitPriceCents },
            detail: `平台订单 ${order.platformOrderId} 的明细 ${item.platformSkuRef} 在本地缺失（数量 ${item.qty}）`,
          }),
        );
        continue;
      }
      if (
        localItem.qty !== item.qty ||
        localItem.unitPriceCents !== item.unitPriceCents ||
        localItem.amountCents !== item.amountCents
      ) {
        drifts.push(
          baseRecord(options, {
            kind: 'order_item_mismatch',
            severity: 'medium',
            listingId: null,
            platformItemId: null,
            platformSkuId: null,
            skuId: null,
            orderId: local.orderId,
            platformOrderId: order.platformOrderId,
            orderItemId: localItem.orderItemId,
            platformSkuRef: item.platformSkuRef,
            local: {
              order_item_id: localItem.orderItemId,
              qty: localItem.qty,
              unit_price_cents: localItem.unitPriceCents,
              amount_cents: localItem.amountCents,
            },
            platformValue: {
              platform_sku_ref: item.platformSkuRef,
              qty: item.qty,
              unit_price_cents: item.unitPriceCents,
              amount_cents: item.amountCents,
            },
            detail:
              `平台订单 ${order.platformOrderId} 明细 ${item.platformSkuRef} 不一致：` +
              `qty ${localItem.qty}→${item.qty}，单价 ${localItem.unitPriceCents}→${item.unitPriceCents} 分，` +
              `金额 ${localItem.amountCents}→${item.amountCents} 分`,
          }),
        );
      }
    }
    for (const localItem of local.items) {
      if (platformRefs.has(localItem.platformSkuRef)) continue;
      drifts.push(
        baseRecord(options, {
          kind: 'order_item_mismatch',
          severity: 'medium',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          orderId: local.orderId,
          platformOrderId: order.platformOrderId,
          orderItemId: localItem.orderItemId,
          platformSkuRef: localItem.platformSkuRef,
          local: { order_item_id: localItem.orderItemId, qty: localItem.qty, unit_price_cents: localItem.unitPriceCents },
          platformValue: null,
          detail: `本地订单 ${order.platformOrderId} 的明细 ${localItem.platformSkuRef} 在平台快照中不存在`,
        }),
      );
    }
  }

  if (snapshot.ordersComplete !== false) {
    for (const local of localOrders) {
      if (platformOrders.has(local.platformOrderId)) continue;
      drifts.push(
        baseRecord(options, {
          kind: 'order_local_only',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          orderId: local.orderId,
          platformOrderId: local.platformOrderId,
          local: orderSummary(local),
          platformValue: null,
          detail: `本地订单 ${local.platformOrderId} 在平台快照中不存在（状态 ${local.status}，实收 ${local.paidCents} 分）`,
        }),
      );
    }
  }

  return finalizeDrifts(drifts);
}

// ---------------------------------------------------------------- 售后维度（t43）

/**
 * 售后差异（t43 + t48/D12）：
 * - 退款金额不符、售后状态不符（平台已关闭而本地仍 open 必须报出）；
 * - **平台有、本地完全没有**（`after_sale_platform_only`）：这类差异的代价被低估过 ——
 *   平台上有一笔退款而本地零记录，意味着同步失败或有人绕过系统退款，是**最该报警**的一类。
 *   因此宁可多报也不漏报；但**本地已有同 `platform_after_sale_id`** 时只走金额/状态差异，
 *   不重复报"本地无"（那是字段不一致，不是缺失）。
 */
export function diffAfterSales(
  localAfterSales: readonly LocalAfterSaleSnapshot[],
  snapshot: PlatformSnapshot,
  options: DiffOptions,
): DetectedDrift[] {
  const drifts: DetectedDrift[] = [];
  const localBy = new Map(localAfterSales.map((row) => [row.platformAfterSaleId, row]));
  const platformByOrder = new Map(snapshot.orders.map((order) => [order.platformOrderId, order]));

  for (const afterSale of snapshot.afterSales) {
    const local = localBy.get(afterSale.platformAfterSaleId);
    const order = platformByOrder.get(afterSale.platformOrderId) ?? null;

    if (!local) {
      // D12：平台有、本地完全没有这条售后记录 → 报（不自动补录，交人工判断同步失败还是绕过系统）。
      drifts.push(
        baseRecord(options, {
          kind: 'after_sale_platform_only',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          platformAfterSaleId: afterSale.platformAfterSaleId,
          platformOrderId: afterSale.platformOrderId,
          local: null,
          platformValue: {
            platform_after_sale_id: afterSale.platformAfterSaleId,
            platform_order_id: afterSale.platformOrderId,
            kind: afterSale.kind,
            status: afterSale.status,
            amount_cents: afterSale.amountCents,
            order_status: order?.status ?? null,
          },
          detail:
            `平台售后 ${afterSale.platformAfterSaleId}（订单 ${afterSale.platformOrderId}，` +
            `${afterSale.kind}，${afterSale.status}，退款 ${afterSale.amountCents} 分）在本地没有任何记录：` +
            '先核对是否同步失败，再确认是否有人绕过系统退款',
        }),
      );
      continue;
    }

    if (local.amountCents !== afterSale.amountCents) {
      drifts.push(
        baseRecord(options, {
          kind: 'after_sale_amount_mismatch',
          severity: 'high',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          afterSaleId: local.afterSaleId,
          platformAfterSaleId: afterSale.platformAfterSaleId,
          platformOrderId: afterSale.platformOrderId,
          local: { amount_cents: local.amountCents, status: local.status, platform_order_id: local.platformOrderId },
          platformValue: {
            amount_cents: afterSale.amountCents,
            status: afterSale.status,
            platform_order_id: afterSale.platformOrderId,
            order_status: order?.status ?? null,
          },
          detail: `平台售后 ${afterSale.platformAfterSaleId} 退款金额 ${afterSale.amountCents} 分，本地 ${local.amountCents} 分`,
        }),
      );
    }

    const localClosed = local.status === 'closed' || local.status === 'cancelled';
    const platformClosed = afterSale.status === 'closed' || afterSale.status === 'cancelled';
    if (local.status !== afterSale.status) {
      drifts.push(
        baseRecord(options, {
          kind: 'after_sale_status_mismatch',
          severity: platformClosed && !localClosed ? 'high' : 'medium',
          listingId: null,
          platformItemId: null,
          platformSkuId: null,
          skuId: null,
          afterSaleId: local.afterSaleId,
          platformAfterSaleId: afterSale.platformAfterSaleId,
          platformOrderId: afterSale.platformOrderId,
          local: { status: local.status, amount_cents: local.amountCents },
          platformValue: { status: afterSale.status, amount_cents: afterSale.amountCents },
          detail:
            `平台售后 ${afterSale.platformAfterSaleId} 状态不一致：` +
            `平台 ${afterSale.status}，本地 ${local.status}` +
            (platformClosed && !localClosed ? '（平台已关闭，本地仍 open）' : ''),
        }),
      );
    }
  }

  return finalizeDrifts(drifts);
}

/** 全维度对账（商品 + 订单 + 售后），供服务层直接调用。 */
export function diffAll(
  local: {
    listings: readonly LocalListingSnapshot[];
    orders: readonly LocalOrderSnapshot[];
    afterSales: readonly LocalAfterSaleSnapshot[];
  },
  snapshot: PlatformSnapshot,
  options: DiffOptions,
): DetectedDrift[] {
  return finalizeDrifts([
    ...diffSnapshots(local.listings, snapshot, options),
    ...diffOrders(local.orders, snapshot, options),
    ...diffAfterSales(local.afterSales, snapshot, options),
  ]);
}

function finalizeDrifts(drifts: readonly DetectedDrift[]): DetectedDrift[] {
  const deduped = new Map<string, DetectedDrift>();
  for (const drift of drifts) {
    if (!deduped.has(drift.drift_key)) deduped.set(drift.drift_key, drift);
  }
  return [...deduped.values()].sort((a, b) => {
    const order = (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99);
    return order !== 0 ? order : a.drift_key.localeCompare(b.drift_key);
  });
}

/** 按类型计数（日报与阈值用）。 */
export function countByKind(drifts: readonly DetectedDrift[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const drift of drifts) counts[drift.kind] = (counts[drift.kind] ?? 0) + 1;
  return counts;
}
