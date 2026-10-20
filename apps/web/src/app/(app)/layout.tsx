import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/shell/AppShell';
import { ErrorState } from '@/components/states/ErrorState';
import { getSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * 受保护壳层：服务端校验会话（GET /api/me）。
 * - 401 → 登录页（proxy 已尽力保留 return_url）；
 * - 网络/5xx → 整页错误态，不渲染任何业务数据。
 */
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();

  if (session.status === 'anonymous') redirect('/login');

  if (session.status === 'unavailable') {
    return (
      <main style={{ maxWidth: 720, margin: '12vh auto', padding: '0 20px' }}>
        <ErrorState
          title="无法加载当前会话"
          code={session.failure.code}
          message={session.failure.message}
          requestId={session.failure.requestId}
          nextAction={session.failure.nextAction}
        />
        <p style={{ marginTop: 12, fontSize: 13 }}>
          <a href="/login">重新登录</a> · 如果持续失败，请联系管理员检查 API 与数据库状态。
        </p>
      </main>
    );
  }

  return <AppShell me={session.me}>{children}</AppShell>;
}
