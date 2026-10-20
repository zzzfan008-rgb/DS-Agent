'use client';

import { useEffect, useRef, useState } from 'react';
import { formatDateTime, formatRemaining } from '@/lib/format';
import { Icon } from '@/components/common/Icon';
import styles from './approvals.module.css';

type Tone = 'normal' | 'warn' | 'danger';

export interface SlaCountdownProps {
  dueAt: string | null;
  status?: string;
  compact?: boolean;
}

const TERMINAL = new Set(['approved', 'rejected', 'expired', 'cancelled']);

function toneFor(remainingMs: number): Tone {
  if (remainingMs <= 0) return 'danger';
  if (remainingMs <= 30 * 60_000) return 'danger';
  if (remainingMs <= 2 * 60 * 60_000) return 'warn';
  return 'normal';
}

const TONE_CLASS: Record<Tone, string | undefined> = {
  normal: styles.slaNormal,
  warn: styles.slaWarn,
  danger: styles.slaDanger,
};

/** SLA 倒计时：30s 刷新；aria-live 只在跨阈值时播报，不每秒打断。 */
export function SlaCountdown({ dueAt, status, compact = false }: SlaCountdownProps) {
  const [now, setNow] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState('');
  const lastToneRef = useRef<Tone | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const terminal = Boolean(status && TERMINAL.has(status));
  const visible = Boolean(dueAt) && !terminal;
  const remaining = dueAt ? new Date(dueAt).getTime() - now : 0;
  const tone: Tone = visible ? toneFor(remaining) : 'normal';

  useEffect(() => {
    if (!visible) return;
    if (lastToneRef.current === null) {
      lastToneRef.current = tone;
      return;
    }
    if (lastToneRef.current !== tone) {
      lastToneRef.current = tone;
      setAnnouncement(
        tone === 'danger'
          ? remaining <= 0
            ? '该审批已超过 SLA'
            : '该审批 SLA 剩余不足 30 分钟'
          : tone === 'warn'
            ? '该审批 SLA 剩余不足 2 小时'
            : '该审批 SLA 已恢复充裕',
      );
    }
  }, [tone, remaining, visible]);

  if (!visible || !dueAt) {
    return <span className={styles.slaMuted}>—</span>;
  }

  return (
    <span
      className={`${styles.sla} ${TONE_CLASS[tone] ?? ''} ${compact ? styles.slaCompact : ''}`}
      title={`SLA 截止：${formatDateTime(dueAt)}`}
    >
      <Icon name="clock" size={13} />
      {formatRemaining(remaining)}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </span>
  );
}
