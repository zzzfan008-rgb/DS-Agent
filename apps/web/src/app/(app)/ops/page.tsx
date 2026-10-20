import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/PageHeader';
import {
  PlaceholderBody,
  TabNav,
  type TabItem,
} from '@/components/common/PlaceholderPage';
import { ForbiddenState } from '@/components/states/ForbiddenState';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';
import styles from '@/components/common/common.module.css';

export const metadata: Metadata = { title: '运营看板' };
export const dynamic = 'force-dynamic';

type OpsTab = 'dashboard' | 'audit' | 'settings';

const TAB_LABEL: Record<OpsTab, string> = {
  dashboard: '看板',
  audit: '审计',
  settings: '设置',
};

const TAB_PERMISSION: Record<OpsTab, string> = {
  dashboard: PERMISSIONS.dashboardRead,
  audit: PERMISSIONS.auditRead,
  settings: PERMISSIONS.usersWrite,
};

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const guard = await guardPage(PERMISSIONS.dashboardRead, '看板读取（dashboard.read）');
  if (!guard.ok) return guard.node;

  const params = await searchParams;
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const requested: OpsTab =
    raw === 'audit' || raw === 'settings' || raw === 'dashboard' ? raw : 'dashboard';

  const allowed = (tab: OpsTab) => guard.me.permissions.includes(TAB_PERMISSION[tab]);

  if (!allowed(requested)) {
    return (
      <ForbiddenState
        title="无权访问该 tab"
        requiredPermission={`${TAB_LABEL[requested]}权限（${TAB_PERMISSION[requested]}）`}
      />
    );
  }

  const tabs: TabItem[] = (['dashboard', 'audit', 'settings'] as OpsTab[])
    .filter((tab) => allowed(tab))
    .map((tab) => ({
      href: `/ops?tab=${tab}`,
      label: TAB_LABEL[tab],
      active: tab === requested,
    }));

  return (
    <div className={styles.page}>
      <PageHeader
        title={`运营看板 · ${TAB_LABEL[requested]}`}
        description="经营/成本/质量看板、审计与设置。M1 只搭路由与权限门，不渲染任何指标或审计数据。"
        badges={
          <>
            <span className="badge badgeM1">M1 骨架</span>
            <span className="badge">tab 由 permissions[] 决定</span>
          </>
        }
      />

      <TabNav items={tabs} label="运营看板视图" />

      {requested === 'dashboard' ? (
        <PlaceholderBody
          blocks={[
            { title: '经营', detail: '发布成功率、驳回可恢复率、止损时效、SLA 违约；切时间窗与导出。' },
            { title: '成本', detail: '按 SKU/模型/供应商/日的成本与预算使用率；金额整数分。' },
            { title: '质量', detail: '素材抽检合格率、事实错误率（0 容忍项红标）、草稿降级率。' },
            { title: '快照', detail: '30s 快照 + SSE 事件；单图失败不影响其他图。' },
          ]}
          emptyTitle="M1 不渲染指标"
          emptyDescription="看板端点（GET /dashboard/ops、/dashboard/cost）将在 M8 接入；当前不显示任何图表，避免假数据。"
          note="M1 不引入图表库；图表选型与包体积预算在 M9 门禁中复验。"
        />
      ) : null}

      {requested === 'audit' ? (
        <PlaceholderBody
          blocks={[
            { title: '审计列表', detail: 'actor / action / level / irreversible / approval_id / request_id / before_hash / after_hash。' },
            { title: '筛选与分页', detail: 'actor / action / resource_type / resource_id / irreversible / from / to；游标分页。' },
            { title: '详情与跳转', detail: '按 request_id 反查资源；approval_id / ticket_id 可跳转。' },
            { title: '导出', detail: '大范围导出需缩小时间窗提示，避免全表扫。' },
          ]}
          emptyTitle="M1 不展示审计"
          emptyDescription="GET /api/audit 已在 t2 交付（admin），但本页表格与筛选将在 M8 接入；当前不做半成品请求。"
          note="权限验证：viewer/operator 访问 /ops?tab=audit 显示无权限态，且 tab 不渲染。"
        />
      ) : null}

      {requested === 'settings' ? (
        <PlaceholderBody
          blocks={[
            { title: '账号与角色', detail: '用户、角色、状态、TOTP、代理关系；不能降级最后一个 admin / 不能自降。' },
            { title: 'kill switch', detail: 'scope_type / scope_key / action / enabled / expires_at；开启需理由，关闭二次确认。' },
            { title: '不可逆登记 / 补偿工单', detail: 'level / impact_scope / status / owner / sla_due_at；关闭需证据。' },
            { title: '死信与重放 / 备份', detail: 'replay 需理由与六条校验；备份状态与 DSH 版本锁。' },
          ]}
          emptyTitle="M1 不提供设置写入"
          emptyDescription="账号、kill switch、补偿工单与备份端点将在 M4–M8 接入；M1 不提供任何配置入口。"
          note="权限验证：该 tab 需 users.write；viewer/operator 直达 URL 显示无权限态，不泄露设置内容。"
        />
      ) : null}
    </div>
  );
}
