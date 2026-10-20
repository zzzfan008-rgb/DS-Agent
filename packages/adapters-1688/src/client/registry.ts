/**
 * 1688 接口注册表（**桩**）—— docs/02 §二 的代码化。
 *
 * 设计原则（与 docs/02 §0、§6.1 步骤 3 一致）：
 * 1. **只登记能力，不登记 method**：每个操作的 `method` / `httpMethod` / `path` /
 *    `paramsIn` / `bodyFormat` / `signatureRequired` 全部为 `null`，并挂 TODO id；
 *    没有回填文档前，`Alibaba1688Client.execute()` 一律拒绝发送（不是"猜一个试试"）；
 * 2. **级别来自 docs/11 §6.2 的动作注册表**，不在这里发明级别；注册表里没有的动作
 *    （如发货、代发采购单）标 `actionCode=null` 并在 `notes` 写明「待补注册表」；
 * 3. 只读操作 `riskLevel=null`，但仍受 `TODO-1688-001/002` 阻塞 —— 因为 method 也未知；
 * 4. `channel` 明确区分「API / 平台导入包 / 人工」三条路径（docs/00 §8.1），
 *    避免把兜底路径伪装成自动化。
 */

import type { TodoId } from '../todo.js';
import { TODO_ITEMS } from '../todo.js';

/** 三条交付路径（docs/00 §8.1）。 */
export type OperationChannel = 'api' | 'import' | 'manual';

export type OperationCapability =
  | 'item'
  | 'category'
  | 'stock'
  | 'order'
  | 'dropship'
  | 'aftersale'
  | 'logistics'
  | 'price'
  | 'quote'
  | 'inquiry'
  | 'message'
  | 'media';

export type RiskLevel = 'A' | 'B' | 'C';

/** 未核验的协议字段占位（全表共用同一组 TODO）。 */
export const UNVERIFIED_PROTOCOL = {
  method: null,
  httpMethod: null,
  path: null,
  paramsIn: null,
  bodyFormat: null,
  signatureRequired: null,
} as const;

export interface OperationDescriptor {
  /** 我方操作 id（`<域>.<动作>`），不是平台 method。 */
  id: string;
  title: string;
  capability: OperationCapability;
  /** docs/02 的具体章节（便于回填时逐条对照）。 */
  docRef: string;
  channel: OperationChannel;
  /** docs/11 §6.2 的动作码；`null` = 注册表未收录（见 notes）。 */
  actionCode: string | null;
  riskLevel: RiskLevel | null;
  irreversible: boolean;
  /** 平台 method 名；**未核验一律 null**。 */
  method: string | null;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'DELETE' | null;
  path: string | null;
  paramsIn: 'query' | 'body' | null;
  bodyFormat: 'json' | 'form' | null;
  signatureRequired: boolean | null;
  /** 该操作还缺哪些平台事实。 */
  todoIds: TodoId[];
  notes: string;
}

interface OperationSeed {
  id: string;
  title: string;
  capability: OperationCapability;
  docRef: string;
  channel?: OperationChannel;
  actionCode?: string | null;
  riskLevel?: RiskLevel | null;
  irreversible?: boolean;
  todoIds: TodoId[];
  notes?: string;
}

function define(seed: OperationSeed): OperationDescriptor {
  return {
    id: seed.id,
    title: seed.title,
    capability: seed.capability,
    docRef: seed.docRef,
    channel: seed.channel ?? 'api',
    actionCode: seed.actionCode ?? null,
    riskLevel: seed.riskLevel ?? null,
    irreversible: seed.irreversible ?? (seed.riskLevel === 'B' || seed.riskLevel === 'C'),
    ...UNVERIFIED_PROTOCOL,
    todoIds: seed.todoIds,
    notes: seed.notes ?? '',
  };
}

const BASE_TODO: TodoId[] = ['TODO-1688-001', 'TODO-1688-002', 'TODO-1688-003', 'TODO-1688-004'];

const OPERATION_SEEDS: OperationSeed[] = [
  // ---- 商品发布 / 编辑 / 上下架（docs/02 §2.1）----
  {
    id: 'item.publish',
    title: '商品发布（新增）',
    capability: 'item',
    docRef: 'docs/02 §2.1#1',
    actionCode: 'listing.create',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-005', 'TODO-1688-006', 'TODO-1688-009', 'TODO-1688-010'],
    notes: '上架主链路；价格档位结构与规格 moq 字段未核验，先走导入包 + 人工',
  },
  {
    id: 'item.update_content',
    title: '商品编辑（在售标题/详情）',
    capability: 'item',
    docRef: 'docs/02 §2.1#2',
    actionCode: 'listing.update_content_live',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '编辑是否全量覆盖未核验；全量覆盖时须先读后写 + 快照',
  },
  {
    id: 'item.set_online',
    title: '重新上架',
    capability: 'item',
    docRef: 'docs/02 §2.1#3',
    actionCode: 'listing.online',
    riskLevel: 'B',
    todoIds: BASE_TODO,
  },
  {
    id: 'item.set_offline',
    title: '下架（止损常用）',
    capability: 'item',
    docRef: 'docs/02 §2.1#3',
    actionCode: 'listing.offline',
    riskLevel: 'B',
    todoIds: BASE_TODO,
  },
  {
    id: 'item.query',
    title: '商品详情 / 列表（只读）',
    capability: 'item',
    docRef: 'docs/02 §2.1#4',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '审核态与驳回原因是否结构化未核验',
  },
  {
    id: 'category.tree',
    title: '类目与属性字典（只读）',
    capability: 'category',
    docRef: 'docs/02 §2.1#5',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '属性 id/value id 未核验，platform_attribute_mapping 无法 verified',
  },
  {
    id: 'item.import_package',
    title: '导入包批量发布（兜底路径）',
    capability: 'item',
    docRef: 'docs/02 §2.1#6',
    channel: 'import',
    actionCode: 'listing.create',
    riskLevel: 'B',
    todoIds: ['TODO-1688-010'],
    notes: '无需 method；模板列名、行数上限、失败回执格式未核验',
  },

  // ---- 库存（docs/02 §2.2）----
  {
    id: 'item.update_stock',
    title: '库存更新（覆盖写）',
    capability: 'stock',
    docRef: 'docs/02 §2.2#1',
    actionCode: 'listing.update_stock',
    riskLevel: 'A',
    irreversible: false,
    todoIds: BASE_TODO,
    notes: 'quantity 语义（覆盖/增量）与三套库存数字未核验；按覆盖写 + 快照设计',
  },
  {
    id: 'stock.query',
    title: '库存查询（只读）',
    capability: 'stock',
    docRef: 'docs/02 §2.2#2',
    riskLevel: null,
    irreversible: false,
    todoIds: BASE_TODO,
  },

  // ---- 订单（docs/02 §2.3）----
  {
    id: 'order.list',
    title: '订单列表（买家/卖家视角）',
    capability: 'order',
    docRef: 'docs/02 §2.3#1',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-007'],
    notes: '订单类型（批发/代发/样品）与增量字段未核验',
  },
  {
    id: 'order.detail',
    title: '订单详情',
    capability: 'order',
    docRef: 'docs/02 §2.3#2',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-007'],
  },
  {
    id: 'order.ship',
    title: '发货',
    capability: 'order',
    docRef: 'docs/02 §2.3#3',
    riskLevel: 'B',
    irreversible: true,
    todoIds: [...BASE_TODO, 'TODO-1688-007'],
    notes: 'docs/11 §6.2 动作注册表未收录发货，级别按 docs/02 §2.3「B 级不可逆」暂定，待补注册表',
  },
  {
    id: 'dropship.purchase_order',
    title: '代发采购单',
    capability: 'dropship',
    docRef: 'docs/02 §2.3#4',
    riskLevel: 'C',
    irreversible: true,
    todoIds: [...BASE_TODO, 'TODO-1688-007', 'TODO-1688-011'],
    notes: '涉及付款与履约，注册表未收录，保守按 C 级；未核验前禁止自动化',
  },
  {
    id: 'aftersale.list',
    title: '售后 / 退款列表（只读）',
    capability: 'aftersale',
    docRef: 'docs/02 §2.3#5',
    riskLevel: null,
    irreversible: false,
    todoIds: BASE_TODO,
  },
  {
    id: 'logistics.track',
    title: '物流轨迹（只读）',
    capability: 'logistics',
    docRef: 'docs/02 §2.3#6',
    riskLevel: null,
    irreversible: false,
    todoIds: BASE_TODO,
  },

  // ---- 价格与报价（docs/02 §2.4）----
  {
    id: 'price.query',
    title: '价格查询（只读）',
    capability: 'price',
    docRef: 'docs/02 §2.4#2',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-005'],
  },
  {
    id: 'item.update_price',
    title: '改价（含阶梯档位）',
    capability: 'price',
    docRef: 'docs/02 §2.4#1',
    actionCode: 'listing.update_price',
    riskLevel: 'C',
    todoIds: [...BASE_TODO, 'TODO-1688-005'],
    notes: '改价与报价是两件事，不得合并实现（docs/02 §2.4 说明）',
  },
  {
    id: 'inquiry.min_order_update',
    title: '起批条件修改',
    capability: 'price',
    docRef: 'docs/02 §2.7#4',
    actionCode: 'inquiry.min_order_update',
    riskLevel: 'C',
    todoIds: [...BASE_TODO, 'TODO-1688-006'],
  },
  {
    id: 'quote.create',
    title: '报价单（对询盘报价）',
    capability: 'quote',
    docRef: 'docs/02 §2.4#3',
    channel: 'manual',
    actionCode: 'inquiry.quote',
    riskLevel: 'C',
    todoIds: [...BASE_TODO, 'TODO-1688-008'],
    notes: '默认人工：B 级不可逆 + 金额敏感（docs/02 H4）；接口核验前不提供自动报价',
  },

  // ---- 询盘与消息（docs/02 §2.5）----
  {
    id: 'inquiry.list',
    title: '询盘/会话拉取（只读）',
    capability: 'inquiry',
    docRef: 'docs/02 §2.5#1',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-008'],
  },
  {
    id: 'message.send',
    title: '消息发送（旺旺回复）',
    capability: 'message',
    docRef: 'docs/02 §2.5#2',
    actionCode: 'message.send',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-008'],
    notes: '发送后不可撤回；必须走应审批（B 级）+ 去重键',
  },
  {
    id: 'message.subscribe',
    title: '消息订阅配置',
    capability: 'message',
    docRef: 'docs/02 §2.5#3',
    riskLevel: 'B',
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-008'],
    notes: '订阅方式与事件清单未核验；变更订阅会影响秒级提醒入口',
  },
  {
    id: 'service.account',
    title: '客服账号 / 分流（只读）',
    capability: 'message',
    docRef: 'docs/02 §2.5#4',
    riskLevel: null,
    irreversible: false,
    todoIds: [...BASE_TODO, 'TODO-1688-008'],
  },

  // ---- 素材（docs/02 §2.6）----
  {
    id: 'media.upload_image',
    title: '图片上传',
    capability: 'media',
    docRef: 'docs/02 §2.6#1',
    actionCode: 'media.upload_platform',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '返回字段/CDN 有效期/审核态未核验；必须先过本地规范检查',
  },
  {
    id: 'media.upload_video',
    title: '视频上传',
    capability: 'media',
    docRef: 'docs/02 §2.6#2',
    actionCode: 'media.upload_platform',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '是否分片/断点续传/转码状态未核验',
  },
  {
    id: 'media.library',
    title: '图片空间 / 素材库（只读）',
    capability: 'media',
    docRef: 'docs/02 §2.6#3',
    riskLevel: null,
    irreversible: false,
    todoIds: BASE_TODO,
  },
  {
    id: 'media.detail_html',
    title: '图文详情写入',
    capability: 'media',
    docRef: 'docs/02 §2.6#4',
    actionCode: 'listing.update_content_live',
    riskLevel: 'B',
    todoIds: [...BASE_TODO, 'TODO-1688-009'],
    notes: '详情是结构化块还是 HTML、图片是否必须先上传到平台空间未核验',
  },
];

/** 操作注册表（按 id 索引）。 */
export const OPERATIONS: Readonly<Record<string, OperationDescriptor>> = Object.fromEntries(
  OPERATION_SEEDS.map((seed) => [seed.id, define(seed)]),
);

export const OPERATION_LIST: readonly OperationDescriptor[] = Object.values(OPERATIONS);

export interface OperationCatalog {
  get(id: string): OperationDescriptor | undefined;
}

/** 默认目录（真实注册表）。 */
export const DEFAULT_CATALOG: OperationCatalog = {
  get: (id) => OPERATIONS[id],
};

/** 读取操作；不存在返回 `undefined`（客户端会转成 `INVALID_REQUEST`）。 */
export function getOperation(id: string): OperationDescriptor | undefined {
  return OPERATIONS[id];
}

export function listOperations(): readonly OperationDescriptor[] {
  return OPERATION_LIST;
}

export function operationsByCapability(capability: OperationCapability): OperationDescriptor[] {
  return OPERATION_LIST.filter((operation) => operation.capability === capability);
}

export interface VerificationGap {
  field: string;
  todoId: TodoId;
  question: string;
}

/**
 * 该操作还缺哪些平台事实（用于 `plan()` 与错误信息）。
 * 只读操作同样会因为 method 未知而返回缺口 —— 这是刻意的。
 */
export function verificationGaps(descriptor: OperationDescriptor): VerificationGap[] {
  const gaps: VerificationGap[] = [];
  const push = (field: string, todoId: TodoId): void => {
    gaps.push({ field, todoId, question: TODO_ITEMS[todoId].question });
  };

  if (descriptor.channel === 'import') {
    push('template', 'TODO-1688-010');
    return gaps;
  }
  if (descriptor.channel === 'manual') {
    push('manual_process', 'TODO-1688-008');
  }
  if (descriptor.method === null) push('method', 'TODO-1688-001');
  if (descriptor.httpMethod === null) push('http_method', 'TODO-1688-002');
  if (descriptor.path === null) push('path', 'TODO-1688-002');
  if (descriptor.paramsIn === null) push('params_in', 'TODO-1688-002');
  if (descriptor.bodyFormat === null) push('body_format', 'TODO-1688-002');
  if (descriptor.signatureRequired === null) push('signature', 'TODO-1688-003');
  return gaps;
}

/** 注册表统计（验收文档用）。 */
export function registrySummary(): {
  total: number;
  byChannel: Record<OperationChannel, number>;
  byRisk: Record<'readonly' | RiskLevel, number>;
  openTodoCount: number;
} {
  const byChannel: Record<OperationChannel, number> = { api: 0, import: 0, manual: 0 };
  const byRisk: Record<'readonly' | RiskLevel, number> = { readonly: 0, A: 0, B: 0, C: 0 };
  for (const operation of OPERATION_LIST) {
    byChannel[operation.channel] += 1;
    byRisk[operation.riskLevel ?? 'readonly'] += 1;
  }
  return {
    total: OPERATION_LIST.length,
    byChannel,
    byRisk,
    openTodoCount: Object.values(TODO_ITEMS).filter((item) => item.status === 'open').length,
  };
}
