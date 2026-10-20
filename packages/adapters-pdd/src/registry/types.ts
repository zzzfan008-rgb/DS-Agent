/**
 * 接口注册表的数据结构。
 *
 * 关键约束（docs/01 写法约定）：
 * - 未核验的 method / 版本 / 限流 / 沙箱 / 字段一律为 `null` + TODO 文案，
 *   **不允许**用第三方博客或记忆补全；
 * - `key` 是本系统内部稳定标识（对应 docs/12 的 action 语义），不是平台 method；
 * - `verification='verified'` 才允许 `PddClient` 发起真实调用。
 */

export type PddInterfaceSection = '2.1' | '2.2' | '2.3' | '2.4' | '2.5' | '2.6';

export type PddInterfaceConclusion =
  | 'automation'
  | 'conditional_automation'
  | 'degraded'
  | 'manual'
  | 'pending_review';

export type PddFallbackChannel = 'none' | 'listing_package' | 'read_only_sync' | 'manual_workbench';

export type PddWriteLevel = 'A' | 'B' | 'C' | null;

export interface PddInterfaceTodos {
  method: string;
  permission: string;
  rate_limit: string;
  sandbox: string;
  fields: string;
}

export interface PddInterfaceSpec {
  /** 内部稳定键，例如 `product.publish`；不是平台 method。 */
  key: string;
  section: PddInterfaceSection;
  /** docs/01 表格中的行号（1 开始）。 */
  row: number;
  title: string;
  purpose: string;
  doc_ref: string;
  write: boolean;
  operation_level: PddWriteLevel;
  /** docs/11 §6.2 动作码；未注册为 null（不得臆造）。 */
  action_code: string | null;
  fallback: PddFallbackChannel;
  conclusion: PddInterfaceConclusion;
  /** docs/01「结论」列原文，保留以便回填后对账。 */
  conclusion_raw: string;
  verification: 'unverified' | 'verified';
  platform_method: string | null;
  platform_version: string | null;
  path_template: string | null;
  todos: PddInterfaceTodos;
  last_verified_at: string | null;
  verified_by: string | null;
  notes?: string;
}

export interface VerifiedPddInterfaceSpec extends PddInterfaceSpec {
  verification: 'verified';
  platform_method: string;
  platform_version: string;
  path_template: string;
}

export interface PddRegistryStats {
  total: number;
  verified: number;
  unverified: number;
  write: number;
  read: number;
  by_section: Record<PddInterfaceSection, number>;
  by_conclusion: Record<PddInterfaceConclusion, number>;
}

export interface UnverifiedInterfaceRow {
  key: string;
  section: PddInterfaceSection;
  title: string;
  reason: 'method_unverified';
  fallback: PddFallbackChannel;
  fallback_note: string;
  doc_ref: string;
  todo: string;
  owner: string;
  review_date: string | null;
}

export const PDD_SOURCE_DOC = {
  path: 'docs/01-平台接入侦察-拼多多.md',
  version: 'v0.1（2026-10-20）',
  verified_at: null,
  note: '接口文档需登录开发者账号；本注册表只登记字段形状，不登记未经核对的 method/限流/字段名。',
} as const;
