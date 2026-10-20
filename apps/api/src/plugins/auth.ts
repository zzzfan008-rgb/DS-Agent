/**
 * 认证/授权前置钩子（docs/12 §1、§3.1；docs/14 §4.2）。
 *
 * 路由通过 config 声明：
 * - `public: true` 跳过登录校验（/api/health、/api/auth/login）；
 * - `minRole` 控制最低角色（缺省 viewer）；
 * - 所有非 GET/POST 之外的状态变更请求校验 CSRF 双提交与 Origin。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasRole } from '@dssaas/core';
import { ApiError } from '../lib/errors.js';
import { constantTimeEqual } from '../lib/ids.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function registerAuthGate(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const routeConfig = request.routeOptions.config ?? {};
    const rawSid = request.cookies[app.config.sessionCookieName];
    const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid;
    if (sid) {
      const session = await app.sessions.get(sid);
      if (session) {
        request.session = session;
        request.auth = {
          userId: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: session.user.role,
          permissions: session.user.permissions,
          orgId: session.user.orgId,
          sessionId: session.sid,
          csrfToken: session.csrfToken,
        };
      }
    }

    if (routeConfig.public === true) return;

    if (!request.auth || !request.session) {
      throw new ApiError('unauthorized', '请先登录');
    }

    const minimum = routeConfig.minRole ?? 'viewer';
    if (!hasRole(request.auth.role, minimum)) {
      await auditDenied(app, request, 'role');
      throw new ApiError('forbidden', `需要 ${minimum} 及以上角色`, {
        detail: { required_role: minimum, actual_role: request.auth.role },
      });
    }

    if (!isMutating(request.method)) return;

    const headerTokenRaw = request.headers['x-csrf-token'];
    const headerToken = Array.isArray(headerTokenRaw) ? headerTokenRaw[0] : headerTokenRaw;
    const cookieTokenRaw = request.cookies[app.config.csrfCookieName];
    const cookieToken = Array.isArray(cookieTokenRaw) ? cookieTokenRaw[0] : cookieTokenRaw;
    if (!app.authService.verifyCsrf(request.session, headerToken, cookieToken)) {
      await auditDenied(app, request, 'csrf');
      throw new ApiError('forbidden', 'CSRF 校验失败', { detail: { reason: 'csrf' } });
    }

    if (app.config.csrfRequireOrigin) {
      const origin = request.headers.origin;
      const expectedHost = request.headers.host;
      if (!origin || !expectedHost) {
        await auditDenied(app, request, 'origin_missing');
        throw new ApiError('forbidden', '缺少 Origin，拒绝状态变更请求', {
          detail: { reason: 'origin' },
        });
      }
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = '';
      }
      if (!constantTimeEqual(originHost, expectedHost)) {
        await auditDenied(app, request, 'origin_mismatch');
        throw new ApiError('forbidden', 'Origin 与 Host 不一致', { detail: { reason: 'origin' } });
      }
    }
  });
}

async function auditDenied(
  app: FastifyInstance,
  request: FastifyRequest,
  reason: 'role' | 'csrf' | 'origin_missing' | 'origin_mismatch',
): Promise<void> {
  try {
    await app.audit.record({
      action: 'authz.denied',
      actorType: request.auth ? 'user' : 'system',
      actorId: request.auth?.userId ?? null,
      requestId: request.requestId,
      resourceType: 'route',
      resourceId: null,
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      meta: {
        actor_role: request.auth?.role ?? null,
        method: request.method,
        path: request.url.split('?')[0],
        reason,
      },
    });
  } catch (error) {
    request.log.error({ err: error }, 'audit authz.denied failed');
  }
  request.auditLogged = true;
}
