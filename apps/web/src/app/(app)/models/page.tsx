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

export const metadata: Metadata = { title: '模型与供应商' };
export const dynamic = 'force-dynamic';

export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const guard = await guardPage(undefined);
  if (!guard.ok) return guard.node;

  const params = await searchParams;
  const raw = Array.isArray(params.view) ? params.view[0] : params.view;
  const view = raw === 'backend' ? 'backend' : 'frontend';
  const canBackend = guard.me.permissions.includes(PERMISSIONS.modelWrite);

  if (view === 'backend' && !canBackend) {
    return <ForbiddenState requiredPermission="模型写（model.write）" />;
  }

  const tabs: TabItem[] = [
    { href: '/models?view=frontend', label: '前台视图（选用）', active: view === 'frontend' },
  ];
  if (canBackend) {
    tabs.push({ href: '/models?view=backend', label: '后台视图（配置）', active: view === 'backend' });
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="模型与供应商"
        description={
          view === 'backend'
            ? 'Provider / Model / Route 三层配置：接入、测试连通、发布、降级链与配额。改动下个请求生效，无需重启。'
            : '前台只用 visible=true 的模型：看能力、单价（分→元）、降级链与配额余量，不显示供应商账号细节。'
        }
        badges={
          <>
            <span className="badge badgeM1">M1 骨架</span>
            <span className="badge">后台 tab 需 model.write</span>
          </>
        }
      />

      <TabNav items={tabs} label="模型视图" />

      {view === 'backend' ? (
        <PlaceholderBody
          blocks={[
            { title: 'Providers', detail: 'kind / base_url / credential_ref（只显示是否已配置）/ connectivity / balance_cents；密钥永不返回值。' },
            { title: 'Models', detail: 'external_model_id / capability / params_schema / price / rate_limit / status；params_schema 非法时禁止发布。' },
            { title: 'Routes', detail: 'scope_type（org/role/user）+ purpose + model_id + fallback_ids + priority + quota；循环降级行内报错。' },
            { title: '测试连通 / 发布', detail: 'POST /providers/:id/test、POST /models/:id/publish；写操作需要 Idempotency-Key 与审计。' },
          ]}
          emptyTitle="M1 不接模型配置"
          emptyDescription="模型端点（B 组 11 个）将在 M2 接入；本页当前只验证前台/后台视图的权限门与路由。"
          note="权限验证：viewer/operator 访问 /models?view=backend 会看到无权限态，且导航不渲染后台 tab（只读 /me.permissions[]）。"
        />
      ) : (
        <PlaceholderBody
          blocks={[
            { title: '可用模型', detail: 'GET /models 对前台只返回 visible=true；visible_reason 由服务端返回，前端只展示不推断。' },
            { title: '成本预估', detail: 'price.text.input_per_1k_cents / image.per_image_cents / video.per_second_cents / embed.per_1k_tokens_cents，展示前换算为元。' },
            { title: '降级链', detail: '首选 → 备选1 → 备选2；前台不显示供应商账号细节。' },
            { title: '不可用原因', detail: '供应商未配置 / 模型未发布或 schema 非法 / 角色无权 / 配额耗尽；四条原因由服务端给出。' },
          ]}
          emptyTitle="M1 不显示模型"
          emptyDescription="模型网关将在 M2 接入；当前不展示任何模型卡片，避免“可选模型”的误导。"
          note="视图切换本身不触发任何请求；M1 只验证 tab 的权限可见性与无权限态。"
        />
      )}
    </div>
  );
}
