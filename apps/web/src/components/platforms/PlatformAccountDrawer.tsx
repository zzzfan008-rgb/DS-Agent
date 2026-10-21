'use client';

/**
 * 新建 / 编辑平台账号抽屉（docs/13c §4.1）。
 *
 * 三条与后端契约强绑定的规则：
 * 1. **只填引用名，不填密钥**：输入框常驻说明 + "我该填什么"可展开示例；
 *    失焦做与后端 `assertCredentialRef` 同口径的预校验，命中长串就不发请求。
 * 2. **`platform` 与 `shop_id` 编辑态不可改**：PATCH 白名单里没有它们，
 *    且 shop_id 参与唯一键 (org, platform, shop_id)，改它等于换账号 —— 界面上要说清楚，否则用户当 bug。
 * 3. **`app_key` 编辑时留空 = 不修改**：列表里只有掩码，回写掩码会把真实标识覆盖掉。
 */
import { useState } from 'react';import type { ApiFailure } from '@/lib/api';
import type {
  Platform,
  PlatformAccountCreateInput,
  PlatformAccountItem,
  PlatformAccountPatchInput,
} from '@/lib/platform-types';
import { createPlatformAccount, patchPlatformAccount } from '@/lib/platforms-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import { Drawer, Field, InlineAlert, Spinner } from '@/components/m3/M3Ui';
import styles from './platforms.module.css';
import m3 from '@/components/m3/m3.module.css';

/** 与后端 `assertCredentialRef` 同口径（apps/api/src/services/platform-accounts.ts）。 */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$/;
const INLINE_SECRET_RE = /[A-Za-z0-9+/=_-]{24,}/;

const NETWORK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不填写（显示默认假设）' },
  { value: 'direct', label: '公网直连' },
  { value: 'direct_eip', label: '公网直连 + 固定出口 IP' },
  { value: 'edge', label: 'edge-proxy' },
  { value: 'manual', label: '人工 / 导入包' },
  { value: 'unknown', label: '未核验' },
];

const WHITELIST_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不填写（未核验）' },
  { value: 'required', label: '必需' },
  { value: 'none', label: '不需要' },
  { value: 'unknown', label: '未核验' },
];

/** 引用名示例（队长 13c 确认追加）：给出具体变量名，用户可直接照着配 .env。 */
interface RefExampleSet {
  app_key: string;
  app_secret: string;
  access_token: string;
  label: string;
}

const REF_EXAMPLES: Record<Platform, RefExampleSet> = {
  pdd: { app_key: 'PDD_APP_KEY', app_secret: 'PDD_APP_SECRET', access_token: 'PDD_ACCESS_TOKEN', label: '.env.pdd' },
  '1688': {
    app_key: 'ALI_APP_KEY',
    app_secret: 'ALI_APP_SECRET',
    access_token: 'ALI_ACCESS_TOKEN',
    label: '.env.1688',
  },
};

interface FormState {
  platform: Platform;
  shop_id: string;
  shop_name: string;
  app_key: string;
  app_secret_ref: string;
  access_token_ref: string;
  refresh_token_ref: string;
  token_expires_at: string;
  contract_version: string;
  network_mode: string;
  ip_whitelist: string;
  datacenter: string;
  status: '' | 'active' | 'disabled' | 'expired';
}

const EMPTY_FORM: FormState = {
  platform: 'pdd',
  shop_id: '',
  shop_name: '',
  app_key: '',
  app_secret_ref: '',
  access_token_ref: '',
  refresh_token_ref: '',
  token_expires_at: '',
  contract_version: '',
  network_mode: '',
  ip_whitelist: '',
  datacenter: '',
  status: '',
};

function refError(field: string, value: string): string | null {
  if (!value.trim()) return null;
  const trimmed = value.trim();
  if (!REF_RE.test(trimmed)) {
    return '引用名只能包含字母、数字与 _ : . / @ -，且以字母或下划线开头（例如 PDD_APP_SECRET）。';
  }
  if (INLINE_SECRET_RE.test(trimmed)) {
    return '这看起来像密钥本身（含 ≥24 位连续长串）。这里只填变量名，例如 PDD_APP_SECRET。';
  }
  return null;
}

function toIsoOrNull(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface PlatformAccountDrawerProps {
  open: boolean;
  /** null = 新建 */
  editing: PlatformAccountItem | null;
  defaultPlatform: Platform;
  onClose: () => void;
  onSaved: (item: PlatformAccountItem | null, mode: 'create' | 'edit') => void;
  /** 409 后由页面刷新列表；抽屉保持打开以保留用户输入。 */
  onRefreshAfterConflict: () => void;
}

export function PlatformAccountDrawer({
  open,
  editing,
  defaultPlatform,
  onClose,
  onSaved,
  onRefreshAfterConflict,
}: PlatformAccountDrawerProps) {
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM, platform: defaultPlatform });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [syncedFor, setSyncedFor] = useState<string>('__init__');

  // 打开/切换目标时重置表单（用 key 式同步，避免 useEffect 依赖列表陷阱）。
  const targetKey = open ? (editing ? editing.id : `new:${defaultPlatform}`) : 'closed';
  if (open && syncedFor !== targetKey) {
    setSyncedFor(targetKey);
    setFormError(null);
    setConflict(false);
    setShowExamples(false);
    setForm(
      editing
        ? {
            ...EMPTY_FORM,
            platform: (editing.platform as Platform) ?? defaultPlatform,
            shop_id: editing.shop_id ?? '',
            shop_name: editing.shop_name ?? '',
            app_key: '',
            app_secret_ref: '',
            access_token_ref: '',
            refresh_token_ref: '',
            token_expires_at: '',
            contract_version: String(editing.contract_version),
            network_mode: typeof editing.extra?.network_mode === 'string' ? editing.extra.network_mode : '',
            ip_whitelist: typeof editing.extra?.ip_whitelist === 'string' ? editing.extra.ip_whitelist : '',
            datacenter: typeof editing.extra?.datacenter === 'string' ? editing.extra.datacenter : '',
            status:
              editing.status === 'active' || editing.status === 'disabled' || editing.status === 'expired'
                ? editing.status
                : '',
          }
        : { ...EMPTY_FORM, platform: defaultPlatform },
    );
  }
  if (!open && syncedFor !== 'closed') setSyncedFor('closed');

  const update = (patch: Partial<FormState>) => setForm((previous) => ({ ...previous, ...patch }));

  const examples = REF_EXAMPLES[form.platform] ?? REF_EXAMPLES.pdd;

  const submit = async () => {
    setFormError(null);
    setConflict(false);

    // 本地预校验：不发请求就拦住"把密钥粘进引用名"。
    for (const field of ['app_secret_ref', 'access_token_ref', 'refresh_token_ref'] as const) {
      const message = refError(field, form[field]);
      if (message) {
        setFormError(`${field}：${message}`);
        return;
      }
    }
    if (!form.app_key.trim() && !editing) {
      setFormError('app_key 必填：填写平台分配的应用标识（如 PDD_APP_KEY 的值）。');
      return;
    }
    if (!form.app_secret_ref.trim() && !editing) {
      setFormError('app_secret_ref 必填：填写环境变量名（如 PDD_APP_SECRET），不是密钥本身。');
      return;
    }

    const extra: Record<string, unknown> = {};
    if (form.network_mode) extra.network_mode = form.network_mode;
    if (form.ip_whitelist) extra.ip_whitelist = form.ip_whitelist;
    if (form.datacenter.trim()) extra.datacenter = form.datacenter.trim();
    const contractVersion = form.contract_version.trim() ? Number(form.contract_version) : undefined;
    if (contractVersion !== undefined && (!Number.isInteger(contractVersion) || contractVersion < 1 || contractVersion > 99)) {
      setFormError('contract_version 必须是 1–99 的整数。');
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        const patch: PlatformAccountPatchInput = {
          ...(form.shop_name.trim() !== (editing.shop_name ?? '') ? { shop_name: form.shop_name.trim() || null } : {}),
          ...(form.app_key.trim() ? { app_key: form.app_key.trim() } : {}),
          ...(form.app_secret_ref.trim() ? { app_secret_ref: form.app_secret_ref.trim() } : {}),
          ...(form.access_token_ref.trim() ? { access_token_ref: form.access_token_ref.trim() } : {}),
          ...(form.refresh_token_ref.trim() ? { refresh_token_ref: form.refresh_token_ref.trim() } : {}),
          ...(form.token_expires_at ? { token_expires_at: toIsoOrNull(form.token_expires_at) } : {}),
          ...(contractVersion !== undefined ? { contract_version: contractVersion } : {}),
          ...(form.status ? { status: form.status } : {}),
          extra,
        };
        await patchPlatformAccount(editing.id, patch, editing.version);
        onSaved(null, 'edit');
      } else {
        const input: PlatformAccountCreateInput = {
          platform: form.platform,
          shop_id: form.shop_id.trim() || null,
          shop_name: form.shop_name.trim() || null,
          app_key: form.app_key.trim(),
          app_secret_ref: form.app_secret_ref.trim(),
          access_token_ref: form.access_token_ref.trim() || null,
          refresh_token_ref: form.refresh_token_ref.trim() || null,
          token_expires_at: toIsoOrNull(form.token_expires_at),
          ...(contractVersion !== undefined ? { contract_version: contractVersion } : {}),
          extra,
        };
        await createPlatformAccount(input);
        onSaved(null, 'create');
      }
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.status === 409) {
          if (editing) {
            setConflict(true);
            setFormError('数据已被他人修改，请刷新');
            onRefreshAfterConflict();
          } else {
            setFormError('该平台该店铺已有未归档的账号；如需重新接入，请先归档旧账号。');
          }
          return;
        }
        if (caught.status === 400) {
          setFormError(describeValidation(caught));
          return;
        }
        setFormError(`${caught.status} ${caught.code}：${caught.message}`);
        return;
      }
      setFormError(editing ? '保存失败：网络错误' : '创建失败：网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  const secretRefError = refError('app_secret_ref', form.app_secret_ref);
  const accessRefError = refError('access_token_ref', form.access_token_ref);
  const refreshRefError = refError('refresh_token_ref', form.refresh_token_ref);

  return (
    <Drawer
      open={open}
      title={editing ? `编辑平台账号 · ${editing.shop_name ?? editing.shop_id ?? '未命名账号'}` : '新建平台账号'}
      description={
        editing
          ? 'platform 与 shop_id 不可修改（shop_id 参与唯一键 org + platform + shop_id，改它等于换账号）；app_key 与引用名留空表示不修改。保存带 If-Match: version。'
          : '凭据只存引用名：这里填环境变量名，实值配在环境变量或 Vault，系统不会保存、也不会回显密钥本身。'
      }
      onClose={() => {
        if (!submitting) onClose();
      }}
      footer={
        <>
          {conflict ? (
            <button type="button" className="buttonSecondary" onClick={onClose}>
              刷新并关闭
            </button>
          ) : (
            <button type="button" className="buttonSecondary" onClick={onClose} disabled={submitting}>
              取消
            </button>
          )}
          <button type="button" className="buttonPrimary" onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Spinner label="保存中" /> : editing ? '保存' : '创建账号'}
          </button>
        </>
      }
    >
      {formError ? (
        <div data-form-error={conflict ? 'conflict' : 'other'}>
          <InlineAlert tone="error" title={conflict ? '版本冲突（409）' : undefined}>
            {formError}
          </InlineAlert>
        </div>
      ) : null}

      <div className={m3.grid2}>
        <Field
          label="平台"
          htmlFor="pa-platform"
          required
          hint={editing ? '平台不可修改：如需更换请归档后重建（PATCH 白名单不含 platform）' : undefined}
        >
          <select
            id="pa-platform"
            className={m3.select}
            value={form.platform}
            onChange={(event) => update({ platform: event.target.value as Platform })}
            disabled={Boolean(editing)}
          >
            <option value="pdd">拼多多 pdd</option>
            <option value="1688">1688</option>
          </select>
        </Field>

        <Field
          label="店铺 ID"
          htmlFor="pa-shop-id"
          hint={
            editing
              ? '不可修改：shop_id 参与唯一键 (org, platform, shop_id)，改它等于换账号'
              : '平台后台的店铺 / 商户 ID；留空表示该平台通用账号'
          }
        >
          <input
            id="pa-shop-id"
            className={m3.input}
            value={form.shop_id}
            onChange={(event) => update({ shop_id: event.target.value })}
            placeholder="1234567"
            disabled={Boolean(editing)}
          />
          {editing ? (
            <p className={styles.lockedNote}>
              不是"忘了做"：后端 PATCH 白名单没有此字段，因为改它等于把账号指向另一家店。
            </p>
          ) : null}
        </Field>

        <Field label="店铺名称" htmlFor="pa-shop-name">
          <input
            id="pa-shop-name"
            className={m3.input}
            value={form.shop_name}
            onChange={(event) => update({ shop_name: event.target.value })}
            placeholder="旗舰店 A"
          />
        </Field>

        <Field
          label="app_key"
          htmlFor="pa-app-key"
          required={!editing}
          hint={editing ? '留空不修改（列表里只有掩码，回写掩码会覆盖真实标识）' : '平台分配的应用标识，这里是值不是变量名'}
        >
          <input
            id="pa-app-key"
            className={m3.input}
            value={form.app_key}
            onChange={(event) => update({ app_key: event.target.value })}
            placeholder={editing ? '留空不修改' : '1234567890abcdef'}
            autoComplete="off"
          />
        </Field>

        <Field
          label="app_secret_ref（引用名）"
          htmlFor="pa-app-secret-ref"
          required={!editing}
          error={secretRefError}
        >
          <input
            id="pa-app-secret-ref"
            className={m3.input}
            value={form.app_secret_ref}
            onChange={(event) => update({ app_secret_ref: event.target.value })}
            placeholder={editing ? '留空不修改' : 'PDD_APP_SECRET'}
            autoComplete="off"
            spellCheck={false}
            data-field="app_secret_ref"
          />
          <p className={styles.refHint}>
            ⓘ 这里填环境变量名（如 {examples.app_secret}），<strong>不要填密钥本身</strong>。
          </p>
          <button type="button" className={styles.exampleToggle} onClick={() => setShowExamples((value) => !value)}>
            {showExamples ? '收起示例' : '我该填什么？看示例'}
          </button>
          {showExamples ? (
            <div className={styles.refExample} data-ref-example>
              <p className={styles.refExampleTitle}>{examples.label}（示意，不要把真实密钥提交进仓库）</p>
              <div>
                <code>{examples.app_key}=&lt;平台分配的应用标识&gt;</code>
                <span className={styles.muted}> — 本页 app_key 直接填这个值</span>
              </div>
              <div>
                <code>{examples.app_secret}=&lt;真实密钥&gt;</code>
                <span className={styles.muted}> — 配在环境变量；本页 app_secret_ref 只填左边这个名字</span>
              </div>
              <div>
                <code>{examples.access_token}=&lt;店铺授权 token&gt;</code>
                <span className={styles.muted}> — 同上；本页 access_token_ref 只填这个名字</span>
              </div>
              <p className={styles.refExampleTitle} style={{ marginTop: 6 }}>
                本页三个输入框分别填：<code>{examples.app_key}</code> 的值 / <code>{examples.app_secret}</code> /{' '}
                <code>{examples.access_token}</code>
              </p>
            </div>
          ) : null}
        </Field>

        <Field label="access_token_ref（引用名，可选）" htmlFor="pa-access-ref" error={accessRefError}>
          <input
            id="pa-access-ref"
            className={m3.input}
            value={form.access_token_ref}
            onChange={(event) => update({ access_token_ref: event.target.value })}
            placeholder={editing ? '留空不修改' : examples.access_token}
            autoComplete="off"
            spellCheck={false}
            data-field="access_token_ref"
          />
        </Field>

        <Field
          label="refresh_token_ref（引用名，可选）"
          htmlFor="pa-refresh-ref"
          error={refreshRefError}
          hint="token 轮换由外部进程完成；系统只记录变量名"
        >
          <input
            id="pa-refresh-ref"
            className={m3.input}
            value={form.refresh_token_ref}
            onChange={(event) => update({ refresh_token_ref: event.target.value })}
            placeholder={editing ? '留空不修改' : 'PDD_REFRESH_TOKEN'}
            autoComplete="off"
            spellCheck={false}
            data-field="refresh_token_ref"
          />
        </Field>

        <Field label="token 过期时间（可选）" htmlFor="pa-token-exp">
          <input
            id="pa-token-exp"
            type="datetime-local"
            className={m3.input}
            value={form.token_expires_at}
            onChange={(event) => update({ token_expires_at: event.target.value })}
          />
        </Field>

        <Field label="contract_version" htmlFor="pa-contract" hint="契约版本 1–99，默认 2">
          <input
            id="pa-contract"
            className={m3.input}
            value={form.contract_version}
            onChange={(event) => update({ contract_version: event.target.value.replace(/\D/g, '') })}
            inputMode="numeric"
            placeholder="2"
          />
        </Field>

        {editing ? (
          <Field label="status" htmlFor="pa-status" hint="不选则保持不变">
            <select
              id="pa-status"
              className={m3.select}
              value={form.status}
              onChange={(event) => update({ status: event.target.value as FormState['status'] })}
            >
              <option value="">不修改</option>
              <option value="active">active 启用</option>
              <option value="disabled">disabled 停用</option>
              <option value="expired">expired 已过期</option>
            </select>
          </Field>
        ) : null}
      </div>

      <p className={styles.refExampleTitle} style={{ marginTop: 14 }}>
        部署约束（写入 extra；不填则界面显示"默认假设"，因为 docs/03 逐接口表尚未回填）
      </p>
      <div className={m3.grid2}>
        <Field label="网络模式" htmlFor="pa-network" hint="取最严格：edge > 白名单 > 直连">
          <select
            id="pa-network"
            className={m3.select}
            value={form.network_mode}
            onChange={(event) => update({ network_mode: event.target.value })}
          >
            {NETWORK_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="IP 白名单" htmlFor="pa-whitelist">
          <select
            id="pa-whitelist"
            className={m3.select}
            value={form.ip_whitelist}
            onChange={(event) => update({ ip_whitelist: event.target.value })}
          >
            {WHITELIST_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="指定机房（可选）" htmlFor="pa-datacenter">
          <input
            id="pa-datacenter"
            className={m3.input}
            value={form.datacenter}
            onChange={(event) => update({ datacenter: event.target.value })}
            placeholder="留空 = 未核验"
          />
        </Field>
      </div>
    </Drawer>
  );
}

/** 400：原样回显服务端的可执行提示（"请传引用名，实值配在环境变量或 Vault"）。 */
function describeValidation(failure: ApiFailure): string {
  const detail = failure.detail;
  const expected = detail && typeof detail.expected === 'string' ? detail.expected : null;
  const hint = detail && typeof detail.hint === 'string' ? detail.hint : null;
  const base = failure.message;
  if (expected || hint) return `${base}（期望：${expected ?? '引用名'}${hint ? `；${hint}` : ''}）`;
  return base;
}
