import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';

export const metadata: Metadata = { title: '商品库' };
export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  const guard = await guardPage(PERMISSIONS.productRead, '商品读取（product.read）');
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="商品库"
      description="SPU/SKU 主数据、尺码表、面料成分、平台属性映射与双平台上架态。M1 只搭页面骨架，不渲染任何商品数据。"
      milestone="M3"
      blocks={[
        { title: '列表 + 筛选', detail: 'spu_code / name / category / sku_count / missing_fields / platform_states / size_chart_version；筛选与 30s 轮询在 M3 接入。' },
        { title: '详情：基础', detail: '名称、类目、fit、SPU/SKU 三元组、价格（整数分）、库存；写操作按 A/B 级审批。' },
        { title: '详情：尺码表', detail: '按版本分组展示；一个商品同时只有一个生效版本，版本内可多码多行（DB EXCLUDE 约束，t17）。' },
        { title: '详情：成分 / 属性 / 素材 / 上架态', detail: '成分合计 100 校验、平台属性映射、主图/白底/尺码表图、listing.status + platform_state。' },
        { title: '批量操作条', detail: '已选数、取最高级别、batch_id、拆单提示；A/B 允许批量，C 级禁止在审批中心批量。' },
      ]}
      emptyTitle="M1 不渲染商品数据"
      emptyDescription="商品列表与详情端点将在 M3 接入；届时此页展示真实主数据，并提供缺失字段红点与导入入口。"
      note="尺码表展示口径：按版本分组（version_no + effective_from），版本内可多码多行；不得假设“一个商品只有一行尺码”。M1 商品详情为占位，未展示尺码表。"
    />
  );
}
