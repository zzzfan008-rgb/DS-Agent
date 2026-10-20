/**
 * 权限键与页面可见性。
 *
 * 唯一真源是 packages/core/src/authz/matrix.ts 与后端 GET /me.permissions[]；
 * 前端只做「有键就显示、无键就隐藏」，**不按角色名硬编码**（docs/13 V1、队长确认）。
 */

export const PERMISSIONS = {
  dashboardRead: 'dashboard.read',
  productRead: 'product.read',
  contentRead: 'content.read',
  mediaRead: 'media.read',
  conversationRead: 'conversation.read',
  inquiryRead: 'inquiry.read',
  approvalRead: 'approval.read',
  kbRead: 'kb.read',
  auditRead: 'audit.read',
  usersWrite: 'users.write',
  modelWrite: 'model.write',
  modelRead: 'model.read',
  routeRead: 'route.read',
  killSwitchRead: 'kill_switch.read',
} as const;

export function can(permissions: readonly string[], permission?: string | null): boolean {
  if (!permission) return true;
  return permissions.includes(permission);
}
