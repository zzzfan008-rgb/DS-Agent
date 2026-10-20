import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '询盘工作台' };
export const dynamic = 'force-dynamic';

export default async function InquiryPage() {
  const guard = await guardPage(PERMISSIONS.inquiryRead, '询盘读取（inquiry.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="询盘工作台"
      description="1688 旺旺询盘、阶梯报价、起批条件与代发能力。M1 不接询盘流，不发送任何报价。"
      milestone="M5"
      blocks={[
        { title: '询盘列表', detail: '分销商名、待报价标记、last_message_at、账期标记；筛选与排序。' },
        { title: '询盘详情', detail: '历史报价、起批条件、代发能力、SKU 清单；首次询盘引导建立报价。' },
        { title: '报价单编辑器', detail: 'price_tiers[{min_qty, price_cents}]、min_order_qty、lead_time_days、毛利预估；阶梯价重叠/倒挂行内报错。' },
        { title: '报价状态条', detail: 'approval.status / sla_due_at / quote.status；C 级不可逆，需审批后发送。' },
      ]}
      emptyTitle="M1 不渲染询盘"
      emptyDescription="询盘端点（POST /inquiries/:id/quote 等）将在 M5 接入；本页当前只验证路由与权限骨架。"
      note="报价永远是 C 级不可逆：M1 不提供任何发送入口。"
    />
  );
}
