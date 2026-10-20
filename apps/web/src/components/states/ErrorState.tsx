'use client';

import { useCallback, useState } from 'react';
import { Icon } from '@/components/common/Icon';
import styles from './states.module.css';

export interface ErrorStateProps {
  title?: string;
  code?: string | null;
  message?: string | null;
  requestId?: string | null;
  nextAction?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}

const NEXT_ACTION_LABEL: Record<string, string> = {
  retry_later: '重试',
  reopen_approval: '重新发起审批',
  fix_and_resubmit: '修复后重提',
  create_compensation: '建立止损工单',
  contact_admin: '联系管理员',
  login: '重新登录',
  none: '返回',
};

/**
 * 统一错误态（docs/13 §2.3）：标题 + 原因（code + request_id）+ 按 next_action 的主按钮 + 复制。
 * 不允许只弹 toast 而不留现场。
 */
export function ErrorState({
  title = '加载失败',
  code,
  message,
  requestId,
  nextAction,
  onRetry,
  retryLabel,
}: ErrorStateProps) {
  const [copied, setCopied] = useState(false);
  const actionLabel = retryLabel ?? (nextAction ? NEXT_ACTION_LABEL[nextAction] : undefined) ?? '重试';

  const copy = useCallback(async () => {
    const text = [title, code ? `code=${code}` : '', requestId ? `request_id=${requestId}` : '', message ?? '']
      .filter(Boolean)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }, [code, message, requestId, title]);

  return (
    <div className={styles.error} role="alert">
      <div className={styles.errorHead}>
        <Icon name="alert" size={18} />
        <span className={styles.errorTitle}>{title}</span>
      </div>
      {message ? <p className={styles.errorMessage}>{message}</p> : null}
      <div className={styles.errorMeta}>
        <span>code: {code ?? '—'}</span>
        <span>request_id: {requestId ?? '—'}</span>
      </div>
      <div className={styles.actions}>
        {onRetry ? (
          <button type="button" className="buttonPrimary" onClick={onRetry}>
            {actionLabel}
          </button>
        ) : null}
        <button type="button" className="buttonQuiet" onClick={() => void copy()}>
          {copied ? '已复制' : '复制错误信息'}
        </button>
      </div>
    </div>
  );
}
