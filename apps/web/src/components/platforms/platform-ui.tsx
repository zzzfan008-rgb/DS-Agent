'use client';

/**
 * 平台连接页的状态件（docs/13c §3.2 / §4.2 / §4.3）。
 *
 * 这里承担本页最关键的诚实性约束：连通性与"最近错误"的视觉必须与后端
 * `connectivity` / `last_test_error` 一致，任何情况下不得比数据库更乐观。
 * 样式复用 M3 的 Chip（`m3.module.css`），只新增本页布局类。
 */
import type { ReactNode } from 'react';
import { Chip } from '@/components/m3/M3Ui';
import type {
  Connectivity,
  DeploymentConstraint,
  PlatformAccountItem,
  TestConnectivityResult,
} from '@/lib/platform-types';
import styles from './platforms.module.css';

export const PLATFORM_LABEL: Record<string, string> = {
  pdd: '拼多多 PDD',
  '1688': '1688',
};

export const PLATFORM_SHORT: Record<string, string> = {
  pdd: '拼多多',
  '1688': '1688',
};

const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  active: { label: '启用', tone: 'success' },
  disabled: { label: '已停用', tone: 'neutral' },
  expired: { label: '已过期', tone: 'danger' },
};

const CONNECTIVITY_META: Record<string, { label: string; dot: string | undefined }> = {
  unknown: { label: '未测试', dot: styles.connUnknown },
  ok: { label: 'ok', dot: styles.connOk },
  auth_invalid: { label: '鉴权失败', dot: styles.connBad },
  upstream_5xx: { label: '平台 5xx', dot: styles.connBad },
  unreachable: { label: '不可达', dot: styles.connBad },
};

/** `MM-DD HH:mm`（本地时区）；null / 非法值显示 `—`。 */
export function formatStamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function displayName(item: PlatformAccountItem): string {
  if (item.shop_name && item.shop_name.trim()) return item.shop_name;
  if (item.shop_id && item.shop_id.trim()) return item.shop_id;
  return '未命名账号';
}

/** 授权状态徽标：颜色 + 中文 + 原始枚举值（三重编码，不只靠颜色）。 */
export function StatusChip({ status }: { status: string }) {
  const meta = STATUS_LABEL[status];
  return (
    <Chip tone={meta?.tone ?? 'neutral'} title={`status=${status}`}>
      {meta ? `${meta.label} · ${status}` : status}
    </Chip>
  );
}

export function ConnectivityDot({ connectivity }: { connectivity: Connectivity | string }) {
  const meta = CONNECTIVITY_META[connectivity] ?? { label: String(connectivity), dot: styles.connUnknown };
  return (
    <span className={styles.conn} aria-label={`连通性 ${meta.label}（${connectivity}）`}>
      <span className={`${styles.connDot} ${meta.dot}`} aria-hidden="true" />
      <span>{meta.label}</span>
      <span className={styles.muted}>({connectivity})</span>
    </span>
  );
}

/**
 * 部署约束：extra 缺键时显示"公网直连（默认假设）· IP 白名单 未核验 · 机房 未核验"。
 * 明确标注是假设 —— 用户看到"公网直连"会以为系统查过了（docs/03 §0：未核实前按最严格假设设计）。
 */
export function describeDeployment(extra: Record<string, unknown> | null): DeploymentConstraint {
  const source = extra ?? {};
  const networkRaw = typeof source.network_mode === 'string' ? source.network_mode : null;
  const whitelistRaw = typeof source.ip_whitelist === 'string' ? source.ip_whitelist : null;
  const datacenterRaw =
    typeof source.datacenter === 'string' && source.datacenter.trim() ? source.datacenter : null;
  const knownKeys = new Set(['network_mode', 'ip_whitelist', 'datacenter']);
  const otherKeys = Object.keys(source).filter((key) => !knownKeys.has(key)).length;

  const NETWORK_LABEL: Record<string, string> = {
    direct: '公网直连',
    direct_eip: '公网直连 + 固定出口 IP',
    edge: 'edge-proxy',
    manual: '人工 / 导入包',
    unknown: '未核验',
  };
  const WHITELIST_LABEL: Record<string, string> = {
    required: '必需',
    none: '不需要',
    unknown: '未核验',
  };

  return {
    network_mode: networkRaw ? (NETWORK_LABEL[networkRaw] ?? networkRaw) : '公网直连（默认假设）',
    ip_whitelist: whitelistRaw ? (WHITELIST_LABEL[whitelistRaw] ?? whitelistRaw) : '未核验',
    datacenter: datacenterRaw ?? '未核验',
    assumed: networkRaw === null || whitelistRaw === null,
    otherKeys,
  };
}

export type ResultTone = 'ok' | 'warn' | 'error' | 'info';

export interface ResultBarModel {
  tone: ResultTone;
  title: string;
  text: string;
  /** 时间戳：让用户分清"刚才点的"还是"上周的"。 */
  meta?: string;
}

/**
 * 把测试连通结果翻成结果条（docs/13c §4.2）。
 *
 * 关键：`interfaces_unverified` → **黄色 warn**，标题必须说"无法发起真实请求"，
 * 不许出现"测试完成/成功"。`ok:false` 也不走红色 —— 红色只留给 HTTP 层失败与真实鉴权/网络错误。
 */
export function describeTestResult(result: TestConnectivityResult): ResultBarModel {
  const stamp = `测试时间 ${formatStamp(result.tested_at)}`;
  if (result.ok) {
    return { tone: 'ok', title: '连通正常', text: result.message || '平台响应正常', meta: stamp };
  }
  if (result.reason === 'interfaces_unverified') {
    return {
      tone: 'warn',
      title: '无法发起真实请求：平台接口 method 尚未核验',
      text: `${result.message}。这不是凭据错误，也不代表连通成功。`,
      meta: `${stamp} · reason=${result.reason}`,
    };
  }
  if (result.reason === 'probe_not_implemented') {
    return {
      tone: 'warn',
      title: '探针尚未接入该平台',
      text: `${result.message}。接口已核验，但连通性探针还没实现。`,
      meta: `${stamp} · reason=${result.reason}`,
    };
  }
  if (result.connectivity === 'auth_invalid') {
    return {
      tone: 'error',
      title: '鉴权失败',
      text: '请检查 app_key 与凭据引用名指向的值是否匹配（引用名本身不是密钥），以及 token 是否过期。',
      meta: stamp,
    };
  }
  if (result.connectivity === 'unreachable' || result.connectivity === 'upstream_5xx') {
    return {
      tone: 'error',
      title: result.connectivity === 'unreachable' ? '无法连接平台' : '平台返回 5xx',
      text: '请检查出口 IP / 网络模式与平台白名单要求；平台侧异常时稍后重试。',
      meta: stamp,
    };
  }
  return { tone: 'info', title: '未得出连通结论', text: result.message || '结果未知，请重试。', meta: stamp };
}

export function TestResultBar({ model, onClose }: { model: ResultBarModel; onClose: () => void }) {
  const toneClass =
    model.tone === 'ok'
      ? styles.resultOk
      : model.tone === 'warn'
        ? styles.resultWarn
        : model.tone === 'error'
          ? styles.resultError
          : styles.resultInfo;
  const glyph = model.tone === 'warn' ? '⚠' : model.tone === 'ok' ? '✓' : model.tone === 'error' ? '✕' : 'ⓘ';
  return (
    <div
      className={`${styles.resultBar} ${toneClass}`}
      role={model.tone === 'error' ? 'alert' : 'status'}
      data-tone={model.tone}
    >
      <span aria-hidden="true">{glyph}</span>
      <div className={styles.resultBody}>
        <p className={styles.resultTitle}>{model.title}</p>
        <p className={styles.resultText}>{model.text}</p>
        {model.meta ? <p className={styles.resultMeta}>{model.meta}</p> : null}
      </div>
      <button type="button" className={styles.resultClose} onClick={onClose} aria-label="关闭测试结果">
        ×
      </button>
    </div>
  );
}

/** 最近错误行：来自库里的 `last_test_error`，刷新后仍在（"试过了、还是不通"长期可见）。 */
export function LastErrorLine({ item }: { item: PlatformAccountItem }) {
  if (!item.last_test_error) return null;
  const isUnverified = item.last_test_error.startsWith('interfaces_unverified');
  return (
    <div
      className={`${styles.lastError} ${isUnverified ? styles.lastErrorWarn : ''}`}
      title={item.last_test_error}
      data-kind={isUnverified ? 'interfaces_unverified' : 'other'}
    >
      <div className={styles.lastErrorHead}>
        <span>最近错误（库里保留）</span>
        <span>上次测试 {formatStamp(item.last_tested_at)}</span>
      </div>
      <div className={styles.clamp1}>{item.last_test_error}</div>
    </div>
  );
}

/** ③④⑤ 三个"数据源未接入"区块：说事实、给计划、指路，不写"暂无xx"。 */
export function UnavailableBlock({
  headline,
  plan,
  hint,
  extra,
}: {
  headline: string;
  plan: string;
  hint?: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className={styles.unavailable} role="status">
      <p className={styles.unavailableTitle}>
        <span aria-hidden="true">ⓘ</span>
        {headline}
      </p>
      <p className={styles.unavailablePlan}>计划展示：{plan}</p>
      {hint ? <p className={styles.unavailableHint}>{hint}</p> : null}
      {extra}
    </div>
  );
}
