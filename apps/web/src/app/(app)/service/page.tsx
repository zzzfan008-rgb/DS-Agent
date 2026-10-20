import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '客服工作台' };
export const dynamic = 'force-dynamic';

export default async function ServicePage() {
  const guard = await guardPage(PERMISSIONS.conversationRead, '会话读取（conversation.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="客服工作台"
      description="拼多多消费者会话：秒级提醒、AI 草稿（5 秒降级）与人工确认发送。M1 不接会话流，不发送任何消息。"
      milestone="M5"
      blocks={[
        { title: '会话列表', detail: 'unread_count / last_message_at / first_response_due_at / draft_state / buyer_nick；j/k 选择、Enter 打开。' },
        { title: '会话窗', detail: '消息流按 direction/status 渲染；发送失败气泡标红并提供重试/复制。' },
        { title: '草稿卡', detail: 'draft_state；3s 提示、5s 必降级为已审批话术模板，不覆盖用户编辑。' },
        { title: '发送确认条', detail: '两次确认 + outbound_idempotency_key；发送后不可撤回；kill switch 命中禁用。' },
        { title: '客户侧栏 / 快捷键', detail: '买家标签、历史订单、知识片段；? 面板与 e/a/s/d/m 等键在 M5 接入。' },
      ]}
      emptyTitle="M1 不接会话"
      emptyDescription="客服端点（H 组 7 个）与 SSE message.new 将在 M5 接入；本页当前只验证路由与权限骨架。"
      note="M1 的 SSE 灯明确显示“实时未接入”，不会用假数据模拟秒级提醒。"
    />
  );
}
