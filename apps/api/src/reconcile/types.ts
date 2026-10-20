/**
 * 对账领域类型 —— docs/12 §3.9/§3.11、docs/16 §5.2（W1 对账差异）。
 *
 * 定位：只做**只读比对**与**可执行修复建议**，不修改任何业务数据（任务约束：不自动修改，只产出待处理清单）。
 *
 * 平台侧数据来源：
 * - `recorded`：录制/合成样本（M8 机制验证；明确标注 synthetic，不冒充真实平台数据）；
 * - `adapter`：真实 reader 依赖 adapter 契约；1688/PDD 均未核验，调用即硬拒绝（`publish_blocked` + TODO 列表）。
 */

export type Platform = 'pdd' | '1688';

/** 差异类型（与验收文档 §3 一一对应）。 */
export type DriftKind =
  // 商品/上架维度（t36）
  | 'platform_only_listing'
  | 'local_published_missing_platform'
  | 'local_published_platform_offline'
  | 'price_mismatch'
  | 'stock_mismatch'
  | 'state_mismatch'
  // 订单维度（t43，表来自 t37）
  | 'order_platform_only'
  | 'order_local_only'
  | 'order_amount_mismatch'
  | 'order_status_mismatch'
  | 'order_item_mismatch'
  // 售后维度（t43）
  | 'after_sale_amount_mismatch'
  | 'after_sale_status_mismatch';

export const DRIFT_KINDS: readonly DriftKind[] = [
  'platform_only_listing',
  'local_published_missing_platform',
  'local_published_platform_offline',
  'price_mismatch',
  'stock_mismatch',
  'state_mismatch',
  'order_platform_only',
  'order_local_only',
  'order_amount_mismatch',
  'order_status_mismatch',
  'order_item_mismatch',
  'after_sale_amount_mismatch',
  'after_sale_status_mismatch',
];

/** 本地 listing 的只读快照（来自 `listing` + `sku_bindings`）。 */
export interface LocalListingSnapshot {
  listingId: string;
  platformItemId: string | null;
  status: string;
  platformState: string | null;
  title: string | null;
  updatedAt: string;
  rejectMeta: unknown;
  skuBindings: Array<{
    skuId: string | null;
    platformSkuId: string | null;
    priceCents: number | null;
    stockQty: number | null;
  }>;
}

/** 平台商品快照（由 reader 提供；字段名按我方内部口径，不代表平台字段名）。 */
export interface PlatformSkuSnapshot {
  platformSkuId: string;
  priceCents: number | null;
  stockQty: number | null;
}

export interface PlatformItemSnapshot {
  itemId: string;
  title: string | null;
  /** 平台原始态（字符串，未核验前不枚举死；常见值见 docs/06 `listing.platform_state`）。 */
  state: string;
  updatedAt: string | null;
  skus: PlatformSkuSnapshot[];
}

export interface PlatformSnapshot {
  platform: Platform;
  capturedAt: string;
  source: 'recorded' | 'adapter' | 'live';
  /** 该快照是否来自真实平台（合成样本必须为 false）。 */
  verified: boolean;
  /**
   * 商品快照是否"完整"（覆盖平台全部商品）。
   * `false` 时禁止据它推断"本地 published 但平台不存在"，否则样本不全 → 全量误报。
   */
  complete: boolean;
  /** 订单快照是否完整；`false` 时跳过"本地有平台无"的推断。 */
  ordersComplete: boolean;
  /** 售后快照是否完整。 */
  afterSalesComplete: boolean;
  note: string;
  items: PlatformItemSnapshot[];
  orders: PlatformOrderSnapshot[];
  afterSales: PlatformAfterSaleSnapshot[];
}

// ---------------------------------------------------------------- 订单 / 售后快照

/** 平台订单明细（`order_items` 的对照面；字段按内部口径）。 */
export interface PlatformOrderItemSnapshot {
  platformSkuRef: string;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
}

export interface PlatformOrderSnapshot {
  platformOrderId: string;
  status: string;
  totalCents: number;
  paidCents: number;
  /** 平台侧退款状态（可空；`refunded`/`refunding`/`none` 等，未核验前不枚举死）。 */
  refundStatus: string | null;
  platformCreatedAt: string;
  items: PlatformOrderItemSnapshot[];
}

export interface PlatformAfterSaleSnapshot {
  platformAfterSaleId: string;
  platformOrderId: string;
  kind: string;
  status: string;
  amountCents: number;
}

/** 本地订单只读快照（来自 `orders` + `order_items` + `after_sale`）。 */
export interface LocalOrderSnapshot {
  orderId: string;
  platformOrderId: string;
  status: string;
  totalCents: number;
  paidCents: number;
  /** 由本地售后状态推导（`refunded`/`refunding`/`none`）。 */
  refundStatus: string | null;
  items: Array<{
    orderItemId: string;
    platformSkuRef: string;
    qty: number;
    unitPriceCents: number;
    amountCents: number;
  }>;
}

export interface LocalAfterSaleSnapshot {
  afterSaleId: string;
  platformAfterSaleId: string;
  platformOrderId: string;
  status: string;
  amountCents: number;
}

export interface FixAction {
  /** read = 只读核对；write = 走写入门；manual = 人工处理。 */
  kind: 'read' | 'write' | 'manual';
  /** 动作码（对齐 docs/11 §6.2 与 docs/12 端点）。 */
  action: string;
  /** 写操作级别；只读/人工为 null。 */
  level: 'A' | 'B' | 'C' | null;
  requires_approval: boolean;
  /** 已有 API 时给出端点；依赖未核验 adapter 的为 null。 */
  endpoint: string | null;
  note: string;
}

export interface FixSuggestion {
  summary: string;
  actions: FixAction[];
  doc_refs: string[];
  /** 恒为 false：M8 只产出清单，不自动改（任务硬约束）。 */
  auto_fixable: false;
}

export interface DriftSubject {
  type: 'listing' | 'platform_item' | 'sku' | 'order' | 'order_item' | 'after_sale';
  listing_id: string | null;
  platform_item_id: string | null;
  sku_id: string | null;
  platform_sku_id: string | null;
  order_id: string | null;
  platform_order_id: string | null;
  order_item_id: string | null;
  platform_sku_ref: string | null;
  after_sale_id: string | null;
  platform_after_sale_id: string | null;
}

export interface DriftRecord {
  /** 去重键；同一天同 key 只更新不新增（构造规则见 docs/验收记录-M8-对账日报.md §4）。 */
  drift_key: string;
  platform: Platform;
  day: string;
  kind: DriftKind;
  severity: 'low' | 'medium' | 'high';
  subject: DriftSubject;
  local: Record<string, unknown> | null;
  platform_value: Record<string, unknown> | null;
  detail: string;
  suggestion: FixSuggestion;
  status: 'open';
  detected_at: string;
  first_detected_at: string;
  last_detected_at: string;
  seen_count: number;
}

/** 引擎输出（未落库）：不含 first/last/seen。 */
export type DetectedDrift = Omit<DriftRecord, 'first_detected_at' | 'last_detected_at' | 'seen_count'>;

export interface DiffOptions {
  platform: Platform;
  day: string;
  /** 生成时刻（ISO）；写入 detected_at。 */
  now: string;
}

/** 平台态归一：下架 / 驳回·违规 / 在线。未核验前只按关键词匹配，不硬编码平台枚举。 */
export type NormalizedPlatformState = 'online' | 'offline' | 'rejected';

const REJECTED_HINTS = ['reject', 'violation', 'risk_hold', 'violat', 'audit_fail', '驳回', '违规'];
const OFFLINE_HINTS = ['offline', 'deleted', 'removed', 'unpublished', '下架', '删除'];

export function normalizePlatformState(state: string | null | undefined): NormalizedPlatformState {
  if (!state) return 'online';
  const text = state.toLowerCase();
  if (REJECTED_HINTS.some((hint) => text.includes(hint))) return 'rejected';
  if (OFFLINE_HINTS.some((hint) => text.includes(hint))) return 'offline';
  return 'online';
}

/** 本地认为"应该在架"的状态（docs/06 §3.4）。 */
export function isLocallyLive(status: string): boolean {
  return status === 'published' || status === 'publishing';
}
