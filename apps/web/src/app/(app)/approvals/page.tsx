import type { Metadata } from 'next';
import { ApprovalsView } from '@/components/approvals/ApprovalsView';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { getSession } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '审批中心' };
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const session = await getSession();
  if (session.status !== 'authenticated') return null;

  if (!session.me.permissions.includes(PERMISSIONS.approvalRead)) {
    return <ForbiddenState requiredPermission="审批读取（approval.read）" />;
  }

  return <ApprovalsView currentUserName={session.me.name} />;
}
