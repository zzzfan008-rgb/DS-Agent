import type { Metadata } from 'next';
import { CopyWorkbench } from '@/components/copy/CopyWorkbench';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '文案工作台' };
export const dynamic = 'force-dynamic';

export default async function CopyPage() {
  const guard = await guardPage(PERMISSIONS.contentRead, '内容读取（content.read）');
  if (!guard.ok) return guard.node;

  return (
    <CopyWorkbench canWrite={guard.me.permissions.includes(PERMISSIONS.contentWrite)} />
  );
}
