import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LoginScreen } from '@/components/login/LoginScreen';
import { getHealth, getSession } from '@/lib/auth';

export const metadata: Metadata = { title: '登录' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_url?: string | string[] }>;
}) {
  const session = await getSession();
  if (session.status === 'authenticated') redirect('/');

  const [health, params] = await Promise.all([getHealth(), searchParams]);
  const raw = params.return_url;
  const returnUrl = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);

  return <LoginScreen health={health} returnUrl={returnUrl} version="0.1.0" />;
}
