'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import {
  createRoute,
  fetchModels,
  fetchRoutes,
  updateRoute,
  type RouteCreateInput,
} from '@/lib/models-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ModelItem, RouteItem } from '@/lib/m3-types';
import { PURPOSE_LABEL, ROUTE_STATUS_LABEL } from '@/lib/m3-format';
import { Drawer, Field, InlineAlert, Spinner } from '@/components/m3/M3Ui';
import { ErrorLine, PanelCard, RouteStatus } from './model-ui';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;

interface RouteForm {
  scope_type: 'org' | 'role' | 'user';
  scope_role_id: string;
  scope_user_id: string;
  purpose: (typeof PURPOSES)[number];
  model_id: string;
  fallback_ids: string[];
  priority: string;
  status: 'draft' | 'active' | 'paused' | 'retired';
  rpm: string;
  tpm: string;
  concurrency: string;
  daily_calls: string;
  daily_cost_cents: string;
  monthly_cost_cents: string;
  effective_from: string;
  effective_to: string;
  label: string;
}

const EMPTY_FORM: RouteForm = {
  scope_type: 'org',
  scope_role_id: '',
  scope_user_id: '',
  purpose: 'copy',
  model_id: '',
  fallback_ids: [],
  priority: '100',
  status: 'draft',
  rpm: '',
  tpm: '',
  concurrency: '',
  daily_calls: '',
  daily_cost_cents: '',
  monthly_cost_cents: '',
  effective_from: '',
  effective_to: '',
  label: '',
};

function toIsoDate(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function datePart(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

function quotaOf(form: RouteForm): NonNullable<RouteCreateInput['quota']> {
  return {
    ...(form.rpm ? { rpm: Number(form.rpm) } : {}),
    ...(form.tpm ? { tpm: Number(form.tpm) } : {}),
    ...(form.concurrency ? { concurrency: Number(form.concurrency) } : {}),
    ...(form.daily_calls ? { daily_calls: Number(form.daily_calls) } : {}),
    ...(form.daily_cost_cents ? { daily_cost_cents: Number(form.daily_cost_cents) } : {}),
    ...(form.monthly_cost_cents ? { monthly_cost_cents: Number(form.monthly_cost_cents) } : {}),
  };
}

function routeToForm(route: RouteItem): RouteForm {
  return {
    scope_type: route.scope_type,
    scope_role_id: route.scope_role_id ?? '',
    scope_user_id: route.scope_user_id ?? '',
    purpose: route.purpose,
    model_id: route.model_id,
    fallback_ids: route.fallback_ids,
    priority: String(route.priority),
    status: route.status,
    rpm: route.quota.rpm === null ? '' : String(route.quota.rpm),
    tpm: route.quota.tpm === null ? '' : String(route.quota.tpm),
    concurrency: route.quota.concurrency === null ? '' : String(route.quota.concurrency),
    daily_calls: route.quota.daily_calls === null ? '' : String(route.quota.daily_calls),
    daily_cost_cents: route.quota.daily_cost_cents === null ? '' : String(route.quota.daily_cost_cents),
    monthly_cost_cents:
      route.quota.monthly_cost_cents === null ? '' : String(route.quota.monthly_cost_cents),
    effective_from: datePart(route.effective_from),
    effective_to: datePart(route.effective_to),
    label: route.label ?? '',
  };
}

export function RoutePanel() {
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<RouteItem | null>(null);
  const [form, setForm] = useState<RouteForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [purposeFilter, setPurposeFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchRoutes(), fetchModels({ limit: 100 })])
      .then(([routeItems, modelItems]) => {
        if (cancelled) return;
        setRoutes(routeItems);
        setModels(modelItems);
        if (!form.model_id && modelItems[0]) {
          setForm((previous) => ({ ...previous, model_id: modelItems[0]!.id }));
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(`${caught.code}: ${caught.message}`);
          return;
        }
        setError('Route 列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const modelName = (id: string): string =>
    models.find((model) => model.id === id)?.display_name ?? `${id.slice(0, 8)}…`;

  const update = (patch: Partial<RouteForm>) => setForm((previous) => ({ ...previous, ...patch }));

  const openCreate = () => {
    setEditing(null);
    setForm((previous) => ({ ...EMPTY_FORM, model_id: previous.model_id || models[0]?.id || '' }));
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEdit = (route: RouteItem) => {
    setEditing(route);
    setForm(routeToForm(route));
    setFormError(null);
    setDrawerOpen(true);
  };

  const submit = async () => {
    setFormError(null);
    if (!form.model_id) {
      setFormError('请选择主模型');
      return;
    }
    if (form.fallback_ids.includes(form.model_id)) {
      setFormError('主模型不能同时出现在 fallback');
      return;
    }
    if (form.fallback_ids.length > 3) {
      setFormError('fallback 最多 3 个');
      return;
    }
    if (form.scope_type === 'role' && !form.scope_role_id.trim()) {
      setFormError('scope_type=role 时必须填 scope_role_id（UUID）');
      return;
    }
    if (form.scope_type === 'user' && !form.scope_user_id.trim()) {
      setFormError('scope_type=user 时必须填 scope_user_id（UUID）');
      return;
    }
    const priority = Number(form.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 999) {
      setFormError('priority 必须是 1–999 的整数');
      return;
    }
    const quota = quotaOf(form);
    const effectiveFrom = toIsoDate(form.effective_from);
    const effectiveTo = toIsoDate(form.effective_to);
    if (form.effective_from && !effectiveFrom) {
      setFormError('effective_from 不是合法日期');
      return;
    }
    if (form.effective_to && !effectiveTo) {
      setFormError('effective_to 不是合法日期');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await updateRoute(
          editing.id,
          {
            model_id: form.model_id,
            fallback_ids: form.fallback_ids,
            priority,
            quota,
            status: form.status,
            effective_from: effectiveFrom,
            effective_to: effectiveTo,
            label: form.label.trim() || null,
          },
          editing.version,
        );
      } else {
        await createRoute({
          scope_type: form.scope_type,
          ...(form.scope_type === 'role' ? { scope_role_id: form.scope_role_id.trim() } : {}),
          ...(form.scope_type === 'user' ? { scope_user_id: form.scope_user_id.trim() } : {}),
          purpose: form.purpose,
          model_id: form.model_id,
          fallback_ids: form.fallback_ids,
          priority,
          quota,
          status: form.status === 'active' ? 'active' : 'draft',
          ...(effectiveFrom ? { effective_from: effectiveFrom } : {}),
          ...(effectiveTo ? { effective_to: effectiveTo } : {}),
          ...(form.label.trim() ? { label: form.label.trim() } : {}),
        });
      }
      setDrawerOpen(false);
      setReload((value) => value + 1);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.code === 'publish_blocked') {
          const blockers = caught.detail?.blockers;
          const missing = caught.detail?.missing;
          const parts: string[] = [];
          if (Array.isArray(blockers)) {
            for (const blocker of blockers) {
              const record = blocker as { model_id?: string; reason?: string };
              parts.push(`${record.model_id?.slice(0, 8) ?? '模型'}：${record.reason ?? '不可发布'}`);
            }
          }
          if (Array.isArray(missing)) parts.push(...missing.map(String));
          setFormError(`发布守卫未通过：${parts.length > 0 ? parts.join('；') : caught.message}`);
          return;
        }
        setFormError(`${caught.code}: ${caught.message}`);
        return;
      }
      setFormError('保存 Route 失败：网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredRoutes = useMemo(
    () =>
      (purposeFilter === 'all' ? routes : routes.filter((route) => route.purpose === purposeFilter)).slice().sort(
        (a, b) => a.purpose.localeCompare(b.purpose) || a.priority - b.priority,
      ),
    [routes, purposeFilter],
  );

  return (
    <PanelCard
      title="Route（作用域 / 用途 / 降级链）"
      description="active 路由必须引用已发布模型且同 scope/purpose/priority 不冲突；scope=role/user 需要 UUID（账号管理未实现，G14）。"
      actions={
        <div className={m3.inlineActions}>
          <select
            className={m3.select}
            value={purposeFilter}
            onChange={(event) => setPurposeFilter(event.target.value)}
            aria-label="按用途筛选路由"
          >
            <option value="all">全部用途</option>
            {PURPOSES.map((purpose) => (
              <option key={purpose} value={purpose}>
                {PURPOSE_LABEL[purpose] ?? purpose}
              </option>
            ))}
          </select>
          <button type="button" className="buttonPrimary" onClick={openCreate}>
            新建 Route
          </button>
        </div>
      }
    >
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {loading ? <Spinner label="加载 Route" /> : null}
      {!loading && routes.length === 0 ? (
        <div className={styles.emptyBlock}>
          <p>还没有路由。至少为 copy / judge 各配一条 active 路由，文案与判定才能工作。</p>
          <button type="button" className="buttonSecondary" onClick={openCreate}>
            为每个用途配一条默认路由
          </button>
        </div>
      ) : null}
      {filteredRoutes.length > 0 ? (
        <div className={m3.tableWrap}>
          <table className={m3.table}>
            <caption>Route 列表</caption>
            <thead>
              <tr>
                <th scope="col">用途</th>
                <th scope="col">作用域</th>
                <th scope="col">主模型 / 降级链</th>
                <th scope="col">优先级</th>
                <th scope="col">配额（rpm / tpm / 并发 / 日调用 / 日成本 / 月成本）</th>
                <th scope="col">状态</th>
                <th scope="col">生效窗口</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredRoutes.map((route) => (
                <tr key={route.id}>
                  <th scope="row">{PURPOSE_LABEL[route.purpose] ?? route.purpose}</th>
                  <td>
                    <span className={styles.scopeCell}>
                      <span>{route.scope_type}</span>
                      {route.scope_role_id ? <span className={m3.mono}>{route.scope_role_id.slice(0, 8)}…</span> : null}
                      {route.scope_user_id ? <span className={m3.mono}>{route.scope_user_id.slice(0, 8)}…</span> : null}
                    </span>
                  </td>
                  <td>
                    <div className={styles.chain}>
                      <span>{modelName(route.model_id)}</span>
                      {route.fallback_ids.length > 0 ? (
                        <span className={m3.muted}>
                          → {route.fallback_ids.map((id) => modelName(id)).join(' → ')}
                        </span>
                      ) : (
                        <span className={m3.muted}>无降级</span>
                      )}
                    </div>
                  </td>
                  <td>{route.priority}</td>
                  <td className={m3.mono}>
                    {[
                      route.quota.rpm ?? '—',
                      route.quota.tpm ?? '—',
                      route.quota.concurrency ?? '—',
                      route.quota.daily_calls ?? '—',
                      route.quota.daily_cost_cents ?? '—',
                      route.quota.monthly_cost_cents ?? '—',
                    ].join(' / ')}
                  </td>
                  <td>
                    <RouteStatus route={route} />
                  </td>
                  <td className={m3.muted}>
                    {route.effective_from ? datePart(route.effective_from) : '—'} ~{' '}
                    {route.effective_to ? datePart(route.effective_to) : '∞'}
                  </td>
                  <td>
                    <button type="button" className="buttonSecondary" onClick={() => openEdit(route)}>
                      编辑
                    </button>
                    {route.status === 'active' && route.purpose !== 'copy' ? (
                      <p className={m3.muted}>同 scope/priority active 冲突会被后端拒绝</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!loading && routes.length > 0 && filteredRoutes.length === 0 ? (
        <p className={m3.muted}>该用途下没有路由。</p>
      ) : null}

      <Drawer
        open={drawerOpen}
        title={editing ? `编辑 Route · ${PURPOSE_LABEL[editing.purpose] ?? editing.purpose}` : '新建 Route'}
        description="scope/purpose 创建后不可改（PATCH 不支持）；active 保存会跑发布守卫。"
        onClose={() => setDrawerOpen(false)}
        width={640}
        footer={
          <>
            <button type="button" className="buttonSecondary" onClick={() => setDrawerOpen(false)} disabled={submitting}>
              取消
            </button>
            <button type="button" className="buttonPrimary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <Spinner label="保存中" /> : editing ? '保存 Route' : '创建 Route'}
            </button>
          </>
        }
      >
        {formError ? <InlineAlert tone="error">{formError}</InlineAlert> : null}
        <div className={m3.grid2}>
          <Field label="scope_type" htmlFor="route-scope" required>
            <select
              id="route-scope"
              className={m3.select}
              value={form.scope_type}
              onChange={(event) => update({ scope_type: event.target.value as RouteForm['scope_type'] })}
              disabled={Boolean(editing)}
            >
              <option value="org">org</option>
              <option value="role">role</option>
              <option value="user">user</option>
            </select>
          </Field>
          <Field label="purpose" htmlFor="route-purpose" required>
            <select
              id="route-purpose"
              className={m3.select}
              value={form.purpose}
              onChange={(event) => update({ purpose: event.target.value as RouteForm['purpose'] })}
              disabled={Boolean(editing)}
            >
              {PURPOSES.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {PURPOSE_LABEL[purpose] ?? purpose}
                </option>
              ))}
            </select>
          </Field>
          {form.scope_type === 'role' ? (
            <Field label="scope_role_id（UUID）" htmlFor="route-role" required hint="账号管理未实现，需从数据库/后续账号页复制">
              <input
                id="route-role"
                className={m3.input}
                value={form.scope_role_id}
                onChange={(event) => update({ scope_role_id: event.target.value })}
                disabled={Boolean(editing)}
              />
            </Field>
          ) : null}
          {form.scope_type === 'user' ? (
            <Field label="scope_user_id（UUID）" htmlFor="route-user" required hint="当前仅能从 /me 知道自己 id">
              <input
                id="route-user"
                className={m3.input}
                value={form.scope_user_id}
                onChange={(event) => update({ scope_user_id: event.target.value })}
                disabled={Boolean(editing)}
              />
            </Field>
          ) : null}
          <Field label="主模型" htmlFor="route-model" required>
            <select
              id="route-model"
              className={m3.select}
              value={form.model_id}
              onChange={(event) => update({ model_id: event.target.value })}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.display_name}（{model.status}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="status" htmlFor="route-status" required>
            <select
              id="route-status"
              className={m3.select}
              value={form.status}
              onChange={(event) => update({ status: event.target.value as RouteForm['status'] })}
            >
              <option value="draft">draft</option>
              <option value="active">active</option>
              {editing ? <option value="paused">paused</option> : null}
              {editing ? <option value="retired">retired</option> : null}
            </select>
          </Field>
        </div>

        <div>
          <p className={m3.label}>fallback（最多 3 个，顺序即降级顺序）</p>
          <div className={styles.fallbackList}>
            {models
              .filter((model) => model.id !== form.model_id)
              .map((model) => {
                const checked = form.fallback_ids.includes(model.id);
                return (
                  <label key={model.id} className={m3.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        if (event.target.checked) {
                          if (form.fallback_ids.length >= 3) return;
                          update({ fallback_ids: [...form.fallback_ids, model.id] });
                        } else {
                          update({ fallback_ids: form.fallback_ids.filter((id) => id !== model.id) });
                        }
                      }}
                    />
                    {model.display_name}（{model.status}）
                  </label>
                );
              })}
          </div>
        </div>

        <div className={m3.grid2}>
          <Field label="priority（1–999）" htmlFor="route-priority" required>
            <input
              id="route-priority"
              className={m3.input}
              value={form.priority}
              onChange={(event) => update({ priority: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
          <Field label="label（可选）" htmlFor="route-label">
            <input
              id="route-label"
              className={m3.input}
              value={form.label}
              onChange={(event) => update({ label: event.target.value })}
              placeholder="默认文案路由"
            />
          </Field>
          <Field label="effective_from（可选）" htmlFor="route-from">
            <input
              id="route-from"
              className={m3.input}
              type="date"
              value={form.effective_from}
              onChange={(event) => update({ effective_from: event.target.value })}
            />
          </Field>
          <Field label="effective_to（可选）" htmlFor="route-to">
            <input
              id="route-to"
              className={m3.input}
              type="date"
              value={form.effective_to}
              onChange={(event) => update({ effective_to: event.target.value })}
            />
          </Field>
        </div>

        <div>
          <p className={m3.label}>quota（留空=不限；0=禁用）</p>
          <div className={m3.grid3}>
            {[
              ['rpm', 'rpm'],
              ['tpm', 'tpm'],
              ['concurrency', '并发'],
              ['daily_calls', '日调用'],
              ['daily_cost_cents', '日成本（分）'],
              ['monthly_cost_cents', '月成本（分）'],
            ].map(([key, label]) => (
              <Field label={label} htmlFor={`route-${key}`} key={key}>
                <input
                  id={`route-${key}`}
                  className={m3.input}
                  value={form[key as keyof RouteForm] as string}
                  onChange={(event) => {
                    const value = event.target.value.replace(/\D/g, '');
                    const quotaKey = key as
                      | 'rpm'
                      | 'tpm'
                      | 'concurrency'
                      | 'daily_calls'
                      | 'daily_cost_cents'
                      | 'monthly_cost_cents';
                    update({ [quotaKey]: value } as Partial<RouteForm>);
                  }}
                  inputMode="numeric"
                />
              </Field>
            ))}
          </div>
        </div>
      </Drawer>
      {routes.length > 0 ? (
        <p className={m3.muted} style={{ marginTop: 10 }}>
          共 {routes.length} 条路由；active 路由的模型必须是 published，否则保存会返回 publish_blocked。
        </p>
      ) : null}
      {!loading && routes.length === 0 && error ? <ErrorLine message={error} /> : null}
    </PanelCard>
  );
}
