/**
 * 平台连接页类型（docs/13c §3.2，对齐 docs/12 §3.9a 实际响应）。
 *
 * 只描述**后端真的会返回的字段**：`platform_account` 表没有明文凭据列，
 * 所以这里也没有任何 `app_secret / access_token / refresh_token` 的"值"字段，
 * 只有 `*_ref`（变量名）与 `app_key_masked`（后端脱敏后的应用标识）。
 */

export type Platform = 'pdd' | '1688';
export type PlatformAccountStatus = 'active' | 'disabled' | 'expired';

/** 与后端 service 的 Connectivity 枚举同口径（docs/12 §3.9a）。 */
export type Connectivity = 'unknown' | 'ok' | 'auth_invalid' | 'upstream_5xx' | 'unreachable';

export interface PlatformAccountItem {
  id: string;
  platform: Platform | string;
  shop_id: string | null;
  shop_name: string | null;
  /** 后端已脱敏（`sk_****9f2`），前端**不再做二次处理**。 */
  app_key_masked: string;
  app_secret_ref: string;
  access_token_ref: string | null;
  refresh_token_ref: string | null;
  token_expires_at: string | null;
  status: PlatformAccountStatus | string;
  connectivity: Connectivity | string;
  last_tested_at: string | null;
  last_test_error: string | null;
  contract_version: number;
  /** 部署约束等自由字段（docs/13c §3.2 约定 network_mode / ip_whitelist / datacenter）。 */
  extra: Record<string, unknown> | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlatformAccountList {
  items: PlatformAccountItem[];
}

/** 新建/修改后的回执（后端只回这四五个字段，不含脱敏视图）。 */
export interface PlatformAccountMutation {
  id: string;
  version: number;
  status: string;
  connectivity: string;
}

/**
 * 测试连通结果（docs/12 §3.9a）。
 *
 * `ok` 当前**恒为 false**：平台 55 个接口 method 未核验，服务端固定返回
 * `interfaces_unverified`。前端不得把其他形状当成功，也不得把 `ok:false` 当 HTTP 失败。
 */
export interface TestConnectivityResult {
  ok: boolean;
  connectivity: Connectivity | string;
  reason: string;
  message: string;
  tested_at: string;
}

export interface PlatformAccountCreateInput {
  platform: Platform;
  shop_id?: string | null;
  shop_name?: string | null;
  app_key: string;
  app_secret_ref: string;
  access_token_ref?: string | null;
  refresh_token_ref?: string | null;
  token_expires_at?: string | null;
  contract_version?: number;
  extra?: Record<string, unknown>;
}

export interface PlatformAccountPatchInput {
  shop_name?: string | null;
  app_key?: string;
  app_secret_ref?: string;
  access_token_ref?: string | null;
  refresh_token_ref?: string | null;
  token_expires_at?: string | null;
  status?: PlatformAccountStatus;
  contract_version?: number;
  extra?: Record<string, unknown>;
}

/** 部署约束（extra 的约定键），用于平台卡展示。 */
export interface DeploymentConstraint {
  network_mode: string;
  ip_whitelist: string;
  datacenter: string;
  /** 是否全部来自默认假设（extra 缺键），决定是否显示"(默认假设)"。 */
  assumed: boolean;
  /** extra 里无法识别的键数量（只显示数量，不展开猜测语义）。 */
  otherKeys: number;
}
