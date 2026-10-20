import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '素材库' };
export const dynamic = 'force-dynamic';

export default async function MediaPage() {
  const guard = await guardPage(PERMISSIONS.mediaRead, '素材读取（media.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="素材库"
      description="实拍、AI 场景图/白底/模特替换、尺码表图、短视频样片与成本归集。M1 不发起任何媒体任务。"
      milestone="M6"
      blocks={[
        { title: '任务区', detail: 'media_job 状态、attempt、poll_after、成本预留/实付、last_error；kill switch 命中时禁用生成。' },
        { title: '样片区', detail: '仅 AI 短视频：5 条样片并排、sample_decision 记录选用/弃用。' },
        { title: '素材网格', detail: 'kind / is_aigc / status / 尺寸 / 成本；隔离素材红色角标“不可用”。' },
        { title: '资产详情抽屉', detail: '变体、provider/model/prompt_version、引用关系、授权号、AIGC 标识预览。' },
        { title: '成本面板', detail: '按 SKU/类型/供应商/日聚合；金额一律整数分转元展示。' },
      ]}
      emptyTitle="M1 不渲染素材"
      emptyDescription="媒体任务与素材端点（G 组 9 个）将在 M6 接入；本页当前只验证路由与权限骨架。"
      note="主图必须是实拍：M1 不提供“用 AI 图替代主图”的任何入口（docs/00 §1.3）。"
    />
  );
}
