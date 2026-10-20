'use client';

import { useEffect, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import { fetchModels } from '@/lib/models-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ModelItem } from '@/lib/m3-types';
import { CAPABILITY_LABEL, PURPOSE_LABEL, VISIBLE_REASON_LABEL } from '@/lib/m3-format';
import { Chip, Spinner } from '@/components/m3/M3Ui';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { PanelCard, PriceTag } from './model-ui';
import { ProviderPanel } from './ProviderPanel';
import { ModelPanel } from './ModelPanel';
import { RoutePanel } from './RoutePanel';
import { UsagePanel } from './UsagePanel';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

type BackendTab = 'provider' | 'model' | 'route' | 'usage';

const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;

export interface ModelsViewProps {
  canWrite: boolean;
  initialView: 'frontend' | 'backend';
}

export function ModelsView({ canWrite, initialView }: ModelsViewProps) {
  const [view, setView] = useState<'frontend' | 'backend'>(
    initialView === 'backend' && canWrite ? 'backend' : 'frontend',
  );
  const [tab, setTab] = useState<BackendTab>('provider');

  return (
    <div className={m3.pageStack}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>模型与供应商</h1>
          <p className={styles.subtitle}>
            后台维护 Provider / Model / Route；前台只读展示当前角色可用模型与价格。生成按路由策略自动选择，本页不提供“选用”开关。
          </p>
        </div>
        <Chip tone="info">M3</Chip>
      </div>

      <div className={styles.viewTabs} role="tablist" aria-label="模型视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'frontend'}
          className={`${styles.viewTab} ${view === 'frontend' ? styles.viewTabActive : ''}`}
          onClick={() => setView('frontend')}
        >
          前台视图（只读）
        </button>
        {canWrite ? (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'backend'}
            className={`${styles.viewTab} ${view === 'backend' ? styles.viewTabActive : ''}`}
            onClick={() => setView('backend')}
          >
            后台视图（配置）
          </button>
        ) : null}
      </div>

      {view === 'frontend' ? <FrontendModels /> : null}

      {view === 'backend' && canWrite ? (
        <>
          <div className={m3.segmented} role="tablist" aria-label="后台配置区">
            {[
              ['provider', 'Provider'],
              ['model', 'Model'],
              ['route', 'Route'],
              ['usage', '用量与成本'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? m3.segmentActive : undefined}
                onClick={() => setTab(value as BackendTab)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'provider' ? <ProviderPanel /> : null}
          {tab === 'model' ? <ModelPanel /> : null}
          {tab === 'route' ? <RoutePanel /> : null}
          {tab === 'usage' ? <UsagePanel /> : null}
        </>
      ) : null}
    </div>
  );
}

function FrontendModels() {
  const [purpose, setPurpose] = useState<string>('all');
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchModels({ limit: 100, ...(purpose === 'all' ? {} : { purpose }) })
      .then((items) => {
        if (!cancelled) setModels(items.filter((model) => model.visible));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(caught);
          return;
        }
        setError({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '模型列表加载失败',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [purpose, reload]);

  return (
    <PanelCard
      title="当前角色可用模型（只读）"
      description="只显示 visible=true 的模型；原因由服务端判定，前端不推断。价格主显示“分/单位”，辅助人民币。"
      actions={
        <div className={m3.inlineActions}>
          <select
            className={m3.select}
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            aria-label="按用途筛选"
          >
            <option value="all">全部用途</option>
            {PURPOSES.map((item) => (
              <option key={item} value={item}>
                {PURPOSE_LABEL[item] ?? item}
              </option>
            ))}
          </select>
          <button type="button" className="buttonSecondary" onClick={() => setReload((value) => value + 1)}>
            刷新
          </button>
        </div>
      }
    >
      {loading ? <Spinner label="加载模型" /> : null}
      {error ? (
        <ErrorState
          title="模型列表加载失败"
          code={error.code}
          message={error.message}
          requestId={error.requestId}
          nextAction={error.nextAction}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : null}
      {!loading && !error && models.length === 0 ? (
        <EmptyState
          title="当前角色没有可用模型"
          description="可能原因（按服务端判定，前端不推断）：你的角色没有该用途权限；没有 active 路由；模型未发布或参数不合法；供应商凭据/连通性不可用。viewer 仅只读，不参与调用用途。"
          icon="model"
        />
      ) : null}
      {models.length > 0 ? (
        <div className={styles.modelCards}>
          {models.map((model) => (
            <article className={styles.modelCard} key={model.id}>
              <div className={styles.modelCardHead}>
                <div>
                  <h2 className={styles.modelName}>{model.display_name}</h2>
                  <p className={styles.modelMeta}>
                    <Chip tone="info">{CAPABILITY_LABEL[model.capability] ?? model.capability}</Chip>
                    <span className={m3.mono}>{model.external_model_id}</span>
                  </p>
                </div>
                <span className={styles.readonlyBadge}>只读</span>
              </div>
              <PriceTag price={model.price} capability={model.capability} />
              <div className={styles.modelFooter}>
                <span>price_version {model.price_version}</span>
                {model.rate_limit?.rpm ? <span>rpm {model.rate_limit.rpm}</span> : null}
                {model.rate_limit?.tpm ? <span>tpm {model.rate_limit.tpm}</span> : null}
                {model.published_at ? <span>发布 {model.published_at.slice(0, 10)}</span> : null}
              </div>
              {!model.visible && model.visible_reason ? (
                <p className={m3.muted}>
                  不可见原因：{VISIBLE_REASON_LABEL[model.visible_reason] ?? model.visible_reason}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      <p className={m3.muted} style={{ marginTop: 12 }}>
        文案工作台固定显示“模型：由路由策略自动选择（copy 用途）”；本页不提供选用器，避免产生“选中即生效”的假开关。
      </p>
    </PanelCard>
  );
}
