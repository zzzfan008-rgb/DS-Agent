/**
 * 审批 view model 归一化。
 *
 * 服务端 `diff[]` / `fact_snapshot{}` 的最终形状在 M4 才固化（docs/12 §3.5 只给了字段名）；
 * M1 演示数据与未来 API 都经这里归一，页面组件只消费 `ApprovalDetailView`。
 */
import type {
  ApprovalDetailRaw,
  ApprovalDetailView,
  ApprovalDiffItem,
  ApprovalHistoryItem,
  FactChipView,
  RiskLevel,
  RiskMeta,
} from './contracts';
import { stringifyValue } from './format';

export const ACTION_LABELS: Record<string, string> = {
  'listing.replace_main_image': '更换主图',
  'listing.update_price': '调整售价',
  'listing.update_stock': '更新库存',
  'listing.update_title': '更新商品标题',
  'listing.publish': '发布商品',
  'listing.rollback': '回滚平台写入',
  'listing.stop_loss': '止损操作',
  'reply.send': '发送客服消息',
  'inquiry.send_quote': '发送报价',
  'content.publish': '发布文案',
  'model.publish': '发布模型',
  'kb.delete': '归档知识文档',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  approved: '已批准',
  rejected: '已驳回',
  expired: '已过期',
  cancelled: '已取消',
  escalated: '已升级',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function riskLabel(level: RiskLevel): string {
  if (level === 'A') return 'A · 可逆';
  if (level === 'B') return 'B · 不可撤回';
  return 'C · 不可逆';
}

export function riskIcon(level: RiskLevel): string {
  if (level === 'A') return '↺';
  if (level === 'B') return '⚠';
  return '⛔';
}

const IMPACT_LABELS: Record<string, { label: string; format?: (value: unknown) => string }> = {
  sku_count: { label: 'SKU 数', format: (value) => `${String(value)} 个` },
  skus: { label: 'SKU 数', format: (value) => `${String(value)} 个` },
  estimated_orders: { label: '预估影响订单', format: (value) => `${String(value)} 单` },
  orders: { label: '预估影响订单', format: (value) => `${String(value)} 单` },
  price_change_pct: {
    label: '价格变动',
    format: (value) => {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) return stringifyValue(value);
      return `${number > 0 ? '+' : ''}${number}%`;
    },
  },
  activity: { label: '活动' },
  stock_before: { label: '当前库存' },
  stock_after: { label: '变更后库存' },
  affected_skus: { label: '涉及 SKU' },
  customers: { label: '影响客户', format: (value) => `${String(value)} 人` },
};

function normalizeImpact(scope: Record<string, unknown> | null | undefined) {
  if (!scope) return [];
  return Object.entries(scope)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      const known = IMPACT_LABELS[key];
      return {
        key,
        label: known?.label ?? key,
        value: known?.format ? known.format(value) : stringifyValue(value),
      };
    });
}

function normalizeDiff(items: ApprovalDiffItem[] | null | undefined) {
  if (!items) return [];
  return items.map((item) => ({
    field: item.field,
    label: item.label ?? item.field,
    before: stringifyValue(item.before),
    after: stringifyValue(item.after),
    risk: item.risk ?? null,
  }));
}

const FACT_LABELS: Record<string, string> = {
  product_version: '主数据版本',
  main_data_version: '主数据版本',
  size_chart_version: '尺码表版本',
  policy_version: '政策版本',
  media_license: '图片授权',
  license_ref: '图片授权',
  kb_refs: '知识库切片',
};

function factChips(snapshot: Record<string, unknown> | null | undefined): FactChipView[] {
  if (!snapshot) return [];
  const chips: FactChipView[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === null || value === undefined || value === '') continue;
    if (key === 'kb_refs' && Array.isArray(value)) {
      for (const [index, ref] of value.entries()) {
        const item = (typeof ref === 'object' && ref !== null ? ref : {}) as Record<string, unknown>;
        const title = typeof item.title === 'string' ? item.title : `切片 ${index + 1}`;
        const effectiveAt = typeof item.effective_at === 'string' ? item.effective_at : '';
        chips.push({
          key: `kb_refs_${index}`,
          label: `知识库 · ${title}`,
          detail: effectiveAt ? `生效日期 ${effectiveAt}` : '来自知识库（可展开查看）',
        });
      }
      continue;
    }
    if (Array.isArray(value)) {
      chips.push({
        key,
        label: FACT_LABELS[key] ?? key,
        detail: stringifyValue(value),
      });
      continue;
    }
    chips.push({
      key,
      label: FACT_LABELS[key] ?? key,
      detail: stringifyValue(value),
    });
  }
  return chips;
}

function normalizeHistory(items: ApprovalHistoryItem[] | null | undefined) {
  if (!items) return [];
  return items.map((item) => ({
    at: item.at,
    actor: item.actor ?? '系统',
    action: item.action,
    comment: item.comment ?? null,
  }));
}

function readMetaString(meta: RiskMeta | null | undefined, key: string): string | null {
  const value = meta?.[key];
  return typeof value === 'string' ? value : null;
}

export function normalizeApprovalDetail(raw: ApprovalDetailRaw): ApprovalDetailView {
  const meta = raw.risk_meta ?? null;
  const impact = normalizeImpact(meta?.impact_scope ?? null);
  const level = raw.level;
  const facts = factChips(raw.fact_snapshot ?? null);
  const history = normalizeHistory(raw.history ?? null);
  return {
    id: raw.id,
    object_type: raw.object_type,
    object_id: raw.object_id,
    action: raw.action,
    action_label: actionLabel(raw.action),
    level,
    platform: raw.platform,
    status: raw.status,
    sla_due_at: raw.sla_due_at ?? null,
    expires_at: raw.expires_at ?? null,
    requested_by: raw.requested_by ?? null,
    requested_at: raw.requested_at ?? null,
    batch_id: raw.batch_id ?? null,
    target_hash: raw.target_hash ?? null,
    risk_notes: raw.risk_notes ?? [],
    window_hint:
      readMetaString(meta, 'window_hint') ??
      (typeof (raw as Record<string, unknown>).window_hint === 'string'
        ? ((raw as Record<string, unknown>).window_hint as string)
        : null),
    impact_scope: impact,
    diff: normalizeDiff(raw.diff),
    facts,
    history,
    allowed_decisions: raw.allowed_decisions ?? [],
    approver:
      raw.approver ??
      readMetaString(meta, 'approver') ??
      (raw.decided_by as string | null | undefined) ??
      null,
    executor: raw.executor ?? readMetaString(meta, 'executor'),
    request_id: raw.request_id ?? null,
  };
}
