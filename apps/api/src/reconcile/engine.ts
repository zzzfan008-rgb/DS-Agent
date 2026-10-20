/**
 * 对账差异引擎（纯函数）—— 输入本地 listing 快照 + 平台商品快照，输出差异清单。
 *
 * 六类差异（验收要求 5 类，实际覆盖 6 类）：
 * 1. `platform_only_listing`：平台有商品、本地没有 listing；
 * 2. `local_published_missing_platform`：本地 published，但平台快照里没有该商品（删除/下架到不可见）；
 * 3. `local_published_platform_offline`：本地 published，平台态为下架；
 * 4. `price_mismatch`：同一平台 SKU 的价格不一致；
 * 5. `stock_mismatch`：同一平台 SKU 的库存不一致；
 * 6. `state_mismatch`：平台驳回/违规下架，本地仍以为在架。
 *
 * 设计约束：
 * - **只读**：函数无副作用，不碰数据库；
 * - **不猜**：任一侧为 `null` 的值不比较（未知 ≠ 不一致）；
 * - **可复现**：`drift_key` 只由 `platform + kind + listing_id + platform_item_id + platform_sku_id`
 *   决定（不含 day，day 是存储维度），同一天重复对账得到同一 key。
 */

import { createHash } from 'node:crypto';
import {
  type DetectedDrift,
  type DiffOptions,
  type DriftKind,
  type FixSuggestion,
  type LocalListingSnapshot,
  type PlatformItemSnapshot,
  type PlatformSnapshot,
  DRIFT_KINDS,
  isLocallyLive,
  normalizePlatformState,
} from './types.js';

const KIND_ORDER = new Map<DriftKind, number>(DRIFT_KINDS.map((kind, index) => [kind, index]));

/** `drift_key` 的参与字段（顺序固定，改动即视为键规则变更，见验收文档 §4）。 */
export interface DriftKeyParts {
  platform: string;
  kind: DriftKind;
  listingId: string | null;
  platformItemId: string | null;
  platformSkuId: string | null;
}

/**
 * 去重键 = `dk_` + sha256(`platform|kind|listing_id|platform_item_id|platform_sku_id`)[0..31]。
 * 空值以空串参与；不含 day（存储层用 `(day, platform, drift_key)` 唯一）。
 */
export function buildDriftKey(parts: DriftKeyParts): string {
  const canonical = [
    parts.platform,
    parts.kind,
    parts.listingId ?? '',
    parts.platformItemId ?? '',
    parts.platformSkuId ?? '',
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
    local: Record<string, unknown> | null;
    platformValue: Record<string, unknown> | null;
    detail: string;
  },
): DetectedDrift {
  const drift_key = buildDriftKey({
    platform: options.platform,
    kind: input.kind,
    listingId: input.listingId,
    platformItemId: input.platformItemId,
    platformSkuId: input.platformSkuId,
  });
  return {
    drift_key,
    platform: options.platform,
    day: options.day,
    kind: input.kind,
    severity: input.severity,
    subject: {
      type: input.platformSkuId ? 'sku' : input.listingId ? 'listing' : 'platform_item',
      listing_id: input.listingId,
      platform_item_id: input.platformItemId,
      sku_id: input.skuId,
      platform_sku_id: input.platformSkuId,
    },
    local: input.local,
    platform_value: input.platformValue,
    detail: input.detail,
    suggestion: suggestionFor(input.kind),
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
