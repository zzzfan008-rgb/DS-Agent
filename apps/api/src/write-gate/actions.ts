/**
 * 动作注册表（docs/11 §6.2，唯一真相）。
 *
 * 级别只能由注册表 + computeLevel() 产出；前端传入的 level 一律忽略并审计。
 * approval.action 受 DB CHECK 限制，使用 DbApprovalAction；业务动作码保持 docs 命名。
 */
import { ApiError } from '../lib/errors.js';

export type Level = 'A' | 'B' | 'C';
export type Reversibility = 'reversible' | 'irreversible' | 'irreversible_high';

export type DbApprovalAction =
  | 'publish'
  | 'update_price'
  | 'update_stock'
  | 'replace_main_image'
  | 'change_category'
  | 'send_reply'
  | 'send_quote'
  | 'upload_video'
  | 'batch_offline'
  | 'publish_content';

export type WorkflowType =
  | 'publish'
  | 'price_change'
  | 'stock_sync'
  | 'media_generate'
  | 'reply'
  | 'quote'
  | 'reconcile'
  | 'kb_reindex'
  | 'batch_offline';

export type ActionCode =
  | 'listing.create'
  | 'listing.update_content'
  | 'listing.update_content_live'
  | 'listing.replace_main_image'
  | 'listing.update_price'
  | 'listing.update_price_draft'
  | 'listing.update_stock'
  | 'listing.update_category'
  | 'listing.update_key_attribute'
  | 'listing.update_minor_attribute'
  | 'listing.offline'
  | 'listing.online'
  | 'listing.batch_offline'
  | 'listing.batch_price'
  | 'message.send'
  | 'inquiry.quote'
  | 'inquiry.min_order_update'
  | 'listing.stop_loss'
  | 'listing.restore_snapshot'
  | 'content.publish';

export interface ActionMeta {
  code: ActionCode;
  approvalAction: DbApprovalAction;
  level: Level;
  reversibility: Reversibility;
  workflowType: WorkflowType;
  /** kill switch 任务类型（docs/11 §9.1）。 */
  taskType: 'publish' | 'price' | 'stock' | 'message' | 'media' | 'sync' | 'batch';
  snapshotFields: string[];
  compensationTemplate: string;
  pddInterface: string;
  operation1688: string;
  /** 是否允许“覆盖写回快照”语义。 */
  allowsSnapshotRestore: boolean;
}

export const ACTION_REGISTRY: Record<ActionCode, ActionMeta> = {
  'content.publish': {
    code: 'content.publish',
    approvalAction: 'publish_content',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['title', 'published_snapshot'],
    compensationTemplate: '撤回/重新编辑并重新审批',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.create': {
    code: 'listing.create',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['status', 'title', 'platform_state', 'published_snapshot'],
    compensationTemplate: '下架并核对平台状态',
    pddInterface: 'product.publish',
    operation1688: 'item.publish',
    allowsSnapshotRestore: false,
  },
  'listing.update_content': {
    code: 'listing.update_content',
    approvalAction: 'publish',
    level: 'A',
    reversibility: 'reversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['title', 'published_snapshot'],
    compensationTemplate: 'none',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: true,
  },
  'listing.update_content_live': {
    code: 'listing.update_content_live',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['title', 'published_snapshot'],
    compensationTemplate: '重新上架并人工核对搜索表现',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.replace_main_image': {
    code: 'listing.replace_main_image',
    approvalAction: 'replace_main_image',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['main_image_id', 'published_snapshot'],
    compensationTemplate: '下架止损 + 复盘审核影响',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.update_price': {
    code: 'listing.update_price',
    approvalAction: 'update_price',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'price_change',
    taskType: 'price',
    snapshotFields: ['price_tiers', 'published_snapshot'],
    compensationTemplate: '恢复价格需重新审批，不得声称回滚',
    pddInterface: 'price.sku_update',
    operation1688: 'item.update_price',
    allowsSnapshotRestore: false,
  },
  'listing.update_price_draft': {
    code: 'listing.update_price_draft',
    approvalAction: 'update_price',
    level: 'A',
    reversibility: 'reversible',
    workflowType: 'price_change',
    taskType: 'price',
    snapshotFields: ['price_tiers'],
    compensationTemplate: 'none',
    pddInterface: 'price.sku_update',
    operation1688: 'item.update_price',
    allowsSnapshotRestore: true,
  },
  'listing.update_stock': {
    code: 'listing.update_stock',
    approvalAction: 'update_stock',
    level: 'A',
    reversibility: 'reversible',
    workflowType: 'stock_sync',
    taskType: 'stock',
    snapshotFields: ['sku_bindings'],
    compensationTemplate: 'none',
    pddInterface: 'stock.update',
    operation1688: 'item.update_stock',
    allowsSnapshotRestore: true,
  },
  'listing.update_category': {
    code: 'listing.update_category',
    approvalAction: 'change_category',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['platform_category_id', 'category_external_id'],
    compensationTemplate: '下架 + 资质重审',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.update_key_attribute': {
    code: 'listing.update_key_attribute',
    approvalAction: 'change_category',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['published_snapshot'],
    compensationTemplate: '下架 + 事实核对 + 重审',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.update_minor_attribute': {
    code: 'listing.update_minor_attribute',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['published_snapshot'],
    compensationTemplate: '人工核对描述差异',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: false,
  },
  'listing.offline': {
    code: 'listing.offline',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['status', 'platform_state'],
    compensationTemplate: '重新上架需重新审批',
    pddInterface: 'product.listing_status',
    operation1688: 'item.set_offline',
    allowsSnapshotRestore: false,
  },
  'listing.online': {
    code: 'listing.online',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['status', 'platform_state'],
    compensationTemplate: '下架止损',
    pddInterface: 'product.listing_status',
    operation1688: 'item.set_online',
    allowsSnapshotRestore: false,
  },
  'listing.batch_offline': {
    code: 'listing.batch_offline',
    approvalAction: 'batch_offline',
    level: 'C',
    reversibility: 'irreversible',
    workflowType: 'batch_offline',
    taskType: 'batch',
    snapshotFields: ['status'],
    compensationTemplate: '逐项核对并重新上架审批',
    pddInterface: 'product.listing_status',
    operation1688: 'item.set_offline',
    allowsSnapshotRestore: false,
  },
  'listing.batch_price': {
    code: 'listing.batch_price',
    approvalAction: 'batch_offline',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'price_change',
    taskType: 'batch',
    snapshotFields: ['price_tiers'],
    compensationTemplate: '逐项恢复价格需重新审批',
    pddInterface: 'price.sku_update',
    operation1688: 'item.update_price',
    allowsSnapshotRestore: false,
  },
  'message.send': {
    code: 'message.send',
    approvalAction: 'send_reply',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'reply',
    taskType: 'message',
    snapshotFields: [],
    compensationTemplate: '发送补偿说明',
    pddInterface: 'message.send',
    operation1688: 'message.send',
    allowsSnapshotRestore: false,
  },
  'inquiry.quote': {
    code: 'inquiry.quote',
    approvalAction: 'send_quote',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'quote',
    taskType: 'message',
    snapshotFields: [],
    compensationTemplate: '重新报价并说明差异',
    pddInterface: 'message.send',
    operation1688: 'quote.create',
    allowsSnapshotRestore: false,
  },
  'inquiry.min_order_update': {
    code: 'inquiry.min_order_update',
    approvalAction: 'send_quote',
    level: 'C',
    reversibility: 'irreversible_high',
    workflowType: 'quote',
    taskType: 'message',
    snapshotFields: [],
    compensationTemplate: '恢复起批条件需重新审批',
    pddInterface: 'product.update',
    operation1688: 'inquiry.min_order_update',
    allowsSnapshotRestore: false,
  },
  'listing.stop_loss': {
    code: 'listing.stop_loss',
    approvalAction: 'publish',
    level: 'B',
    reversibility: 'irreversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: ['status', 'platform_state'],
    compensationTemplate: '止损工单 + 影响面核对',
    pddInterface: 'product.listing_status',
    operation1688: 'item.set_offline',
    allowsSnapshotRestore: false,
  },
  'listing.restore_snapshot': {
    code: 'listing.restore_snapshot',
    approvalAction: 'publish',
    level: 'A',
    reversibility: 'reversible',
    workflowType: 'publish',
    taskType: 'publish',
    snapshotFields: [],
    compensationTemplate: 'none',
    pddInterface: 'product.update',
    operation1688: 'item.update_content',
    allowsSnapshotRestore: true,
  },
};

export const LEVEL_RANK: Record<Level, number> = { A: 1, B: 2, C: 3 };

export function maxLevel(...levels: Level[]): Level {
  return levels.reduce<Level>((max, level) => (LEVEL_RANK[level] > LEVEL_RANK[max] ? level : max), 'A');
}

export function getActionMeta(code: string): ActionMeta {
  const meta = (ACTION_REGISTRY as Record<string, ActionMeta | undefined>)[code];
  if (!meta) {
    throw new ApiError('validation_failed', `未知动作：${code}`, { detail: { action: code } });
  }
  return meta;
}

export function isIrreversible(meta: ActionMeta): boolean {
  return meta.reversibility !== 'reversible';
}

/** 运行时阻止伪回滚：只有 reversible 动作能走 restore_snapshot。 */
export function assertReversible(code: string): ActionMeta {
  const meta = getActionMeta(code);
  if (meta.reversibility !== 'reversible') {
    throw new ApiError('irreversible', `动作 ${code} 属 ${meta.reversibility}，不存在覆盖写回滚`, {
      detail: {
        action: code,
        reversibility: meta.reversibility,
        next_action: 'create_compensation',
      },
    });
  }
  return meta;
}

export interface LevelContext {
  listingStatus?: string | null;
  activityHit?: boolean;
  touchesMainImage?: boolean;
  touchesCategoryOrKeyAttr?: boolean;
  priceDeltaRatio?: number;
  affectedSkus?: number;
  irreversibleFields?: string[];
  firstPublish?: boolean;
  notOnline?: boolean;
}

export interface LevelDecision {
  level: Level;
  reasons: string[];
}

/**
 * docs/11 §6.3：逐条升级取 max；唯一允许降级：首次发布且未上线、无活动。
 * 不做“前端传入级别”入口。
 */
export function computeLevel(code: string, ctx: LevelContext = {}): LevelDecision {
  const meta = getActionMeta(code);
  let level = meta.level;
  const reasons: string[] = [`base=${meta.level}`];

  const raise = (next: Level, reason: string) => {
    const merged = maxLevel(level, next);
    if (merged !== level) {
      level = merged;
      reasons.push(`${reason}→${merged}`);
    }
  };

  if (ctx.listingStatus === 'published') raise('B', 'in_sale');
  if (ctx.activityHit === true) raise('C', 'activity_hit');
  if (ctx.touchesMainImage === true) raise('C', 'main_image');
  if (ctx.touchesCategoryOrKeyAttr === true) raise('C', 'category_or_key_attr');
  if ((ctx.priceDeltaRatio ?? 0) > 0.2) raise('C', 'price_delta>20%');
  if ((ctx.affectedSkus ?? 0) > 20) raise('B', 'affected_skus>20');
  if ((ctx.affectedSkus ?? 0) > 200) raise('C', 'affected_skus>200');
  if ((ctx.irreversibleFields ?? []).length > 0) raise('C', 'irreversible_fields');

  if (ctx.firstPublish === true && ctx.notOnline === true && ctx.activityHit !== true) {
    if (level === 'C') {
      level = 'B';
      reasons.push('first_publish_not_online_downgrade→B');
    }
  }
  return { level, reasons };
}

export function requiresSecondConfirm(level: Level): boolean {
  return level === 'C';
}
