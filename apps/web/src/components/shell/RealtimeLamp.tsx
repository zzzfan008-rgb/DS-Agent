'use client';

import { realtimeLabel, useRealtimeStream, type RealtimeState } from '@/lib/realtime';
import styles from './shell.module.css';

const STATE_CLASS: Record<RealtimeState, string | undefined> = {
  disabled: '',
  connecting: styles.lampConnecting,
  connected: styles.lampConnected,
  reconnecting: styles.lampReconnecting,
  degraded: styles.lampDegraded,
};

/** 顶栏实时连接灯：M1 明确显示"未接入"，不假装已连通。 */
export function RealtimeLamp() {
  const snapshot = useRealtimeStream();
  const label = realtimeLabel(snapshot.state);
  return (
    <span
      className={`${styles.lamp} ${STATE_CLASS[snapshot.state] ?? ''}`}
      title={label.tooltip}
      role="status"
      aria-live="polite"
    >
      <span className={styles.lampDot} aria-hidden="true" />
      {label.text}
      {snapshot.attempts > 0 ? <span aria-hidden="true">· {snapshot.attempts} 次</span> : null}
    </span>
  );
}
