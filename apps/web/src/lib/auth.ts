/**
 * 会话读取（仅服务端组件使用）。
 *
 * 每次请求调用 `GET /api/me` 并转发浏览器 Cookie（服务端直连 API，不依赖 rewrite）；
 * `cache()` 让同一请求内的 layout/page 只取一次。
 */
import { cache } from 'react';
import { cookies } from 'next/headers';
import { failureFromUnknown, parseApiResponse, serverFetchApi, type ApiFailure } from './api';
import type { HealthCheck, Me } from './contracts';
import { can } from './permissions';

export type SessionState =
  | { status: 'authenticated'; me: Me }
  | { status: 'anonymous' }
  | { status: 'unavailable'; failure: ApiFailure };

export const getSession = cache(async (): Promise<SessionState> => {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
  try {
    const response = await serverFetchApi('/api/me', cookieHeader);
    if (response.status === 401) return { status: 'anonymous' };
    const result = await parseApiResponse<Me>(response);
    if (!result.ok) return { status: 'unavailable', failure: result };
    return { status: 'authenticated', me: result.data };
  } catch (error) {
    return { status: 'unavailable', failure: failureFromUnknown(error) };
  }
});

export function sessionCan(me: Me, permission?: string): boolean {
  return can(me.permissions, permission);
}

export const getHealth = cache(async (): Promise<HealthCheck | null> => {
  try {
    const response = await serverFetchApi('/api/health', '', {
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: HealthCheck } | HealthCheck;
    if (body && typeof body === 'object' && 'data' in body && body.data) return body.data;
    return body as HealthCheck;
  } catch {
    return null;
  }
});
