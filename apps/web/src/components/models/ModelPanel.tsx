'use client';

import { useEffect, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import {
  createModel,
  fetchModels,
  fetchProviders,
  publishModel,
  suspendModel,
  testModel,
  updateModel,
  type ModelCreateInput,
  type ModelUpdateInput,
} from '@/lib/models-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ModelItem, PriceBook, ProviderItem } from '@/lib/m3-types';
import { CAPABILITY_LABEL, PURPOSE_LABEL, priceText } from '@/lib/m3-format';
import { formatDate } from '@/lib/format';
import { Chip, Drawer, Field, InlineAlert, Spinner } from '@/components/m3/M3Ui';
import { ErrorLine, ModelStatus, PanelCard, PriceTag } from './model-ui';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

type Capability = ModelItem['capability'];

const CAPABILITIES: Capability[] = ['text', 'image', 'video', 'embedding', 'rerank'];
const PURPOSES = ['copy', 'judge', 'image', 'video', 'embed', 'rerank'] as const;

const DEFAULT_PURPOSES: Record<Capability, string[]> = {
  text: ['copy', 'judge'],
  image: ['image'],
  video: ['video'],
  embedding: ['embed'],
  rerank: ['rerank'],
};

interface ModelForm {
  provider_id: string;
  external_model_id: string;
  display_name: string;
  capability: Capability;
  purposes: string[];
  params_schema: string;
  default_params: string;
  input_per_1k: string;
  output_per_1k: string;
  per_image: string;
  per_megapixel: string;
  per_second: string;
  per_1k_embed: string;
  rpm: string;
  tpm: string;
  context_tokens: string;
  max_output_tokens: string;
  embed_dim: string;
}

const EMPTY_FORM: ModelForm = {
  provider_id: '',
  external_model_id: '',
  display_name: '',
  capability: 'text',
  purposes: ['copy', 'judge'],
  params_schema: '{\n  "type": "object",\n  "properties": {}\n}',
  default_params: '{}',
  input_per_1k: '10',
  output_per_1k: '20',
  per_image: '',
  per_megapixel: '',
  per_second: '',
  per_1k_embed: '',
  rpm: '',
  tpm: '',
  context_tokens: '32000',
  max_output_tokens: '4096',
  embed_dim: '',
};

function errorMessage(failure: ApiFailure): string {
  return `${failure.code}: ${failure.message}`;
}

function buildPrice(form: ModelForm): PriceBook {
  if (form.capability === 'text' || form.capability === 'rerank') {
    return {
      text: {
        ...(form.input_per_1k ? { input_per_1k_cents: Number(form.input_per_1k) } : {}),
        ...(form.output_per_1k ? { output_per_1k_cents: Number(form.output_per_1k) } : {}),
      },
    };
  }
  if (form.capability === 'image') {
    return {
      image: {
        ...(form.per_image ? { per_image_cents: Number(form.per_image) } : {}),
        ...(form.per_megapixel ? { per_megapixel_cents: Number(form.per_megapixel) } : {}),
      },
    };
  }
  if (form.capability === 'video') {
    return { video: { ...(form.per_second ? { per_second_cents: Number(form.per_second) } : {}) } };
  }
  return { embed: { ...(form.per_1k_embed ? { per_1k_tokens_cents: Number(form.per_1k_embed) } : {}) } };
}

export function ModelPanel({ onChanged }: { onChanged?: () => void }) {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ModelItem | null>(null);
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [testMessages, setTestMessages] = useState<Record<string, string>>({});
  const [publishMissing, setPublishMissing] = useState<{ model: string; missing: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchModels({ limit: 100 }), fetchProviders()])
      .then(([modelItems, providerItems]) => {
        if (cancelled) return;
        setModels(modelItems);
        setProviders(providerItems);
        if (!form.provider_id && providerItems[0]) {
          setForm((previous) => ({ ...previous, provider_id: providerItems[0]!.id }));
        }
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(errorMessage(caught));
          return;
        }
        setError('Model 列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const providerName = (id: string): string =>
    providers.find((provider) => provider.id === id)?.name ?? `${id.slice(0, 8)}…`;

  const update = (patch: Partial<ModelForm>) => setForm((previous) => ({ ...previous, ...patch }));

  const openCreate = () => {
    setEditing(null);
    setForm((previous) => ({ ...EMPTY_FORM, provider_id: previous.provider_id || providers[0]?.id || '' }));
    setFormError(null);
    setDrawerOpen(true);
  };

  const openEdit = (model: ModelItem) => {
    setEditing(model);
    setForm({
      ...EMPTY_FORM,
      provider_id: model.provider_id,
      external_model_id: model.external_model_id,
      display_name: model.display_name,
      capability: model.capability,
      purposes: [],
      params_schema: '',
      default_params: '',
      context_tokens: '',
      max_output_tokens: '',
      embed_dim: '',
      input_per_1k: model.price.text?.input_per_1k_cents?.toString() ?? '',
      output_per_1k: model.price.text?.output_per_1k_cents?.toString() ?? '',
      per_image: model.price.image?.per_image_cents?.toString() ?? '',
      per_megapixel: model.price.image?.per_megapixel_cents?.toString() ?? '',
      per_second: model.price.video?.per_second_cents?.toString() ?? '',
      per_1k_embed: model.price.embed?.per_1k_tokens_cents?.toString() ?? '',
      rpm: model.rate_limit?.rpm ? String(model.rate_limit.rpm) : '',
      tpm: model.rate_limit?.tpm ? String(model.rate_limit.tpm) : '',
    });
    setFormError(null);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditing(null);
    setFormError(null);
  };

  const changeCapability = (capability: Capability) => {
    setForm((previous) => ({
      ...previous,
      capability,
      purposes: DEFAULT_PURPOSES[capability],
    }));
  };

  const submit = async () => {
    setFormError(null);
    const isEdit = editing !== null;
    let paramsSchema: Record<string, unknown> | undefined;
    let defaultParams: Record<string, unknown> | undefined;
    if (!isEdit || form.params_schema.trim()) {
      try {
        paramsSchema = JSON.parse(form.params_schema) as Record<string, unknown>;
      } catch {
        setFormError('params_schema 不是合法 JSON');
        return;
      }
    }
    if (!isEdit || form.default_params.trim()) {
      try {
        defaultParams = JSON.parse(form.default_params) as Record<string, unknown>;
      } catch {
        setFormError('default_params 不是合法 JSON');
        return;
      }
    }
    if (!isEdit) {
      if (!form.provider_id) {
        setFormError('请选择 Provider');
        return;
      }
      if (!form.external_model_id.trim()) {
        setFormError('external_model_id 必填');
        return;
      }
      if (form.purposes.length === 0) {
        setFormError('至少选择一个 purpose');
        return;
      }
    }
    if (!form.display_name.trim()) {
      setFormError('display_name 必填');
      return;
    }
    const price = buildPrice(form);
    const priceIsEmpty =
      (price.text && !price.text.input_per_1k_cents && !price.text.output_per_1k_cents) ||
      (price.image && !price.image.per_image_cents && !price.image.per_megapixel_cents) ||
      (price.video && !price.video.per_second_cents) ||
      (price.embed && !price.embed.per_1k_tokens_cents);
    if (priceIsEmpty) {
      setFormError('价格必填（整数分）；按能力填写对应段');
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        const input: ModelUpdateInput = {
          display_name: form.display_name.trim(),
          price,
          rate_limit: {
            ...(form.rpm ? { rpm: Number(form.rpm) } : {}),
            ...(form.tpm ? { tpm: Number(form.tpm) } : {}),
          },
          ...(paramsSchema ? { params_schema: paramsSchema } : {}),
          ...(defaultParams ? { default_params: defaultParams } : {}),
        };
        await updateModel(editing.id, input, editing.version);
      } else {
        const input: ModelCreateInput = {
          provider_id: form.provider_id,
          external_model_id: form.external_model_id.trim(),
          display_name: form.display_name.trim(),
          capability: form.capability,
          purpose_support: form.purposes,
          params_schema: paramsSchema ?? {},
          default_params: defaultParams ?? {},
          price,
          rate_limit: {
            ...(form.rpm ? { rpm: Number(form.rpm) } : {}),
            ...(form.tpm ? { tpm: Number(form.tpm) } : {}),
          },
          ...(form.context_tokens ? { context_tokens: Number(form.context_tokens) } : {}),
          ...(form.max_output_tokens ? { max_output_tokens: Number(form.max_output_tokens) } : {}),
          ...(form.embed_dim ? { embed_dim: Number(form.embed_dim) } : {}),
        };
        await createModel(input);
      }
      closeDrawer();
      setForm((previous) => ({ ...EMPTY_FORM, provider_id: previous.provider_id }));
      setReload((value) => value + 1);
      onChanged?.();
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.status === 409) {
          setFormError('版本冲突（409）：模型已被其他操作更新，请关闭后刷新再改。');
          return;
        }
        setFormError(errorMessage(caught));
        return;
      }
      setFormError(editing ? '保存 Model 失败：网络错误' : '创建 Model 失败：网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const act = async (model: ModelItem, action: 'test' | 'publish' | 'suspend') => {
    if (action === 'suspend' && !window.confirm(`确认停用模型「${model.display_name}」？前台将立即不可用。`)) {
      return;
    }
    setBusy(`${model.id}:${action}`);
    setRowErrors((previous) => ({ ...previous, [model.id]: '' }));
    setPublishMissing(null);
    try {
      if (action === 'test') {
        const result = await testModel(model.id);
        setTestMessages((previous) => ({
          ...previous,
          [model.id]: result.ok ? `测试通过 · ${result.latency_ms}ms` : `测试失败 · ${result.error?.code ?? 'unknown'}`,
        }));
      } else if (action === 'publish') {
        const result = await publishModel(model.id);
        setTestMessages((previous) => ({ ...previous, [model.id]: `已发布 · ${result.published_at ?? ''}` }));
      } else {
        await suspendModel(model.id);
        setTestMessages((previous) => ({ ...previous, [model.id]: '已停用' }));
      }
      setReload((value) => value + 1);
      onChanged?.();
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.code === 'publish_blocked') {
          const missing = caught.detail?.missing;
          setPublishMissing({
            model: model.display_name,
            missing: Array.isArray(missing) ? missing.map(String) : [caught.message],
          });
        }
        setRowErrors((previous) => ({ ...previous, [model.id]: errorMessage(caught) }));
        return;
      }
      setRowErrors((previous) => ({ ...previous, [model.id]: '操作失败：网络错误' }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <PanelCard
      title="Model（模型与参数价格）"
      description="发布守卫需要：24h 内测试成功、Provider active+ok、凭据 active、params_schema/price 合法。列表已返回 version，可编辑展示名/参数 schema/默认参数/价格/限流（If-Match，冲突 409）。"
      actions={
        <button type="button" className="buttonPrimary" onClick={openCreate}>
          新建 Model
        </button>
      }
    >
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {publishMissing ? (
        <InlineAlert tone="warning" title={`发布被阻断：${publishMissing.model}`}>
          <ul className={styles.missingList}>
            {publishMissing.missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}
      {loading ? <Spinner label="加载 Model" /> : null}
      {!loading && models.length === 0 ? (
        <div className={styles.emptyBlock}>
          <p>还没有 Model。先在 Provider 建好凭据，再新建模型并测试→发布。</p>
          <button type="button" className="buttonSecondary" onClick={openCreate}>
            新建第一个 Model
          </button>
        </div>
      ) : null}
      {models.length > 0 ? (
        <div className={m3.tableWrap}>
          <table className={m3.table}>
            <caption>Model 列表</caption>
            <thead>
              <tr>
                <th scope="col">展示名 / external</th>
                <th scope="col">Provider</th>
                <th scope="col">能力</th>
                <th scope="col">状态</th>
                <th scope="col">价格（分/单位）</th>
                <th scope="col">发布/可见</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.id}>
                  <th scope="row">
                    <div className={styles.nameCell}>
                      <span>{model.display_name}</span>
                      <span className={m3.mono}>
                        {model.external_model_id} · v{model.version}
                      </span>
                    </div>
                  </th>
                  <td>{providerName(model.provider_id)}</td>
                  <td>
                    <Chip tone="info">{CAPABILITY_LABEL[model.capability] ?? model.capability}</Chip>
                  </td>
                  <td>
                    <ModelStatus model={model} />
                  </td>
                  <td>
                    <PriceTag price={model.price} capability={model.capability} />
                    <p className={m3.muted}>price_version {model.price_version}</p>
                  </td>
                  <td>
                    <div className={styles.actionCell}>
                      {model.published_at ? <span className={m3.muted}>发布 {formatDate(model.published_at)}</span> : <span className={m3.muted}>未发布</span>}
                      {model.visible ? <Chip tone="success">前台可见</Chip> : <Chip tone="neutral">不可见</Chip>}
                      {!model.visible && model.visible_reason ? (
                        <span className={m3.muted}>原因：{model.visible_reason}</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <div className={styles.actionCell}>
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => void act(model, 'test')}
                        disabled={busy === `${model.id}:test`}
                      >
                        {busy === `${model.id}:test` ? <Spinner label="测试中" /> : '测试'}
                      </button>
                      <button type="button" className="buttonQuiet" onClick={() => openEdit(model)}>
                        编辑
                      </button>
                      {model.status === 'published' ? (
                        <button
                          type="button"
                          className="buttonSecondary"
                          onClick={() => void act(model, 'suspend')}
                          disabled={busy === `${model.id}:suspend`}
                        >
                          停用
                        </button>
                      ) : model.status !== 'archived' ? (
                        <button
                          type="button"
                          className="buttonPrimary"
                          onClick={() => void act(model, 'publish')}
                          disabled={busy === `${model.id}:publish`}
                        >
                          {busy === `${model.id}:publish` ? <Spinner label="发布中" /> : '发布'}
                        </button>
                      ) : null}
                    </div>
                    {testMessages[model.id] ? <p className={styles.testResult}>{testMessages[model.id]}</p> : null}
                    {rowErrors[model.id] ? <ErrorLine message={rowErrors[model.id] ?? ''} /> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Drawer
        open={drawerOpen}
        title={editing ? `编辑 Model · ${editing.display_name}` : '新建 Model'}
        description={
          editing
            ? '只可改展示名/参数 schema/默认参数/价格/限流；provider/external/capability/purpose 不可改。schema 留空保持不变；保存用 If-Match version。'
            : 'params_schema 会经 meta-schema 校验；text/rerank 必须填 context_tokens，embedding 必须填 embed_dim。'
        }
        onClose={closeDrawer}
        width={640}
        footer={
          <>
            <button type="button" className="buttonSecondary" onClick={closeDrawer} disabled={submitting}>
              取消
            </button>
            <button type="button" className="buttonPrimary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <Spinner label="保存中" /> : editing ? '保存 Model' : '创建 Model'}
            </button>
          </>
        }
      >
        {formError ? <InlineAlert tone="error">{formError}</InlineAlert> : null}
        <div className={m3.grid2}>
          <Field label="Provider" htmlFor="model-provider" required>
            <select
              id="model-provider"
              className={m3.select}
              value={form.provider_id}
              onChange={(event) => update({ provider_id: event.target.value })}
              disabled={Boolean(editing)}
            >
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}（{provider.kind} · {provider.status}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="能力 capability" htmlFor="model-capability" required>
            <select
              id="model-capability"
              className={m3.select}
              value={form.capability}
              onChange={(event) => changeCapability(event.target.value as Capability)}
              disabled={Boolean(editing)}
            >
              {CAPABILITIES.map((capability) => (
                <option key={capability} value={capability}>
                  {CAPABILITY_LABEL[capability] ?? capability}
                </option>
              ))}
            </select>
          </Field>
          <Field label="external_model_id" htmlFor="model-external" required hint="供应商侧模型 ID">
            <input
              id="model-external"
              className={m3.input}
              value={form.external_model_id}
              onChange={(event) => update({ external_model_id: event.target.value })}
              placeholder="deepseek-chat"
              disabled={Boolean(editing)}
            />
          </Field>
          <Field label="展示名 display_name" htmlFor="model-display" required>
            <input
              id="model-display"
              className={m3.input}
              value={form.display_name}
              onChange={(event) => update({ display_name: event.target.value })}
              placeholder="深度求索 V3"
            />
          </Field>
        </div>

        {!editing ? (
          <div>
            <p className={m3.label}>purpose_support *</p>
            <div className={styles.checkboxGrid}>
              {PURPOSES.map((purpose) => (
                <label key={purpose} className={m3.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={form.purposes.includes(purpose)}
                    onChange={(event) =>
                      update({
                        purposes: event.target.checked
                          ? [...form.purposes, purpose]
                          : form.purposes.filter((item) => item !== purpose),
                      })
                    }
                  />
                  {PURPOSE_LABEL[purpose] ?? purpose}
                </label>
              ))}
            </div>
          </div>
        ) : (
          <p className={m3.muted}>purpose_support 不可修改；如用途需调整，请新建模型并迁移路由。</p>
        )}

        <Field
          label="params_schema（JSON）"
          htmlFor="model-schema"
          required={!editing}
          hint={editing ? '留空保持不变；如需修改请粘贴完整 schema' : '必须能通过 meta-schema 与 default_params 校验'}
        >
          <textarea
            id="model-schema"
            className={`${m3.textarea} ${styles.jsonArea}`}
            value={form.params_schema}
            onChange={(event) => update({ params_schema: event.target.value })}
            spellCheck={false}
            placeholder={editing ? '留空不修改' : undefined}
          />
        </Field>
        <Field label="default_params（JSON）" htmlFor="model-defaults" hint={editing ? '留空保持不变' : undefined}>
          <textarea
            id="model-defaults"
            className={`${m3.textarea} ${styles.jsonArea}`}
            value={form.default_params}
            onChange={(event) => update({ default_params: event.target.value })}
            spellCheck={false}
            placeholder={editing ? '留空不修改' : undefined}
          />
        </Field>

        <div className={m3.grid3}>
          {form.capability === 'text' || form.capability === 'rerank' ? (
            <>
              <Field label="输入（分/千 token）" htmlFor="price-input" required>
                <input
                  id="price-input"
                  className={m3.input}
                  value={form.input_per_1k}
                  onChange={(event) => update({ input_per_1k: event.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="输出（分/千 token）" htmlFor="price-output" required>
                <input
                  id="price-output"
                  className={m3.input}
                  value={form.output_per_1k}
                  onChange={(event) => update({ output_per_1k: event.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                />
              </Field>
            </>
          ) : null}
          {form.capability === 'image' ? (
            <>
              <Field label="按张（分/张）" htmlFor="price-image">
                <input
                  id="price-image"
                  className={m3.input}
                  value={form.per_image}
                  onChange={(event) => update({ per_image: event.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                />
              </Field>
              <Field label="按像素（分/百万像素）" htmlFor="price-mp">
                <input
                  id="price-mp"
                  className={m3.input}
                  value={form.per_megapixel}
                  onChange={(event) => update({ per_megapixel: event.target.value.replace(/\D/g, '') })}
                  inputMode="numeric"
                />
              </Field>
            </>
          ) : null}
          {form.capability === 'video' ? (
            <Field label="按秒（分/秒）" htmlFor="price-second" required>
              <input
                id="price-second"
                className={m3.input}
                value={form.per_second}
                onChange={(event) => update({ per_second: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
              />
            </Field>
          ) : null}
          {form.capability === 'embedding' ? (
            <Field label="嵌入（分/千 token）" htmlFor="price-embed" required>
              <input
                id="price-embed"
                className={m3.input}
                value={form.per_1k_embed}
                onChange={(event) => update({ per_1k_embed: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
              />
            </Field>
          ) : null}
          <Field label="rpm" htmlFor="model-rpm">
            <input
              id="model-rpm"
              className={m3.input}
              value={form.rpm}
              onChange={(event) => update({ rpm: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
          <Field label="tpm" htmlFor="model-tpm">
            <input
              id="model-tpm"
              className={m3.input}
              value={form.tpm}
              onChange={(event) => update({ tpm: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
        </div>

        {!editing ? (
          <div className={m3.grid3}>
            <Field
              label="context_tokens"
              htmlFor="model-context"
              required={form.capability === 'text' || form.capability === 'rerank'}
            >
              <input
                id="model-context"
                className={m3.input}
                value={form.context_tokens}
                onChange={(event) => update({ context_tokens: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
              />
            </Field>
            <Field label="max_output_tokens" htmlFor="model-max">
              <input
                id="model-max"
                className={m3.input}
                value={form.max_output_tokens}
                onChange={(event) => update({ max_output_tokens: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
              />
            </Field>
            <Field
              label="embed_dim"
              htmlFor="model-embed-dim"
              required={form.capability === 'embedding'}
            >
              <input
                id="model-embed-dim"
                className={m3.input}
                value={form.embed_dim}
                onChange={(event) => update({ embed_dim: event.target.value.replace(/\D/g, '') })}
                inputMode="numeric"
              />
            </Field>
          </div>
        ) : null}

        <p className={m3.muted}>
          当前价格预览：{priceText(buildPrice(form), form.capability)}
        </p>
      </Drawer>
    </PanelCard>
  );
}
