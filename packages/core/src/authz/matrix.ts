/**
 * 角色与权限矩阵（docs/14 §2；docs/12 §3.1）。
 *
 * 约定：
 * - 角色只有三档：viewer < operator < admin（docs/00 §6.1）；
 * - 权限点是「资源.动作」的扁平字符串，前端按它显示/隐藏按钮；
 * - 这里是代码侧的唯一矩阵（docs/14 §2.5 要求矩阵落在 packages/core），
 *   DB `roles.permissions` 是可选的缓存/覆盖，不取代本矩阵；
 * - 默认拒绝：未列出的组合一律拒绝。
 */

export const ROLES = ['viewer', 'operator', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** 角色等级：用于 requireRole 的粗粒度比较。 */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** viewer：只读（docs/14 §2.2）。 */
const VIEWER_PERMISSIONS = [
  'product.read',
  'size_chart.read',
  'fabric.read',
  'attribute.read',
  'content.read',
  'judgment.read',
  'approval.read',
  'listing.read',
  'conversation.read',
  'reply.read',
  'inquiry.read',
  'media.read',
  'kb.read',
  'kill_switch.read',
  'dashboard.read',
] as const;

/** operator：viewer + 运营写（写平台仍须 approval_id）。 */
const OPERATOR_PERMISSIONS = [
  ...VIEWER_PERMISSIONS,
  'product.write',
  'product.import',
  'size_chart.write',
  'fabric.write',
  'attribute.write',
  'content.write',
  'approval.decide',
  'listing.write',
  'listing.stop_loss',
  'reply.write',
  'reply.send',
  'inquiry.write',
  'media.write',
  'kb.write',
  'sync.trigger',
  'kill_switch.trigger',
  'agent.run',
] as const;

/** admin：operator + 管理面与删除/审计/指标。 */
const ADMIN_PERMISSIONS = [
  ...OPERATOR_PERMISSIONS,
  'product.delete',
  'size_chart.delete',
  'attribute.delete',
  'content.delete',
  'media.delete',
  'kb.delete',
  'kb.reindex',
  'provider.read',
  'provider.write',
  'model.read',
  'model.write',
  'route.read',
  'route.write',
  'users.read',
  'users.write',
  'audit.read',
  'metrics.read',
  'kill_switch.release',
  'backup.restore',
  'agent.run_all',
] as const;

export const ROLE_PERMISSIONS: Record<Role, readonly string[]> = {
  viewer: VIEWER_PERMISSIONS,
  operator: OPERATOR_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** 从多角色中取最高一档；空集合返回 null。 */
export function highestRole(codes: Iterable<string>): Role | null {
  let best: Role | null = null;
  for (const code of codes) {
    if (!isRole(code)) continue;
    if (best === null || ROLE_RANK[code] > ROLE_RANK[best]) best = code;
  }
  return best;
}

/** 角色的权限集合（admin 返回全量，便于前端直接展示）。 */
export function permissionsForRole(role: Role): string[] {
  return [...ROLE_PERMISSIONS[role]];
}

/** 粗粒度判断：role 是否达到 minimum。 */
export function hasRole(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** 细粒度判断：角色是否拥有某权限点。 */
export function can(role: Role, permission: string): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
