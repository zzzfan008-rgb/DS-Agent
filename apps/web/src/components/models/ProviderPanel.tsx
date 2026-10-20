'use client';

import { useEffect, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import { createProvider, fetchProviders, testProvider } from '@/lib/models-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ProviderItem } from '@/lib/m3-types';
import { formatCents } from '@/lib/format';
import { Chip, Drawer, Field, InlineAlert, Spinner } from '@/components/m3/M3Ui';
import { Connectivity, ErrorLine, PanelCard, ProviderStatus } from './model-ui';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

interface ProviderForm {
  kind: 'text' | 'image' | 'video' | 'embedding';
  name: string;
  credential_ref: string;
  base_url: string;
  vendor: string;
  auth_scheme: string;
  region: string;
  timeout_ms: string;
  max_concurrency: string;
  rpm: string;
  tpm: string;
}

const EMPTY_FORM: ProviderForm = {
  kind: 'text',
  name: '',
  credential_ref: 'mock_cred',
  base_url: '',
  vendor: 'openai_compatible',
  auth_scheme: 'bearer',
  region: '',
  timeout_ms: '60000',
  max_concurrency: '8',
  rpm: '',
  tpm: '',
};

function failureMessage(failure: ApiFailure): string {
  if (failure.status === 401) return '会话已过期';
  return `${failure.code}: ${failure.message}`;
}

export function ProviderPanel() {
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProviders()
      .then((items) => {
        if (!cancelled) setProviders(items);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(failureMessage(caught));
          return;
        }
        setError('Provider 列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  const update = (patch: Partial<ProviderForm>) => setForm((previous) => ({ ...previous, ...patch }));

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      await createProvider({
        kind: form.kind,
        name: form.name.trim(),
        credential_ref: form.credential_ref.trim(),
        ...(form.base_url.trim() ? { base_url: form.base_url.trim() } : {}),
        vendor: form.vendor as 'other',
        auth_scheme: form.auth_scheme as 'bearer',
        ...(form.region.trim() ? { region: form.region.trim() } : {}),
        timeout_ms: Number(form.timeout_ms) || 60000,
        max_concurrency: Number(form.max_concurrency) || 8,
        rate_limit: {
          ...(form.rpm ? { rpm: Number(form.rpm) } : {}),
          ...(form.tpm ? { tpm: Number(form.tpm) } : {}),
        },
      });
      setDrawerOpen(false);
      setForm(EMPTY_FORM);
      setReload((value) => value + 1);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setFormError(failureMessage(caught));
        return;
      }
      setFormError('创建 Provider 失败：网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const runTest = async (provider: ProviderItem) => {
    setTestingId(provider.id);
    setTestResults((previous) => ({ ...previous, [provider.id]: '' }));
    try {
      const result = await testProvider(provider.id);
      setTestResults((previous) => ({
        ...previous,
        [provider.id]: result.ok
          ? `连通性正常 · ${result.latency_ms}ms · probed ${result.models_probed}`
          : `测试失败 · ${result.error?.code ?? 'unknown'}`,
      }));
      setReload((value) => value + 1);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setTestResults((previous) => ({ ...previous, [provider.id]: failureMessage(caught) }));
        return;
      }
      setTestResults((previous) => ({ ...previous, [provider.id]: '测试失败：网络错误' }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <PanelCard
      title="Provider（供应商账号）"
      description="只显示凭据掩码与连通性，密钥永不返回。创建后需测试连通性；编辑 PATCH 需要 version，但列表未返回 version（G22），M3 暂不提供编辑。"
      actions={
        <button type="button" className="buttonPrimary" onClick={() => setDrawerOpen(true)}>
          新建 Provider
        </button>
      }
    >
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {loading ? <Spinner label="加载 Provider" /> : null}
      {!loading && providers.length === 0 ? (
        <div className={styles.emptyBlock}>
          <p>还没有 Provider。先接入一个供应商账号，再创建 Model。</p>
          <button type="button" className="buttonSecondary" onClick={() => setDrawerOpen(true)}>
            接入第一个供应商
          </button>
        </div>
      ) : null}
      {providers.length > 0 ? (
        <div className={m3.tableWrap}>
          <table className={m3.table}>
            <caption>Provider 列表</caption>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">类型</th>
                <th scope="col">Base URL</th>
                <th scope="col">凭据</th>
                <th scope="col">状态</th>
                <th scope="col">连通性</th>
                <th scope="col" className={m3.num}>
                  余额
                </th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((provider) => (
                <tr key={provider.id}>
                  <th scope="row">
                    <div className={styles.nameCell}>
                      <span>{provider.name}</span>
                      <span className={m3.mono}>{provider.id.slice(0, 10)}…</span>
                    </div>
                  </th>
                  <td>
                    <Chip>{provider.kind}</Chip>
                  </td>
                  <td className={m3.mono}>{provider.base_url ?? '—'}</td>
                  <td className={m3.mono}>{provider.credential_ref_masked}</td>
                  <td>
                    <ProviderStatus provider={provider} />
                  </td>
                  <td>
                    <Connectivity provider={provider} />
                  </td>
                  <td className={m3.num}>{formatCents(provider.balance_cents)}</td>
                  <td>
                    <div className={styles.actionCell}>
                      <button
                        type="button"
                        className="buttonSecondary"
                        onClick={() => void runTest(provider)}
                        disabled={testingId === provider.id}
                      >
                        {testingId === provider.id ? <Spinner label="测试中" /> : '测试连通'}
                      </button>
                    </div>
                    {testResults[provider.id] ? (
                      <p className={styles.testResult}>{testResults[provider.id]}</p>
                    ) : null}
                    {testResults[provider.id]?.startsWith('测试失败') ? (
                      <ErrorLine message={testResults[provider.id] ?? ''} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Drawer
        open={drawerOpen}
        title="新建 Provider"
        description="base_url 必须是 https（后端校验）；credential_ref 只是凭据名，不传密钥明文。"
        onClose={() => setDrawerOpen(false)}
        footer={
          <>
            <button type="button" className="buttonSecondary" onClick={() => setDrawerOpen(false)} disabled={submitting}>
              取消
            </button>
            <button type="button" className="buttonPrimary" onClick={() => void submit()} disabled={submitting}>
              {submitting ? <Spinner label="创建中" /> : '创建 Provider'}
            </button>
          </>
        }
      >
        {formError ? <InlineAlert tone="error">{formError}</InlineAlert> : null}
        <div className={m3.grid2}>
          <Field label="名称" htmlFor="provider-name" required hint="小写字母/数字/下划线，3–40 位">
            <input
              id="provider-name"
              className={m3.input}
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="mock_text"
            />
          </Field>
          <Field label="类型" htmlFor="provider-kind" required>
            <select
              id="provider-kind"
              className={m3.select}
              value={form.kind}
              onChange={(event) => update({ kind: event.target.value as ProviderForm['kind'] })}
            >
              <option value="text">text</option>
              <option value="image">image</option>
              <option value="video">video</option>
              <option value="embedding">embedding</option>
            </select>
          </Field>
          <Field label="凭据引用 credential_ref" htmlFor="provider-cred" required hint="只存名称，真值在 DSH/环境变量">
            <input
              id="provider-cred"
              className={m3.input}
              value={form.credential_ref}
              onChange={(event) => update({ credential_ref: event.target.value })}
              placeholder="mock_cred"
            />
          </Field>
          <Field label="Base URL" htmlFor="provider-base" hint="必须 https；留空不可测试">
            <input
              id="provider-base"
              className={m3.input}
              value={form.base_url}
              onChange={(event) => update({ base_url: event.target.value })}
              placeholder="https://127.0.0.1:8443"
            />
          </Field>
          <Field label="vendor" htmlFor="provider-vendor">
            <select
              id="provider-vendor"
              className={m3.select}
              value={form.vendor}
              onChange={(event) => update({ vendor: event.target.value })}
            >
              <option value="openai_compatible">openai_compatible</option>
              <option value="deepseek">deepseek</option>
              <option value="volcengine">volcengine</option>
              <option value="aliyun">aliyun</option>
              <option value="other">other</option>
            </select>
          </Field>
          <Field label="auth_scheme" htmlFor="provider-auth">
            <select
              id="provider-auth"
              className={m3.select}
              value={form.auth_scheme}
              onChange={(event) => update({ auth_scheme: event.target.value })}
            >
              <option value="bearer">bearer</option>
              <option value="header">header</option>
              <option value="query">query</option>
              <option value="ak_sk">ak_sk</option>
              <option value="none">none</option>
            </select>
          </Field>
          <Field label="timeout_ms" htmlFor="provider-timeout">
            <input
              id="provider-timeout"
              className={m3.input}
              value={form.timeout_ms}
              onChange={(event) => update({ timeout_ms: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
          <Field label="max_concurrency" htmlFor="provider-conc">
            <input
              id="provider-conc"
              className={m3.input}
              value={form.max_concurrency}
              onChange={(event) => update({ max_concurrency: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
          <Field label="rpm（可选）" htmlFor="provider-rpm">
            <input
              id="provider-rpm"
              className={m3.input}
              value={form.rpm}
              onChange={(event) => update({ rpm: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
          <Field label="tpm（可选）" htmlFor="provider-tpm">
            <input
              id="provider-tpm"
              className={m3.input}
              value={form.tpm}
              onChange={(event) => update({ tpm: event.target.value.replace(/\D/g, '') })}
              inputMode="numeric"
            />
          </Field>
        </div>
      </Drawer>
    </PanelCard>
  );
}
