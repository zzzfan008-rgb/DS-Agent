import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '文案工作台' };
export const dynamic = 'force-dynamic';

export default async function CopyPage() {
  const guard = await guardPage(PERMISSIONS.contentRead, '内容读取（content.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="文案工作台"
      description="生成 → 判断 → 审批 → 发布：标题、卖点、详情、FAQ 与短视频脚本。M1 不接模型，不产生任何文案。"
      milestone="M3"
      blocks={[
        { title: '输入区', detail: 'product_id / platform / content_type / tone / constraints；未选商品时先内嵌搜索。' },
        { title: '事实来源面板', detail: 'facts_refs + 主数据版本 + 尺码表版本 + 知识库切片；无引用禁止生成。' },
        { title: '生成结果（流式）', detail: 'run_id、步骤条、停止/重生成；SSE 事件见 docs/12 §7，M3 接入。' },
        { title: '判断结果', detail: 'verdict（pass/needs_revision/reject/escalate）+ severity + evidence_refs + repair_hint。' },
        { title: '版本对比 / 历史草稿', detail: 'AI 原文 vs 人工编辑 diff；草稿列表按状态与 verdict 筛选。' },
      ]}
      emptyTitle="M1 不生成文案"
      emptyDescription="文案端点（POST /content/drafts 等）将在 M3 接入；本页当前只验证路由与权限骨架。"
      note="M1 明确不调用模型：页面没有任何生成按钮，避免造成“可用”的误解。"
    />
  );
}
