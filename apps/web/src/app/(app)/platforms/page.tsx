import type { Metadata } from 'next';
import { PlatformsView } from '@/components/platforms/PlatformsView';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '平台连接' };
export const dynamic = 'force-dynamic';

/**
 * 平台连接（docs/13c）。页面登录即可（最低 viewer）；写操作按 provider.write 门控。
 *
 * TODO: 权限矩阵缺 platform.write，暂复用 provider.write（docs/13 §3.9 待补键）。
 * 补键后只改这一行，组件接口不用动；在此之前不要改成按 role 名硬编码（违反 13a 硬要求 2）。
 */
export default async function PlatformsPage() {
  const guard = await guardPage(undefined);
  if (!guard.ok) return guard.node;

  return <PlatformsView canWrite={guard.me.permissions.includes(PERMISSIONS.providerWrite)} />;
}
