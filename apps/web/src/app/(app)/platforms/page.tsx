import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/common/PlaceholderPage';
import { guardPage } from '@/lib/page-guard';

export const metadata: Metadata = { title: '平台连接' };
export const dynamic = 'force-dynamic';

export default async function PlatformsPage() {
  const guard = await guardPage(undefined);
  if (!guard.ok) return guard.node;

  return (
    <PlaceholderPage
      title="平台连接"
      description="拼多多与 1688 的授权状态、契约版本、部署约束、同步状态与未自动化接口清单。M1 不发任何平台请求。"
      milestone="M8"
      blocks={[
        { title: '平台卡', detail: '授权状态、连通性、contract_version、部署约束（公网 / IP 白名单 / 指定机房）、edge-proxy 状态。' },
        { title: '公告摘要', detail: '公告标题、日期、影响接口与处理状态；抓取失败不阻塞其他区块。' },
        { title: '未自动化接口清单', detail: '接口名、原因（权限 / 机房 / 未支持）与替代人工路径。' },
        { title: '同步状态', detail: 'lag_seconds / last_success_at / errors；stale 黄条、连续失败红条。' },
        { title: '健康检查', detail: 'GET /health 的 db/redis/minio/dsh_host/platforms；down 时列出不健康项。' },
      ]}
      emptyTitle="M1 不连平台"
      emptyDescription="平台授权与同步将在 M8 接入；本页当前只验证路由与权限骨架。"
      note="只读页面：M1 不提供“测试连接/手动同步”按钮，避免误触发平台请求。"
    />
  );
}
