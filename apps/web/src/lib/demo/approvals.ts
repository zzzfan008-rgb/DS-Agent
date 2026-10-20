/**
 * M1 审批演示数据（仅在 `GET /api/approvals` 返回 404 时使用）。
 *
 * 约束（队长确认 Q1）：
 * - 只在「端点未实现（404）」时回退；网络错误/5xx 一律错误态；
 * - 页面顶部与每条数据标 `DEMO`，不参与任何审批/写操作；
 * - id 统一 `demo-` 前缀，验收时一眼可辨。
 *
 * 字段对齐 docs/12 §3.5；`diff` 为 M1 view model，服务端最终形状 M4 固化。
 */
import type { ApprovalDetailRaw, ApprovalListData } from '@/lib/contracts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function iso(now: number, deltaMs: number): string {
  return new Date(now + deltaMs).toISOString();
}

interface Seed {
  id: string;
  action: string;
  level: 'A' | 'B' | 'C';
  platform: 'pdd' | '1688';
  status: 'pending' | 'approved' | 'rejected';
  object_type: string;
  object_id: string;
  requested_by: string;
  assignee: string | null;
  requested_at: number;
  sla_due_at: number | null;
  expires_at: number | null;
  decided_at?: number | null;
  decided_by?: string | null;
  batch_id?: string | null;
  risk_notes: string[];
  impact_scope: Record<string, unknown>;
  window_hint?: string | null;
  diff: Array<{ field: string; label: string; before: string; after: string; risk?: string }>;
  fact_snapshot: Record<string, unknown>;
  history: Array<{ at: number; actor: string; action: string; comment?: string }>;
  allowed_decisions: string[];
  approver: string | null;
  executor: string | null;
  target_hash: string;
  request_id: string;
}

const SEEDS: Seed[] = [
  {
    id: 'demo-c-main-image',
    action: 'listing.replace_main_image',
    level: 'C',
    platform: 'pdd',
    status: 'pending',
    object_type: 'listing',
    object_id: '01a15801-e04b-7370-8979-9f221e4d2846',
    requested_by: '王运营',
    assignee: '演示管理员',
    requested_at: -38 * MINUTE,
    sla_due_at: 22 * MINUTE,
    expires_at: 23 * HOUR + 14 * MINUTE,
    risk_notes: [
      '命中 618 活动，替换主图可能触发搜索降权',
      '该商品近 7 天第 3 次改主图',
      '审批人 ≠ 执行人；执行前需一次性 confirm-token',
    ],
    impact_scope: {
      sku_count: 4,
      estimated_orders: 12,
      price_change_pct: 0,
      activity: '618 大促（进行中）',
    },
    window_hint: '命中 618 活动 → 建议预约至 02:00–05:00，或先下架再改',
    diff: [
      { field: 'main_image', label: '主图', before: 'IMG-8821', after: 'IMG-9310', risk: '高' },
      { field: 'detail_first_image', label: '详情首图', before: 'IMG-8821', after: 'IMG-9310', risk: '中' },
    ],
    fact_snapshot: {
      product_version: '主数据 v14',
      size_chart_version: '尺码表 v3',
      kb_refs: [{ title: '退换政策', effective_at: '2026-09-01' }],
      media_license: 'AIGC-031',
    },
    history: [
      { at: -38 * MINUTE, actor: '王运营', action: '提交审批' },
      { at: -38 * MINUTE, actor: '系统', action: '事实快照', comment: '主数据 v14 / 尺码表 v3' },
    ],
    allowed_decisions: ['approve', 'reject'],
    approver: '李 admin',
    executor: null,
    target_hash: 'ab12c3d4e5f6',
    request_id: 'req_demo_c_main_image',
  },
  {
    id: 'demo-c-price',
    action: 'listing.update_price',
    level: 'C',
    platform: '1688',
    status: 'pending',
    object_type: 'listing',
    object_id: '01a15801-e0e0-7e11-b4a4-f7c9e69f7c98',
    requested_by: '李运营',
    assignee: '演示管理员',
    requested_at: -36 * MINUTE,
    sla_due_at: -18 * MINUTE,
    expires_at: 11 * HOUR,
    risk_notes: ['阶梯价改动影响 4 个 SKU 的起批价', '平台侧价格生效后不支持整单回滚'],
    impact_scope: {
      sku_count: 4,
      estimated_orders: 6,
      price_change_pct: -8,
      activity: '无',
    },
    window_hint: '建议在低峰期（02:00–06:00）执行，并在执行后 30 分钟内对账',
    diff: [
      { field: 'price_tier_1', label: '起批价', before: '¥129.00', after: '¥118.68', risk: '高' },
      { field: 'price_tier_2', label: '50 件价', before: '¥119.00', after: '¥109.48', risk: '中' },
    ],
    fact_snapshot: {
      product_version: '主数据 v14',
      policy_version: '报价政策 2026-10',
    },
    history: [
      { at: -36 * MINUTE, actor: '李运营', action: '提交审批' },
      { at: -30 * MINUTE, actor: '系统', action: 'SLA 提醒', comment: '已超时 18 分钟' },
    ],
    allowed_decisions: ['approve', 'reject'],
    approver: '李 admin',
    executor: null,
    target_hash: 'cd34e5f6a7b8',
    request_id: 'req_demo_c_price',
  },
  {
    id: 'demo-b-stock',
    action: 'listing.update_stock',
    level: 'B',
    platform: 'pdd',
    status: 'pending',
    object_type: 'listing',
    object_id: '01a15801-e096-77d0-829c-8e0d5fb46751',
    requested_by: '赵客服',
    assignee: '演示管理员',
    requested_at: -20 * MINUTE,
    sla_due_at: 3 * HOUR,
    expires_at: 24 * HOUR,
    risk_notes: ['库存下调后可能影响活动报名资格'],
    impact_scope: { sku_count: 2, stock_before: 120, stock_after: 80 },
    window_hint: null,
    diff: [
      { field: 'stock', label: '可售库存', before: '120', after: '80', risk: '中' },
    ],
    fact_snapshot: { product_version: '主数据 v14' },
    history: [{ at: -20 * MINUTE, actor: '赵客服', action: '提交审批' }],
    allowed_decisions: ['approve', 'approve_with_edit', 'reject'],
    approver: '演示管理员',
    executor: '赵客服',
    target_hash: 'ef56a7b8c9d0',
    request_id: 'req_demo_b_stock',
  },
  {
    id: 'demo-b-title',
    action: 'listing.update_title',
    level: 'B',
    platform: '1688',
    status: 'pending',
    object_type: 'listing',
    object_id: '01a15801-ea76-7160-a697-1e3635480321',
    requested_by: '王运营',
    assignee: '赵客服',
    requested_at: -35 * MINUTE,
    sla_due_at: -7 * MINUTE,
    expires_at: 22 * HOUR,
    risk_notes: ['标题改动会重新触发平台内容审核', '含类目关键词，需确认不触发违禁词'],
    impact_scope: { affected_skus: 6, activity: '无' },
    window_hint: null,
    diff: [
      {
        field: 'title',
        label: '商品标题',
        before: '纯棉短袖T恤 夏季新款',
        after: '260g重磅纯棉短袖T恤 夏季透气',
        risk: '中',
      },
    ],
    fact_snapshot: { product_version: '主数据 v14', kb_refs: [{ title: '标题规范', effective_at: '2026-08-15' }] },
    history: [
      { at: -35 * MINUTE, actor: '王运营', action: '提交审批' },
      { at: -10 * MINUTE, actor: '系统', action: 'SLA 提醒', comment: '已超时 7 分钟' },
    ],
    allowed_decisions: ['approve', 'approve_with_edit', 'reject'],
    approver: '演示管理员',
    executor: '王运营',
    target_hash: 'a1b2c3d4e5f6',
    request_id: 'req_demo_b_title',
  },
  {
    id: 'demo-a-stock',
    action: 'listing.update_stock',
    level: 'A',
    platform: 'pdd',
    status: 'pending',
    object_type: 'listing',
    object_id: '01a15801-e122-7722-bc49-a1cb05b9e249',
    requested_by: '赵客服',
    assignee: '演示管理员',
    requested_at: -4 * MINUTE,
    sla_due_at: 8 * MINUTE,
    expires_at: 24 * HOUR,
    risk_notes: [],
    impact_scope: { sku_count: 1, stock_before: 40, stock_after: 60 },
    window_hint: null,
    diff: [{ field: 'stock', label: '可售库存', before: '40', after: '60' }],
    fact_snapshot: { product_version: '主数据 v14' },
    history: [{ at: -4 * MINUTE, actor: '赵客服', action: '提交审批' }],
    allowed_decisions: ['approve', 'reject'],
    approver: '演示管理员',
    executor: '赵客服',
    target_hash: 'b2c3d4e5f6a7',
    request_id: 'req_demo_a_stock',
  },
  {
    id: 'demo-a-reply',
    action: 'reply.send',
    level: 'A',
    platform: 'pdd',
    status: 'pending',
    object_type: 'conversation',
    object_id: '01a15801-ea2d-7c12-b4c5-e2da16969e18',
    requested_by: '客服小周',
    assignee: '演示管理员',
    requested_at: -15 * MINUTE,
    sla_due_at: 45 * MINUTE,
    expires_at: 2 * HOUR,
    risk_notes: [],
    impact_scope: { customers: 1 },
    window_hint: null,
    diff: [
      {
        field: 'text',
        label: '回复内容',
        before: '—',
        after: '亲，已为您安排优先发货，预计 48 小时内发出。',
        risk: '低',
      },
    ],
    fact_snapshot: { policy_version: '退换政策 v5', kb_refs: [{ title: '发货时效', effective_at: '2026-10-01' }] },
    history: [{ at: -15 * MINUTE, actor: '客服小周', action: '生成并提交' }],
    allowed_decisions: ['approve', 'reject'],
    approver: '演示管理员',
    executor: '客服小周',
    target_hash: 'c3d4e5f6a7b8',
    request_id: 'req_demo_a_reply',
  },
  {
    id: 'demo-approved-price',
    action: 'listing.update_price',
    level: 'B',
    platform: 'pdd',
    status: 'approved',
    object_type: 'listing',
    object_id: '01a15801-fc8d-7e73-83ac-fef8d06fdeca',
    requested_by: '李运营',
    assignee: '演示管理员',
    requested_at: -4 * HOUR,
    sla_due_at: null,
    expires_at: null,
    decided_at: -3 * HOUR,
    decided_by: '演示管理员',
    risk_notes: [],
    impact_scope: { sku_count: 1, price_change_pct: 5 },
    diff: [{ field: 'sale_price', label: '促销价', before: '¥99.00', after: '¥103.95', risk: '低' }],
    fact_snapshot: { product_version: '主数据 v14' },
    history: [
      { at: -4 * HOUR, actor: '李运营', action: '提交审批' },
      { at: -3 * HOUR, actor: '演示管理员', action: '批准并执行' },
    ],
    allowed_decisions: [],
    approver: '演示管理员',
    executor: '李运营',
    target_hash: 'd4e5f6a7b8c9',
    request_id: 'req_demo_approved_price',
  },
  {
    id: 'demo-rejected-image',
    action: 'listing.replace_main_image',
    level: 'C',
    platform: '1688',
    status: 'rejected',
    object_type: 'listing',
    object_id: '01a15801-e003-7b13-a531-ec95edf5a0c1',
    requested_by: '王运营',
    assignee: '演示管理员',
    requested_at: -26 * HOUR,
    sla_due_at: null,
    expires_at: null,
    decided_at: -24 * HOUR,
    decided_by: '演示管理员',
    risk_notes: ['驳回理由：活动期间不允许更换主图'],
    impact_scope: { sku_count: 3, activity: '双 11 预热（进行中）' },
    diff: [{ field: 'main_image', label: '主图', before: 'IMG-7710', after: 'IMG-9902', risk: '高' }],
    fact_snapshot: { product_version: '主数据 v13' },
    history: [
      { at: -26 * HOUR, actor: '王运营', action: '提交审批' },
      { at: -24 * HOUR, actor: '演示管理员', action: '驳回', comment: '活动期间不允许更换主图' },
    ],
    allowed_decisions: [],
    approver: '演示管理员',
    executor: '王运营',
    target_hash: 'e5f6a7b8c9d0',
    request_id: 'req_demo_rejected_image',
  },
];

function materialize(seed: Seed, now: number): ApprovalDetailRaw {
  return {
    id: seed.id,
    object_type: seed.object_type,
    object_id: seed.object_id,
    action: seed.action,
    level: seed.level,
    platform: seed.platform,
    status: seed.status,
    sla_due_at: seed.sla_due_at === null ? null : iso(now, seed.sla_due_at),
    expires_at: seed.expires_at === null ? null : iso(now, seed.expires_at),
    requested_by: seed.requested_by,
    requested_at: iso(now, seed.requested_at),
    decided_at: seed.decided_at ? iso(now, seed.decided_at) : null,
    decided_by: seed.decided_by ?? null,
    batch_id: seed.batch_id ?? null,
    target_hash: seed.target_hash,
    risk_notes: seed.risk_notes,
    risk_meta: {
      level: seed.level,
      impact_scope: seed.impact_scope,
      window_hint: seed.window_hint ?? null,
    },
    object: { current_platform_values: {} },
    diff: seed.diff,
    fact_snapshot: seed.fact_snapshot,
    history: seed.history.map((item) => ({
      at: iso(now, item.at),
      actor: item.actor,
      action: item.action,
      comment: item.comment ?? null,
    })),
    allowed_decisions: seed.allowed_decisions,
    approver: seed.approver,
    executor: seed.executor,
    assignee: seed.assignee,
    request_id: seed.request_id,
  };
}

export function demoApprovalDetails(now: number = Date.now()): ApprovalDetailRaw[] {
  return SEEDS.map((seed) => materialize(seed, now));
}

export function demoApprovalDetail(id: string, now: number = Date.now()): ApprovalDetailRaw | null {
  const seed = SEEDS.find((item) => item.id === id);
  return seed ? materialize(seed, now) : null;
}

export function demoApprovalList(now: number = Date.now()): ApprovalListData {
  const details = demoApprovalDetails(now);
  const pending = details.filter((item) => item.status === 'pending');
  const nowIso = new Date(now).toISOString();
  const oldestWait = pending.reduce((max, item) => {
    const requested = item.requested_at ? new Date(item.requested_at).getTime() : now;
    return Math.max(max, Math.floor((now - requested) / MINUTE));
  }, 0);
  const overdue = pending.filter(
    (item) => item.sla_due_at !== null && (item.sla_due_at ?? '') < nowIso,
  ).length;
  return {
    items: details.map((item) => ({
      id: item.id,
      object_type: item.object_type,
      object_id: item.object_id,
      action: item.action,
      level: item.level,
      platform: item.platform,
      status: item.status,
      sla_due_at: item.sla_due_at ?? null,
      overdue: item.sla_due_at !== null && (item.sla_due_at ?? '') < nowIso,
      risk_notes: item.risk_notes ?? [],
      risk_meta: item.risk_meta ?? undefined,
      requested_by: item.requested_by ?? null,
      requested_at: item.requested_at ?? null,
      batch_id: item.batch_id ?? null,
      assignee:
        typeof (item as Record<string, unknown>).assignee === 'string'
          ? ((item as Record<string, unknown>).assignee as string)
          : null,
    })),
    meta: {
      next_cursor: null,
      pending_count: pending.length,
      oldest_wait_minutes: oldestWait,
      overdue_count: overdue,
    },
  };
}
