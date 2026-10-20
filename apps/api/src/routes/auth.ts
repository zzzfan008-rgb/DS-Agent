/** 认证路由：POST /auth/login、POST /auth/logout、GET /me（docs/12 §3.1）。 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';

const LoginBody = z.object({
  email: z.string().email('email 格式非法'),
  password: z.string().min(1, 'password 必填').max(256),
  totp_code: z
    .string()
    .regex(/^\d{6}$/, 'totp_code 必须是 6 位数字')
    .optional(),
});

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post(
    '/api/auth/login',
    { config: { public: true, idempotency: false, audit: false } },
    async (request, reply) => {
      const body = LoginBody.parse(request.body ?? {});
      const result = await app.authService.login(
        {
          email: body.email,
          password: body.password,
          ...(body.totp_code === undefined ? {} : { totpCode: body.totp_code }),
        },
        {
          requestId: request.requestId,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        },
      );

      const maxAgeSeconds = Math.max(
        1,
        Math.floor((result.session.absoluteExpiresAt - Date.now()) / 1000),
      );
      reply.setCookie(app.config.sessionCookieName, result.session.sid, {
        path: '/',
        httpOnly: true,
        secure: app.config.cookieSecure,
        sameSite: 'lax',
        maxAge: maxAgeSeconds,
      });
      reply.setCookie(app.config.csrfCookieName, result.session.csrfToken, {
        path: '/',
        httpOnly: false,
        secure: app.config.cookieSecure,
        sameSite: 'lax',
        maxAge: maxAgeSeconds,
      });
      reply.header('Cache-Control', 'no-store');
      request.auditLogged = true;

      return ok(request, {
        user: {
          id: result.user.id,
          name: result.user.name,
          role: result.user.role,
        },
        csrf_token: result.session.csrfToken,
        expires_at: new Date(result.session.absoluteExpiresAt).toISOString(),
        must_change_password: false,
      });
    },
  );

  app.post(
    '/api/auth/logout',
    { config: { minRole: 'viewer', idempotency: false, audit: false } },
    async (request, reply) => {
      if (!request.session) throw new ApiError('unauthorized', '请先登录');
      await app.authService.logout(request.session, {
        requestId: request.requestId,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      reply.clearCookie(app.config.sessionCookieName, { path: '/' });
      reply.clearCookie(app.config.csrfCookieName, { path: '/' });
      reply.header('Cache-Control', 'no-store');
      request.auditLogged = true;
      return ok(request, { ok: true });
    },
  );

  app.get('/api/me', { config: { minRole: 'viewer' } }, async (request) => {
    if (!request.session) throw new ApiError('unauthorized', '请先登录');
    return ok(request, await app.authService.me(request.session));
  });
}
