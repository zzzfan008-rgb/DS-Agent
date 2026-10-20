'use client';

import type { ReactNode } from 'react';
import { Icon } from '@/components/common/Icon';
import styles from './m3.module.css';

export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'violet';

const TONE_CLASS: Record<ChipTone, string | undefined> = {
  neutral: undefined,
  success: styles.chipSuccess,
  warning: styles.chipWarning,
  danger: styles.chipDanger,
  info: styles.chipInfo,
  violet: styles.chipViolet,
};

export function Chip({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`${styles.chip} ${TONE_CLASS[tone] ?? ''}`} title={title}>
      {children}
    </span>
  );
}

export function SectionCard({
  title,
  description,
  extra,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${styles.card} ${className ?? ''}`}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          {description ? <p className={styles.cardDesc}>{description}</p> : null}
        </div>
        {extra ? <div className={styles.cardExtra}>{extra}</div> : null}
      </div>
      <div className={styles.cardBody}>{children}</div>
    </section>
  );
}

/** 后端尚未聚合的字段：灰条 + 明确文案，不猜值（队长硬要求）。 */
export function PendingAggregate({ label = '待服务端聚合' }: { label?: string }) {
  return (
    <span
      className={styles.pending}
      title="该字段需后端聚合（t28）；前端不展示推断值，避免把未校验数据当成已校验"
    >
      <span className={styles.pendingBar} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`${styles.field} ${className ?? ''}`}>
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
        {required ? <span className={styles.required}>*</span> : null}
      </label>
      {children}
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
      {hint ? <p className={styles.fieldHint}>{hint}</p> : null}
    </div>
  );
}

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  if (!open) return null;
  return (
    <div
      className={styles.drawerOverlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.drawer}
        style={{ width: `min(${width}px, 100%)` }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : '详情'}
      >
        <div className={styles.drawerHead}>
          <div>
            <h2 className={styles.drawerTitle}>{title}</h2>
            {description ? <p className={styles.drawerDesc}>{description}</p> : null}
          </div>
          <button type="button" className="buttonQuiet" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className={styles.drawerBody}>{children}</div>
        {footer ? <div className={styles.drawerFoot}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function InlineAlert({
  tone = 'error',
  title,
  children,
}: {
  tone?: 'error' | 'warning' | 'info' | 'success';
  title?: ReactNode;
  children: ReactNode;
}) {
  const className =
    tone === 'error'
      ? styles.alertError
      : tone === 'warning'
        ? styles.alertWarning
        : tone === 'success'
          ? styles.alertSuccess
          : styles.alertInfo;
  return (
    <div className={`${styles.alert} ${className}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : 'alert'} size={16} />
      <div>
        {title ? <p className={styles.alertTitle}>{title}</p> : null}
        <div className={styles.alertText}>{children}</div>
      </div>
    </div>
  );
}

export interface IssueLike {
  code?: string;
  field?: string;
  message: string;
}

export function ValidationList({
  title = '校验未通过',
  issues,
}: {
  title?: string;
  issues: IssueLike[];
}) {
  if (issues.length === 0) return null;
  return (
    <div className={styles.validation}>
      <p className={styles.validationTitle}>
        {title}（{issues.length} 项）
      </p>
      <ul className={styles.validationList}>
        {issues.map((issue, index) => (
          <li key={`${issue.field ?? 'field'}-${index}`}>
            {issue.field ? <code>{issue.field}</code> : null}
            {issue.field ? '：' : null}
            {issue.message}
            {issue.code ? <span className={styles.issueCode}>{issue.code}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Spinner({ label = '处理中' }: { label?: string }) {
  return (
    <span className={styles.spinnerWrap} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? styles.segmentActive : undefined}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatInline({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <span className={styles.statInline}>
      <strong>{value}</strong>
      {label}
    </span>
  );
}
