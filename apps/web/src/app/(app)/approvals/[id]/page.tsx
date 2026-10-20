import type { Metadata } from 'next';
import { ApprovalDetailRoute } from '@/components/approvals/ApprovalDetailRoute';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { getSession } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '审批详情' };
export const dynamic = 'force-dynamic';

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (session.status !== 'authenticated') return null;

  if (!session.me.permissions.includes(PERMISSIONS.approvalRead)) {
    return <ForbiddenState requiredPermission="审批读取（approval.read）" />;
  }

  const { id } = await params;
  return <ApprovalDetailRoute id={id} />;
}
