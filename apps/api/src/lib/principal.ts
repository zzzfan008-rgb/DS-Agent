/** 从认证上下文构造 registry Principal（含 roleId，供 role 级路由匹配）。 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal, Role } from '@dssaas/registry';
import { ApiError } from './errors.js';

export async function principalFromRequest(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<Principal> {
  if (!request.auth) throw new ApiError('unauthorized', '请先登录');
  const roleRow = await app.prisma.role.findFirst({
    where: { code: request.auth.role, orgId: BigInt(request.auth.orgId), archivedAt: null },
    select: { id: true },
  });
  return {
    orgId: request.auth.orgId,
    userId: request.auth.userId,
    roles: [request.auth.role as Role],
    roleIds: roleRow ? [roleRow.id] : [],
  };
}
