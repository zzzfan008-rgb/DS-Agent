/**
 * 代发（一件代发）领域模型 —— docs/02 §2.7#5、判定规则 H3、`TODO-1688-007/011`。
 *
 * 事实边界：
 * - 代发价、代发库存、面单来源、退货地址、时效承诺的平台字段**全部未核验**；
 * - `dropship_terms` 在 docs/06 / t1 迁移里**没有承载列**（`TODO-1688-PERSIST-01`），
 *   本模块只做内部建模；导出上架包时标 `persisted: false`，禁止假装已落库；
 * - 本模块**不存明文地址**：`returnAddressRef` 只接受引用键（如 `addr:dropship-hz-01`），
 *   明文收件/退货地址属于 PII，只能留在受控存储（docs/20 存储边界）。
 */

import { DomainValidationError } from '../errors.js';
import {
  asRecord,
  blocker,
  describeValue,
  failure,
  success,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';
import { isPriceCents, isQty } from './money.js';
import type { TodoId } from '../todo.js';

/** 代发库存口径：自营仓 / 供应商仓 / 以平台为准。 */
export const DROPSHIP_STOCK_SOURCES = ['self', 'supplier', 'platform_sync'] as const;
export type DropshipStockSource = (typeof DROPSHIP_STOCK_SOURCES)[number];

export interface DropshipTerms {
  enabled: boolean;
  /** 代发价（整数分）；未启用时必须为 null（避免出现「隐藏的代发价」）。 */
  dropshipPriceCents: number | null;
  /** 承诺发货时效（天），对齐 `product_sku.lead_time_days` 的 0–60。 */
  leadTimeDays: number | null;
  /** 退货地址/代发仓引用键，非明文地址。 */
  returnAddressRef: string | null;
  stockSource: DropshipStockSource;
  /** 代发起订量（通常 1，但 B2B 允许更高）。 */
  minOrderQty: number;
  /** 该模型尚未落库的原因（TODO-1688-PERSIST-01）。 */
  todos: TodoId[];
}

/** 本模型全部字段的平台映射都未核验（docs/02 §2.7#5）。 */
export const DROPSHIP_TODO_IDS: TodoId[] = ['TODO-1688-007', 'TODO-1688-011', 'TODO-1688-PERSIST-01'];

/** 引用键：`addr:` / `warehouse:` 前缀 + 字母数字，禁止空格、URL、中文地址。 */
const ADDRESS_REF_RE = /^(addr|warehouse|return):[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/;

/** 校验代发条款；不通过抛 `DomainValidationError`。 */
export function validateDropship(raw: unknown): ValidationResult<DropshipTerms> {
  const row = asRecord(raw);
  if (!row) {
    return failure([blocker('DROPSHIP_TYPE', 'dropship', '对象', describeValue(raw), '代发条款必须是对象')]);
  }
  const issues: ValidationIssue[] = [];
  const enabled = row.enabled;
  const dropshipPriceCents = row.dropshipPriceCents ?? null;
  const leadTimeDays = row.leadTimeDays ?? null;
  const returnAddressRef = row.returnAddressRef ?? null;
  const stockSource = row.stockSource ?? 'self';
  const minOrderQty = row.minOrderQty ?? 1;

  if (typeof enabled !== 'boolean') {
    issues.push(blocker('DROPSHIP_ENABLED', 'dropship.enabled', '布尔', describeValue(enabled), '必须明确声明是否支持代发'));
  }

  if (enabled === false) {
    if (dropshipPriceCents !== null || leadTimeDays !== null || returnAddressRef !== null) {
      issues.push(
        blocker(
          'DROPSHIP_DISABLED_FIELDS',
          'dropship',
          '未启用时代发字段全部为 null',
          `price=${describeValue(dropshipPriceCents)}, lead=${describeValue(leadTimeDays)}, ref=${describeValue(returnAddressRef)}`,
          '未开通代发时仍填写代发字段，会让下游误判可代发（H3 拦截前置）',
        ),
      );
    }
    if (stockSource !== 'self') {
      issues.push(
        blocker(
          'DROPSHIP_STOCK_SOURCE',
          'dropship.stock_source',
          'self',
          describeValue(stockSource),
          '未启用代发时库存口径应为自营仓',
        ),
      );
    }
    const todos: TodoId[] = ['TODO-1688-PERSIST-01'];
    return success(
      { enabled: false, dropshipPriceCents: null, leadTimeDays: null, returnAddressRef: null, stockSource: 'self', minOrderQty: 1, todos },
      issues,
    );
  }

  if (!isPriceCents(dropshipPriceCents)) {
    issues.push(
      blocker('DROPSHIP_PRICE', 'dropship.dropship_price_cents', '正整数分', describeValue(dropshipPriceCents), '启用代发必须给出代发价（整数分）'),
    );
  }
  if (!Number.isSafeInteger(leadTimeDays) || (leadTimeDays as number) < 0 || (leadTimeDays as number) > 60) {
    issues.push(
      blocker('DROPSHIP_LEAD_TIME', 'dropship.lead_time_days', '0–60 的整数天', describeValue(leadTimeDays), '代发时效必须在 0–60 天（对齐 lead_time_days）'),
    );
  }
  if (typeof returnAddressRef !== 'string' || !ADDRESS_REF_RE.test(returnAddressRef)) {
    issues.push(
      blocker(
        'DROPSHIP_RETURN_REF',
        'dropship.return_address_ref',
        'addr:|warehouse:|return: 前缀的引用键',
        describeValue(returnAddressRef),
        '退货地址只存引用键，明文地址属于 PII，禁止进入上架包与日志',
      ),
    );
  }
  if (!(DROPSHIP_STOCK_SOURCES as readonly string[]).includes(String(stockSource))) {
    issues.push(
      blocker('DROPSHIP_STOCK_SOURCE', 'dropship.stock_source', DROPSHIP_STOCK_SOURCES.join('|'), describeValue(stockSource), '库存口径只能取受控值'),
    );
  }
  if (!isQty(minOrderQty)) {
    issues.push(
      blocker('DROPSHIP_MIN_QTY', 'dropship.min_order_qty', '1–99999 的整数', describeValue(minOrderQty), '代发也有起订量，必须是正整数'),
    );
  }

  if (issues.some((issue) => issue.severity === 'blocker')) return failure(issues);

  return success(
    {
      enabled: true,
      dropshipPriceCents: dropshipPriceCents as number,
      leadTimeDays: Number(leadTimeDays),
      returnAddressRef: returnAddressRef as string,
      stockSource: stockSource as DropshipStockSource,
      minOrderQty: minOrderQty as number,
      todos: DROPSHIP_TODO_IDS,
    },
    issues,
  );
}

export function assertDropship(raw: unknown): DropshipTerms {
  const result = validateDropship(raw);
  if (!result.ok || result.value === null) throw new DomainValidationError('代发条款', result.issues);
  return result.value;
}

/**
 * 代发字段映射表 —— 只列「内部字段 → 平台字段（未知）」的意向，平台侧一律 `null`。
 * 用途：① 让验收记录能逐项追踪缺什么；② 平台文档回填后按此表逐行补 `platformField`。
 */
export interface DropshipFieldMapping {
  /** 内部字段（对应本包模型或 docs/06 列）。 */
  internalField: string;
  /** 平台字段名；未核验即为 `null`，**不得**填猜测值。 */
  platformField: string | null;
  readWrite: 'read' | 'write' | 'read+write';
  todoId: TodoId;
  note: string;
}

export const DROPSHIP_FIELD_MAP: DropshipFieldMapping[] = [
  { internalField: 'dropship.enabled', platformField: null, readWrite: 'read', todoId: 'TODO-1688-007', note: '代发标记（H3 拦截依据）' },
  { internalField: 'dropship.dropship_price_cents', platformField: null, readWrite: 'read+write', todoId: 'TODO-1688-007', note: '代发价，通常低于批发起批价' },
  { internalField: 'dropship.stock_source', platformField: null, readWrite: 'read', todoId: 'TODO-1688-007', note: '代发库存是否独立' },
  { internalField: 'dropship.lead_time_days', platformField: null, readWrite: 'read+write', todoId: 'TODO-1688-011', note: '时效承诺（是否需公示 48h）' },
  { internalField: 'dropship.return_address_ref', platformField: null, readWrite: 'write', todoId: 'TODO-1688-011', note: '退货地址只传引用，不传明文' },
  { internalField: 'dropship.min_order_qty', platformField: null, readWrite: 'read+write', todoId: 'TODO-1688-007', note: '代发起订量' },
];
