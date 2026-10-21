/**
 * 平台账号服务（t54）—— 「平台连接」页的增改查 / 测试连通 / 归档。
 *
 * 三条硬约束（来自 t53 表设计与 docs/20 存储边界）：
 *
 * 1. **只存引用名，不存明文**：DB 没有 `app_secret/access_token/refresh_token` 列，
 *    只有 `*_ref`。服务层再做一层形状校验，把"用户误把密钥粘进 ref 字段"拦在 400，
 *    而不是让 DB 的 23514 冒成 500。
 * 2. **绝不返回实值**：`*_ref` 本身是变量名（可以返回），但**解析后的值**永不出现 ——
 *    本服务根本没有解析能力，也就不可能泄漏。列表/详情只给 `*_ref` 与 `app_key_masked`。
 * 3. **诚实失败**：平台接口 method 全部未核验（docs/02 §4、docs/01 §3），
 *    测试连通只能返回 `interfaces_unverified`，不得伪造 `ok:true`。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { probePddConnection } from '@dssaas/adapters-pdd';
import { credentialMask } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';

export type Platform = 'pdd' | '1688';
export type PlatformAccountStatus = 'active' | 'disabled' | 'expired';
export type Connectivity = 'unknown' | 'ok' | 'auth_invalid' | 'upstream_5xx' | 'unreachable';

/** 探针结果 → DB 的 connectivity 枚举（DB CHECK 只允许这 5 个值）。 */
function mapOutcomeToConnectivity(outcome: string): Connectivity {
  switch (outcome) {
    case 'ok':
      return 'ok';
    case 'credential_invalid':
    case 'signature_invalid':
    case 'token_invalid':
    case 'permission_denied':
      return 'auth_invalid';
    case 'unreachable':
      return 'unreachable';
    default:
      // unknown_error / interfaces_unverified 都归 unknown：没测出结论就不下结论。
      return 'unknown';
  }
}

export interface PlatformAccountContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export interface PlatformAccountDeps {
  prisma: PrismaClient;
  audit: AuditService;
  /** 平台接口核验状态（默认未核验）；1688 探针未实现时用于诚实返回。 */
  interfacesVerified?: boolean;
  /** 探针超时（毫秒），默认 10s。测试可调小。 */
  probeTimeoutMs?: number;
  /** 测试注入点：替换 fetch 以离线验证六态分类，不触网。 */
  probeFetchImpl?: typeof fetch;
}

/**
 * 引用名形状：与 DB `ck_platform_account_app_secret_ref` 同一条正则。
 *
 * 为什么服务层要重复一次：让"误传明文"返回 **400 + 可读提示**，
 * 而不是撞 DB CHECK 变成 23514 → 500（用户看不懂，也不该看到 SQL 错误）。
 */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$/;

/** 典型密钥形态：≥24 位连续无分隔符长串（与 DB `ck_platform_account_no_inline_secret` 同口径）。 */
const INLINE_SECRET_RE = /[A-Za-z0-9+/=_-]{24,}/;

/** 引用名字段 → 中文标签（用于错误提示与审计）。 */
const REF_FIELDS: Array<{ key: 'app_secret_ref' | 'access_token_ref' | 'refresh_token_ref'; label: string }> = [
  { key: 'app_secret_ref', label: 'app_secret_ref' },
  { key: 'access_token_ref', label: 'access_token_ref' },
  { key: 'refresh_token_ref', label: 'refresh_token_ref' },
];

/**
 * 校验引用名：形状 + 防明文兜底。
 *
 * 拒绝时给**可执行的下一步**（"请传引用名，实值配在环境变量或 Vault"），
 * 而不是只说"格式不对" —— 用户此时手里正拿着密钥，必须告诉他该放哪。
 */
export function assertCredentialRef(field: string, value: string): void {
  if (!REF_RE.test(value)) {
    throw new ApiError(
      'validation_failed',
      `${field} 必须是引用名（变量名/Vault 路径），不能是密钥明文。请传引用名，实值配在环境变量或 Vault。`,
      {
        httpStatus: 400,
        detail: {
          field,
          expected: '引用名，形如 PDD_APP_SECRET 或 vault://dssaas/pdd#app_secret',
          hint: '实值不要入库：配到环境变量或 Vault，这里只填它的名字',
        },
      },
    );
  }
  if (INLINE_SECRET_RE.test(value)) {
    throw new ApiError(
      'validation_failed',
      `${field} 看起来像密钥明文（含 ≥24 位连续长串）。请传引用名，实值配在环境变量或 Vault。`,
      {
        httpStatus: 400,
        detail: {
          field,
          expected: '引用名（不含长串密钥）',
          hint: '若这是 Vault 路径，请用分隔符分段，例如 vault://dssaas/pdd/app-secret',
        },
      },
    );
  }
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

/** 列表/详情共用的输出形状（**只含引用名，不含任何实值**）。 */
function toView(row: {
  id: string;
  platform: string;
  shopId: string | null;
  shopName: string | null;
  appKey: string;
  appSecretRef: string;
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  tokenExpiresAt: Date | null;
  status: string;
  connectivity: string;
  lastTestedAt: Date | null;
  lastTestError: string | null;
  contractVersion: number;
  extra: unknown;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    platform: row.platform,
    shop_id: row.shopId,
    shop_name: row.shopName,
    // app_key 是"应用标识"，非密钥，但仍按凭据处理脱敏（前端只需要能区分是哪把 key）。
    app_key_masked: credentialMask(row.appKey),
    // 引用名可以返回：它只是变量名，不是值。
    app_secret_ref: row.appSecretRef,
    access_token_ref: row.accessTokenRef,
    refresh_token_ref: row.refreshTokenRef,
    token_expires_at: row.tokenExpiresAt?.toISOString() ?? null,
    status: row.status,
    connectivity: row.connectivity,
    last_tested_at: row.lastTestedAt?.toISOString() ?? null,
    last_test_error: row.lastTestError,
    contract_version: row.contractVersion,
    extra: row.extra,
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** 审计用：把引用名也脱敏（审计表会被更多人看到，没必要留完整变量名）。 */
function auditView(row: {
  platform: string;
  shopId: string | null;
  shopName: string | null;
  appKey: string;
  appSecretRef: string;
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  status: string;
  connectivity: string;
  contractVersion: number;
  extra: unknown;
}) {
  return {
    platform: row.platform,
    shop_id: row.shopId,
    shop_name: row.shopName,
    app_key_masked: credentialMask(row.appKey),
    app_secret_ref_masked: credentialMask(row.appSecretRef),
    access_token_ref_masked: row.accessTokenRef === null ? null : credentialMask(row.accessTokenRef),
    refresh_token_ref_masked: row.refreshTokenRef === null ? null : credentialMask(row.refreshTokenRef),
    status: row.status,
    connectivity: row.connectivity,
    contract_version: row.contractVersion,
    extra: row.extra,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

export class PlatformAccountService {
  private readonly prisma: PrismaClient;
  private readonly audit: AuditService;
  private readonly interfacesVerified: boolean;
  private readonly probeTimeoutMs: number;
  private readonly probeFetchImpl: typeof fetch | undefined;

  constructor(deps: PlatformAccountDeps) {
    this.prisma = deps.prisma;
    this.audit = deps.audit;
    this.interfacesVerified = deps.interfacesVerified ?? false;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 10_000;
    this.probeFetchImpl = deps.probeFetchImpl;
  }

  async list(platform?: Platform) {
    const rows = await this.prisma.platformAccount.findMany({
      where: {
        orgId: 1n,
        archivedAt: null,
        ...(platform ? { platform } : {}),
      },
      orderBy: [{ platform: 'asc' }, { shopId: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toView) };
  }

  async get(id: string) {
    const row = await this.prisma.platformAccount.findFirst({ where: { id, orgId: 1n, archivedAt: null } });
    if (!row) throw new ApiError('not_found', '平台账号不存在');
    return toView(row);
  }

  async create(input: PlatformAccountCreateInput, context: PlatformAccountContext) {
    // 先校验所有引用名形状（服务层拦明文，避免 DB 23514 变 500）。
    assertCredentialRef('app_secret_ref', input.app_secret_ref);
    if (input.access_token_ref) assertCredentialRef('access_token_ref', input.access_token_ref);
    if (input.refresh_token_ref) assertCredentialRef('refresh_token_ref', input.refresh_token_ref);

    const shopId = input.shop_id?.trim() ? input.shop_id.trim() : null;
    const tokenExpiresAt = input.token_expires_at ? new Date(input.token_expires_at) : null;
    if (tokenExpiresAt && Number.isNaN(tokenExpiresAt.getTime())) {
      throw new ApiError('validation_failed', 'token_expires_at 不是合法时间', {
        detail: { field: 'token_expires_at' },
      });
    }

    let created;
    try {
      created = await this.prisma.platformAccount.create({
        data: {
          orgId: 1n,
          platform: input.platform,
          shopId,
          shopName: input.shop_name ?? null,
          appKey: input.app_key,
          appSecretRef: input.app_secret_ref,
          accessTokenRef: input.access_token_ref ?? null,
          refreshTokenRef: input.refresh_token_ref ?? null,
          tokenExpiresAt,
          status: 'active',
          // 新建即 unknown；只有真正测试过才允许变成别的值（DB 约束要求非 unknown 必须有 last_tested_at）。
          connectivity: 'unknown',
          contractVersion: input.contract_version ?? 2,
          extra: (input.extra ?? {}) as Prisma.InputJsonValue,
          createdBy: context.userId,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('conflict', '该平台该店铺已有未归档的账号', {
          detail: { platform: input.platform, shop_id: shopId },
        });
      }
      throw error;
    }

    await this.audit.record({
      action: 'platform_account.create',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'platform_account',
      resourceId: created.id,
      after: auditView(created),
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, platform: created.platform },
    });

    return { id: created.id, version: created.version, status: created.status, connectivity: created.connectivity };
  }

  async patch(id: string, expectedVersion: number, input: PlatformAccountPatchInput, context: PlatformAccountContext) {
    const before = await this.prisma.platformAccount.findFirst({ where: { id, orgId: 1n, archivedAt: null } });
    if (!before) throw new ApiError('not_found', '平台账号不存在');
    if (before.version !== expectedVersion) {
      throw new ApiError('conflict', '版本冲突，请刷新后重试', {
        detail: { expected: expectedVersion, actual: before.version },
      });
    }

    if (input.app_secret_ref !== undefined) assertCredentialRef('app_secret_ref', input.app_secret_ref);
    if (input.access_token_ref) assertCredentialRef('access_token_ref', input.access_token_ref);
    if (input.refresh_token_ref) assertCredentialRef('refresh_token_ref', input.refresh_token_ref);

    const tokenExpiresAt =
      input.token_expires_at === undefined
        ? undefined
        : input.token_expires_at === null
          ? null
          : new Date(input.token_expires_at);
    if (tokenExpiresAt instanceof Date && Number.isNaN(tokenExpiresAt.getTime())) {
      throw new ApiError('validation_failed', 'token_expires_at 不是合法时间', {
        detail: { field: 'token_expires_at' },
      });
    }

    // 乐观锁：where 带 version，count=0 即被并发改过。
    const result = await this.prisma.platformAccount.updateMany({
      where: { id, version: expectedVersion, archivedAt: null },
      data: {
        ...(input.shop_name === undefined ? {} : { shopName: input.shop_name }),
        ...(input.app_key === undefined ? {} : { appKey: input.app_key }),
        ...(input.app_secret_ref === undefined ? {} : { appSecretRef: input.app_secret_ref }),
        ...(input.access_token_ref === undefined ? {} : { accessTokenRef: input.access_token_ref }),
        ...(input.refresh_token_ref === undefined ? {} : { refreshTokenRef: input.refresh_token_ref }),
        ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.contract_version === undefined ? {} : { contractVersion: input.contract_version }),
        ...(input.extra === undefined ? {} : { extra: input.extra as Prisma.InputJsonValue }),
      },
    });
    if (result.count === 0) throw new ApiError('conflict', '版本冲突，请刷新后重试');

    const after = await this.prisma.platformAccount.findUniqueOrThrow({ where: { id } });
    await this.audit.record({
      action: 'platform_account.update',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'platform_account',
      resourceId: id,
      before: auditView(before),
      after: auditView(after),
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, platform: after.platform },
    });

    return { id: after.id, version: after.version, status: after.status, connectivity: after.connectivity };
  }

  /**
   * 测试连通 —— 真实探针（PDD），按官方文档签名后打到真实网关。
   *
   * 设计要点（与旧版「固定 interfaces_unverified」的区别）：
   * 1. 先解析三个 `*_ref` 到实值；**任何一个缺失都明确报出变量名**，不发请求。
   * 2. PDD 走 `probePddConnection`（官方 MD5 签名 + `pdd.time.get`），
   *    六种结果各自映射为可诊断的 connectivity 与用户处置建议。
   * 3. 1688 尚未实现探针（docs/02 TODO-1688-001…012 仍开），
   *    仍返回 `interfaces_unverified` —— 不伪造成功。
   * 4. 无论成功失败，都把这次尝试写回库（last_tested_at / last_test_error / connectivity），
   *    让「试过了、还是不通」在列表里长期可见。
   */
  async testConnectivity(id: string, context: PlatformAccountContext) {
    const row = await this.prisma.platformAccount.findFirst({ where: { id, orgId: 1n, archivedAt: null } });
    if (!row) throw new ApiError('not_found', '平台账号不存在');

    const testedAt = new Date();

    // ---- 1) 解析引用名到实值（缺失即失败，不发请求） ----
    const resolved = this.resolveCredentials(row);
    if (!resolved.ok) {
      const message = resolved.message;
      await this.prisma.platformAccount.update({
        where: { id },
        data: {
          connectivity: 'auth_invalid',
          lastTestedAt: testedAt,
          lastTestError: `missing_credential: ${message}`.slice(0, 2000),
        },
      });
      await this.audit.record({
        action: 'platform_account.test',
        actorType: 'user',
        actorId: context.userId,
        requestId: context.requestId,
        resourceType: 'platform_account',
        resourceId: id,
        before: { connectivity: row.connectivity, last_tested_at: row.lastTestedAt?.toISOString() ?? null },
        after: { ok: false, connectivity: 'auth_invalid', reason: 'missing_credential' },
        ip: context.ip,
        userAgent: context.userAgent,
        meta: { actor_role: context.role, platform: row.platform, reason: 'missing_credential' },
      });
      return {
        ok: false,
        connectivity: 'auth_invalid' as Connectivity,
        reason: 'missing_credential',
        message,
        tested_at: testedAt.toISOString(),
      };
    }

    // ---- 2) 真实探针 ----
    let probe: { ok: boolean; outcome: string; message: string; nextAction: string; connectivity: Connectivity; detail: Record<string, unknown> };

    if (row.platform === 'pdd') {
      const result = await probePddConnection({
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        accessToken: resolved.accessToken,
        timeoutMs: this.probeTimeoutMs,
        ...(this.probeFetchImpl ? { fetchImpl: this.probeFetchImpl } : {}),
      });
      probe = {
        ok: result.ok,
        outcome: result.outcome,
        message: result.message,
        nextAction: result.nextAction,
        connectivity: mapOutcomeToConnectivity(result.outcome),
        detail: {
          api_type: result.apiType,
          gateway: result.gateway,
          http_status: result.httpStatus,
          elapsed_ms: result.elapsedMs,
          error_code: result.errorCode,
          error_sub_code: result.errorSubCode,
          error_message: result.errorMessage,
          raw_response: result.rawResponse,
        },
      };
    } else {
      // 1688 探针未实现：诚实失败，不伪造成功。
      probe = {
        ok: false,
        outcome: 'interfaces_unverified',
        message: '1688 接口尚未核验（TODO-1688-001…012），无法发起真实请求',
        nextAction: 'verify_interfaces',
        connectivity: 'unknown',
        detail: { platform: '1688' },
      };
    }

    // ---- 3) 写回库（成功失败都写，让"试过了"可见） ----
    const errorText = probe.ok
      ? null
      : `${probe.outcome}: ${probe.message}`.slice(0, 2000);
    await this.prisma.platformAccount.update({
      where: { id },
      data: {
        connectivity: probe.connectivity,
        lastTestedAt: testedAt,
        lastTestError: errorText,
      },
    });

    await this.audit.record({
      action: 'platform_account.test',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'platform_account',
      resourceId: id,
      before: { connectivity: row.connectivity, last_tested_at: row.lastTestedAt?.toISOString() ?? null },
      after: {
        ok: probe.ok,
        connectivity: probe.connectivity,
        reason: probe.outcome,
        tested_at: testedAt.toISOString(),
        elapsed_ms: probe.detail.elapsed_ms ?? null,
      },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, platform: row.platform, reason: probe.outcome },
    });

    return {
      ok: probe.ok,
      connectivity: probe.connectivity,
      reason: probe.outcome,
      message: probe.message,
      next_action: probe.nextAction,
      tested_at: testedAt.toISOString(),
      detail: probe.detail,
    };
  }

  /**
   * 把 `*_ref` 解析为实值。
   *
   * 支持两种引用形式：
   * - 环境变量名（如 `PDD_APP_SECRET`）：从 `process.env` 读
   * - `vault://path/to/secret`：当前未接入 Vault，明确报"未接入"而不是静默失败
   *
   * **实值只存在于返回值里，不写日志、不进审计、不进响应。**
   */
  private resolveCredentials(row: {
    appKey: string;
    appSecretRef: string;
    accessTokenRef: string | null;
  }):
    | { ok: true; clientId: string; clientSecret: string; accessToken: string | null }
    | { ok: false; message: string } {
    const resolveOne = (ref: string, label: string): { ok: true; value: string } | { ok: false; message: string } => {
      if (ref.startsWith('vault://')) {
        return {
          ok: false,
          message: `${label} 使用 Vault 引用（${ref}），但本环境未接入 Vault；请改用环境变量名`,
        };
      }
      const value = process.env[ref];
      if (!value || value.trim() === '') {
        return {
          ok: false,
          message: `${label} 引用的环境变量 ${ref} 未设置或为空；请在 .env 中配置 ${ref}=<真实值> 后重启服务`,
        };
      }
      return { ok: true, value: value.trim() };
    };

    // app_key 直接存在表里（它不是密钥），作为 client_id 使用。
    const clientId = row.appKey?.trim();
    if (!clientId) {
      return { ok: false, message: 'app_key（client_id）为空，请先在编辑中填写' };
    }

    const secret = resolveOne(row.appSecretRef, 'app_secret');
    if (!secret.ok) return { ok: false, message: secret.message };

    let accessToken: string | null = null;
    if (row.accessTokenRef) {
      const token = resolveOne(row.accessTokenRef, 'access_token');
      if (!token.ok) return { ok: false, message: token.message };
      accessToken = token.value;
    }

    return { ok: true, clientId, clientSecret: secret.value, accessToken };
  }

  /** 归档（不物理删除：凭据配置要留痕，且 uq 索引是 archived_at IS NULL 部分索引）。 */
  async archive(id: string, context: PlatformAccountContext) {
    const before = await this.prisma.platformAccount.findFirst({ where: { id, orgId: 1n, archivedAt: null } });
    if (!before) throw new ApiError('not_found', '平台账号不存在');

    await this.prisma.platformAccount.update({
      where: { id },
      data: { archivedAt: new Date(), status: 'disabled' },
    });

    await this.audit.record({
      action: 'platform_account.archive',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'platform_account',
      resourceId: id,
      before: auditView(before),
      after: { archived: true, status: 'disabled' },
      ip: context.ip,
      userAgent: context.userAgent,
      meta: { actor_role: context.role, platform: before.platform },
    });

    return { id, archived: true };
  }
}
