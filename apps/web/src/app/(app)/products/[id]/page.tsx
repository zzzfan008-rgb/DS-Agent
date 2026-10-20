import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '商品详情' };
export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardPage(PERMISSIONS.productRead, '商品读取（product.read）');
  if (!guard.ok) return guard.node;

  const { id } = await params;

  return (
    <PlaceholderPage
      title="商品详情"
      description={`商品 ${id} 的详情骨架：基础信息、尺码表（按版本分组）、成分、平台属性、素材与上架态。M1 不请求商品端点。`}
      milestone="M3"
      blocks={[
        { title: '基础信息', detail: 'spu_code、名称、类目、fit；价格与库存均为整数分/整数件。' },
        { title: '尺码表（按版本）', detail: 'version_no + effective_from 分组，版本内多码多行；同时只有一个生效版本（t17 EXCLUDE）。' },
        { title: '成分与平台属性', detail: '成分合计必须 100；平台属性未映射时列出待补项。' },
        { title: '素材与上架态', detail: '主图 ≥3、白底 1、尺码表图、详情 ≥4；listing.status 5 态 + platform_state。' },
      ]}
      emptyTitle="M1 详情占位"
      emptyDescription="商品详情端点（GET /products/:id）将在 M3 接入；当前页面仅验证路由、权限与四态骨架。"
      note={`路由参数 id=${id} 已正确解析（服务端）。`}
    />
  );
}
