/**
 * 身份服务：口令 + TOTP 登录、会话、/me、登出（docs/12 §3.1、docs/14 §3–§4）。
 *
 * 失败路径统一返回 `unauthorized`（不区分用户不存在/口令错/TOTP 错）；
 * 账号连续失败 5 次锁 15 分钟（users.failed_attempts / locked_until）；
 * 登录成功/失败/登出都写 audit_log（actor_type=user/system）。
 */
import type { PrismaClient } from '@dssaas/db';
import { highestRole, isRole, permissionsForRole, type Role } from '@dssaas/core';
import type { AppConfig } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { constantTimeEqual, hashEmail, sha256Hex } from '../lib/ids.js';
import { verifyPasswordOrDummy } from '../lib/password.js';
import type { TotpService } from '../lib/totp.js';
import type { AuditService } from './audit.js';
import type { LoginRateLimiter } from './login-rate-limit.js';
import type { MetricsRegistry } from './metrics.js';
import type { SessionRecord, SessionStore, SessionUser } from './sessions.js';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: Role;
  permissions: string[];
  orgId: number;
  sessionId: string;
  csrfToken: string;
}

export interface LoginInput {
  email: string;
  password: string;
  totpCode?: string;
}

export interface RequestMeta {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  session: SessionRecord;
  user: SessionUser;
}

export interface MeResult {
  id: string;
  name: string;
  role: Role;
  org_id: number;
  permissions: string[];
  delegations: Array<{ from: string; to: string; expires_at: string }>;
  quotas: Record<string, unknown>;
}

interface AuthServiceDeps {
  prisma: PrismaClient;
  sessions: SessionStore;
  audit: AuditService;
  totp: TotpService;
  limiter: LoginRateLimiter;
  config: AppConfig;
  metrics?: MetricsRegistry;
  logError?: (error: unknown, context: string) => void;
}

export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async login(input: LoginInput, meta: RequestMeta): Promise<LoginResult> {
    const { prisma, sessions, audit, totp, limiter, config, metrics } = this.deps;
    limiter.consume(meta.ip ?? 'unknown');

    const email = input.email.trim().toLowerCase();
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, archivedAt: null },
    });

    if (!user) {
      await verifyPasswordOrDummy(null, input.password);
      await this.auditFailure(null, email, 'unknown_user', meta, null);
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'unknown_user' });
      throw new ApiError('unauthorized', '邮箱或口令错误');
    }

    if (user.status === 'locked') {
      await this.auditFailure(user.id, email, 'user_locked_status', meta, null);
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'locked' });
      throw new ApiError('locked', '账号已锁定，请联系管理员');
    }

    if (user.status !== 'active') {
      await this.auditFailure(user.id, email, 'user_not_active', meta, null);
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'inactive' });
      throw new ApiError('unauthorized', '邮箱或口令错误');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.auditFailure(user.id, email, 'account_locked', meta, null);
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'locked' });
      throw new ApiError('locked', '账号因连续登录失败已锁定，请稍后再试', {
        detail: { locked_until: user.lockedUntil.toISOString() },
      });
    }

    const passwordOk = await verifyPasswordOrDummy(user.passwordHash, input.password);
    if (!passwordOk) {
      const failure = await this.registerFailure(user.id);
      await this.auditFailure(user.id, email, 'bad_password', meta, failure?.failedAttempts ?? null);
      if (failure?.lockedUntil) {
        await this.safeAudit({
          action: 'auth.account_locked',
          actorType: 'system',
          requestId: meta.requestId,
          resourceType: 'users',
          resourceId: user.id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: {
            reason: 'too_many_failed_attempts',
            failed_attempts: failure.failedAttempts,
            locked_until: failure.lockedUntil.toISOString(),
          },
        });
      }
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'bad_password' });
      throw new ApiError('unauthorized', '邮箱或口令错误');
    }

    if (user.totpEnabled) {
      const totpResult = totp.verify(user.id, user.totpSecretRef, input.totpCode);
      if (totpResult !== 'ok') {
        await this.auditFailure(user.id, email, `totp_${totpResult}`, meta, null);
        metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: `totp_${totpResult}` });
        throw new ApiError('unauthorized', 'TOTP 校验失败', {
          detail: { totp_required: true, reason: totpResult },
        });
      }
    }

    const roleInfo = await this.loadRole(user.id);
    if (!roleInfo) {
      await this.auditFailure(user.id, email, 'no_active_role', meta, null);
      metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'no_role' });
      throw new ApiError('forbidden', '账号没有有效的角色授权');
    }

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.displayName,
      role: roleInfo.role,
      permissions: roleInfo.permissions,
      orgId: Number(user.orgId),
    };
    const session = await sessions.create(sessionUser, {
      ipHash: meta.ip ? sha256Hex(`ip:${meta.ip}`) : null,
      uaHash: sha256Hex(`ua:${meta.userAgent ?? ''}`),
    });

    try {
      await audit.record({
        action: 'auth.login',
        actorType: 'user',
        actorId: user.id,
        requestId: meta.requestId,
        resourceType: 'users',
        resourceId: user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        meta: { actor_role: roleInfo.role, session_id_hash: sha256Hex(session.sid) },
      });
    } catch (error) {
      await sessions.delete(session.sid);
      this.deps.logError?.(error, 'auth.login audit failed');
      throw new ApiError('audit_failed', '登录审计写入失败，请稍后重试');
    }

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), failedAttempts: 0, lockedUntil: null },
      });
    } catch (error) {
      this.deps.logError?.(error, 'update last_login_at failed');
    }

    metrics?.inc('dssaas_auth_login_total', '登录结果计数', { result: 'success' });
    return { session, user: sessionUser };
  }

  async logout(session: SessionRecord, meta: RequestMeta): Promise<void> {
    await this.deps.sessions.delete(session.sid);
    try {
      await this.deps.audit.record({
        action: 'auth.logout',
        actorType: 'user',
        actorId: session.user.id,
        requestId: meta.requestId,
        resourceType: 'users',
        resourceId: session.user.id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        meta: { actor_role: session.user.role, session_id_hash: sha256Hex(session.sid) },
      });
    } catch (error) {
      // 登出以会话删除为准：审计失败只记录，不把用户留在已登录状态。
      this.deps.logError?.(error, 'auth.logout audit failed');
    }
    this.deps.metrics?.inc('dssaas_auth_logout_total', '登出次数');
  }

  async me(session: SessionRecord): Promise<MeResult> {
    const user = session.user;
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      org_id: user.orgId,
      permissions: user.permissions,
      delegations: [],
      quotas: {},
    };
  }

  /** 校验会话令牌；无效返回 null。 */
  verifyCsrf(session: SessionRecord, headerToken: string | undefined, cookieToken: string | undefined): boolean {
    if (!headerToken || !cookieToken) return false;
    if (!constantTimeEqual(headerToken, cookieToken)) return false;
    return constantTimeEqual(headerToken, session.csrfToken);
  }

  private async loadRole(userId: string): Promise<{ role: Role; permissions: string[] } | null> {
    const memberships = await this.deps.prisma.membership.findMany({
      where: {
        userId,
        status: 'active',
        archivedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { roleId: true },
    });
    if (memberships.length === 0) return null;
    const roles = await this.deps.prisma.role.findMany({
      where: { id: { in: memberships.map((membership) => membership.roleId) }, archivedAt: null },
    });
    const codes = roles.map((role) => role.code).filter(isRole);
    const role = highestRole(codes);
    if (!role) return null;
    const dbRole = roles.find((candidate) => candidate.code === role);
    const permissions =
      dbRole && dbRole.permissions.length > 0 ? [...dbRole.permissions] : permissionsForRole(role);
    return { role, permissions };
  }

  private async registerFailure(
    userId: string,
  ): Promise<{ failedAttempts: number; lockedUntil: Date | null } | null> {
    try {
      const rows = await this.deps.prisma.$queryRaw<
        Array<{ failed_attempts: number; locked_until: Date | null }>
      >`
        UPDATE users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= ${this.deps.config.maxFailedAttempts}::int
                THEN now() + make_interval(mins => ${this.deps.config.lockMinutes}::int)
              ELSE locked_until
            END,
            updated_at = now()
        WHERE id = ${userId}::uuid
        RETURNING failed_attempts, locked_until
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        failedAttempts: Number(row.failed_attempts),
        lockedUntil: row.locked_until ?? null,
      };
    } catch (error) {
      this.deps.logError?.(error, 'register login failure');
      return null;
    }
  }

  private async auditFailure(
    userId: string | null,
    email: string,
    reason: string,
    meta: RequestMeta,
    failedAttempts: number | null,
  ): Promise<void> {
    await this.safeAudit({
      action: 'auth.login_failed',
      actorType: 'system',
      requestId: meta.requestId,
      resourceType: 'users',
      resourceId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: {
        reason,
        email_hash: hashEmail(email),
        ...(failedAttempts === null ? {} : { failed_attempts: failedAttempts }),
      },
    });
  }

  private async safeAudit(input: Parameters<AuditService['record']>[0]): Promise<void> {
    try {
      await this.deps.audit.record(input);
    } catch (error) {
      this.deps.logError?.(error, `audit ${input.action} failed`);
    }
  }
}
