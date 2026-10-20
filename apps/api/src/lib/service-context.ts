/** Fastify 请求 → 服务层上下文（request_id / 用户 / IP / UA）。 */
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export interface ServiceContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export function serviceContext(request: FastifyRequest): ServiceContext {
  if (!request.auth) throw new ApiError('unauthorized', '请先登录');
  return {
    requestId: request.requestId,
    userId: request.auth.userId,
    role: request.auth.role as ServiceContext['role'],
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
