import type { Metadata } from 'next';
import { ModelsView } from '@/components/models/ModelsView';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '模型与供应商' };
export const dynamic = 'force-dynamic';

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const guard = await guardPage(undefined);
  if (!guard.ok) return guard.node;

  const params = await searchParams;
  const raw = Array.isArray(params.view) ? params.view[0] : params.view;
  const view = raw === 'backend' ? 'backend' : 'frontend';
  const canWrite = guard.me.permissions.includes(PERMISSIONS.modelWrite);

  if (view === 'backend' && !canWrite) {
    return <ForbiddenState requiredPermission="模型写（model.write）" />;
  }

  return <ModelsView canWrite={canWrite} initialView={view} />;
}
