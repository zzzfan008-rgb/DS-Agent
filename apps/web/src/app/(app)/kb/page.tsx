import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '知识库' };
export const dynamic = 'force-dynamic';

export default async function KbPage() {
  const guard = await guardPage(PERMISSIONS.kbRead, '知识库读取（kb.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="知识库"
      description="政策、尺码、洗护、退换与话术文档：上传解析、切片、检索测试、版本与过期告警。M1 不做检索。"
      milestone="M7"
      blocks={[
        { title: '文档列表', detail: 'title / domain / version / effective_at / chunks / status；删除被引用中的文档必须阻止。' },
        { title: '上传解析', detail: '文件、domain、effective_at、source_ref；解析进度与格式限制。' },
        { title: '切片预览', detail: '切片文本、来源、版本；重新切片与删除切片。' },
        { title: '检索测试', detail: 'q / k / hits（score、version、effective_at、source_ref）；degraded 时明确“关键词检索，低置信”。' },
        { title: '过期告警', detail: '生效日期已过/即将过期的文档；更新或归档。' },
      ]}
      emptyTitle="M1 不接知识库"
      emptyDescription="知识库端点（J 组 5 个）将在 M7 接入；本页当前只验证路由与权限骨架。"
      note="AI 产出必须标注知识库切片与生效日期；M1 不显示任何“已引用”状态。"
    />
  );
}
