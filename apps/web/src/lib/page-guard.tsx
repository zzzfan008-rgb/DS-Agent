import type { ReactNode } from 'react';
import type { Me } from './contracts';
import { getSession } from './auth';
import { ForbiddenState } from '@/components/states/ForbiddenState';

export type PageGuardResult =
  | { ok: true; me: Me }
  | { ok: false; node: ReactNode };

/**
 * 页面级权限门（服务端）：只读 `/me.permissions[]`，不按角色名硬编码。
 * 未登录由 (app)/layout 统一跳登录；这里返回 null 占位，避免把 401 渲染成 403。
 */
export async function guardPage(permission?: string, permissionLabel?: string): Promise<PageGuardResult> {
  const session = await getSession();
  if (session.status !== 'authenticated') return { ok: false, node: null };
  if (permission && !session.me.permissions.includes(permission)) {
    return {
      ok: false,
      node: <ForbiddenState requiredPermission={permissionLabel ?? permission} />,
    };
  }
  return { ok: true, me: session.me };
}
