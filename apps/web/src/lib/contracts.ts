/**
 * 前端契约类型（docs/12 v2）。
 *
 * 约定：JSON 字段 snake_case；金额整数分；时间 ISO8601 UTC。
 * 本文件只放「接口真实字段」；页面展示用的 view model 放在 lib/approval-view.ts。
 */

export type Role = 'viewer' | 'operator' | 'admin';
export type RiskLevel = 'A' | 'B' | 'C';
export type PlatformCode = 'pdd' | '1688';

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  next_action?: string | null;
  detail?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  request_id?: string;
  error: ApiErrorPayload;
}

export interface ApiSuccess<T> {
  request_id?: string;
  data: T;
  meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* 认证（docs/12 §3.1）                                                */
/* ------------------------------------------------------------------ */

export interface Me {
  id: string;
  name: string;
  role: Role;
  org_id: number;
  permissions: string[];
  delegations: Array<{ from: string; to: string; expires_at: string }>;
  quotas: Record<string, unknown>;
}

export interface LoginData {
  user: { id: string; name: string; role: Role };
  csrf_token: string;
  expires_at: string;
  must_change_password: boolean;
}

export interface HealthCheck {
  /**
   * API 实际返回 `healthy | degraded | down`（apps/api/src/routes/health.ts）；
   * 前端早先按 `ok | degraded | down` 写，导致登录页永远显示「系统维护中」并禁用按钮。
   * 这里以 API 为准，同时兼容旧值 `ok`，避免两处枚举再次漂移。
   */
  status: 'healthy' | 'ok' | 'degraded' | 'down';
  checks?: Record<string, unknown>;
  version?: string;
  build?: string;
  uptime_s?: number;
}

/* ------------------------------------------------------------------ */
/* 审批（docs/12 §3.5；M1 只读）                                        */
/* ------------------------------------------------------------------ */

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'escalated'
  | string;

export interface ApprovalListItem {
  id: string;
  object_type: string;
  object_id: string;
  action: string;
  level: RiskLevel;
  platform: PlatformCode | string;
  status: ApprovalStatus;
  sla_due_at: string | null;
  overdue?: boolean;
  risk_notes?: string[];
  risk_meta?: RiskMeta;
  requested_by?: string | null;
  requested_at?: string | null;
  batch_id?: string | null;
  assignee?: string | null;
}

export interface RiskMeta {
  level?: RiskLevel;
  items?: string[];
  impact_scope?: Record<string, unknown> | null;
  window_hint?: string | null;
  [key: string]: unknown;
}

export interface ApprovalDiffItem {
  field: string;
  label?: string;
  before?: unknown;
  after?: unknown;
  risk?: string;
}

export interface ApprovalHistoryItem {
  at: string;
  actor?: string;
  action: string;
  comment?: string | null;
}

export interface ApprovalObjectSnapshot {
  current_platform_values?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ApprovalDetailRaw {
  id: string;
  object_type: string;
  object_id: string;
  action: string;
  level: RiskLevel;
  platform: PlatformCode | string;
  status: ApprovalStatus;
  sla_due_at?: string | null;
  expires_at?: string | null;
  requested_by?: string | null;
  requested_at?: string | null;
  decided_at?: string | null;
  decided_by?: string | null;
  batch_id?: string | null;
  target_hash?: string | null;
  risk_notes?: string[] | null;
  risk_meta?: RiskMeta | null;
  object?: ApprovalObjectSnapshot | null;
  diff?: ApprovalDiffItem[] | null;
  fact_snapshot?: Record<string, unknown> | null;
  history?: ApprovalHistoryItem[] | null;
  allowed_decisions?: string[] | null;
  request_id?: string | null;
  /** 双人信息（C 级）：M1 演示数据提供，M4 由服务端返回后归一到同名 view model。 */
  approver?: string | null;
  executor?: string | null;
  [key: string]: unknown;
}

export interface ApprovalListData {
  items: ApprovalListItem[];
  meta?: {
    next_cursor?: string | null;
    pending_count?: number;
    oldest_wait_minutes?: number;
    overdue_count?: number;
  };
}

/* ------------------------------------------------------------------ */
/* 展示用 view model（由 lib/approval-view.ts 归一化）                   */
/* ------------------------------------------------------------------ */

export interface FactChipView {
  key: string;
  label: string;
  detail: string;
}

export interface ApprovalDetailView {
  id: string;
  object_type: string;
  object_id: string;
  action: string;
  action_label: string;
  level: RiskLevel;
  platform: string;
  status: ApprovalStatus;
  sla_due_at: string | null;
  expires_at: string | null;
  requested_by: string | null;
  requested_at: string | null;
  batch_id: string | null;
  target_hash: string | null;
  risk_notes: string[];
  window_hint: string | null;
  impact_scope: Array<{ key: string; label: string; value: string }>;
  diff: Array<{ field: string; label: string; before: string; after: string; risk: string | null }>;
  facts: FactChipView[];
  history: Array<{ at: string; actor: string; action: string; comment: string | null }>;
  allowed_decisions: string[];
  approver: string | null;
  executor: string | null;
  request_id: string | null;
}
