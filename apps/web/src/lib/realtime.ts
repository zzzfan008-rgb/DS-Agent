'use client';

/**
 * SSE 占位（docs/12 §7 / docs/13 §2.2）。
 *
 * M1 默认关闭（`NEXT_PUBLIC_SSE_ENABLED=false`）：连接灯显示"实时未接入"，
 * 不主动发起请求，也不假装已连通。打开开关后实现连接/退避/降级状态机骨架，
 * 但 M1 不消费业务事件（M4 接审批、M5 接客服）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type RealtimeState =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded';

export interface RealtimeSnapshot {
  enabled: boolean;
  state: RealtimeState;
  attempts: number;
  lastConnectedAt: string | null;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const SSE_ENABLED = process.env.NEXT_PUBLIC_SSE_ENABLED === 'true';

export function useRealtimeStream(): RealtimeSnapshot {
  const [state, setState] = useState<RealtimeState>(SSE_ENABLED ? 'connecting' : 'disabled');
  const [attempts, setAttempts] = useState(0);
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const attemptsRef = useRef(0);

  const cleanup = useCallback(() => {
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!SSE_ENABLED) {
      setState('disabled');
      return;
    }
    disposedRef.current = false;

    const connect = () => {
      if (disposedRef.current) return;
      cleanup();
      setState(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');
      const source = new EventSource('/api/events/stream', { withCredentials: true });
      sourceRef.current = source;

      source.addEventListener('hello', () => {
        attemptsRef.current = 0;
        setAttempts(0);
        setState('connected');
        setLastConnectedAt(new Date().toISOString());
      });

      source.onopen = () => {
        setLastConnectedAt(new Date().toISOString());
        setState('connected');
      };

      source.onerror = () => {
        source.close();
        sourceRef.current = null;
        if (disposedRef.current) return;
        attemptsRef.current += 1;
        setAttempts(attemptsRef.current);
        if (attemptsRef.current >= 3) {
          setState('degraded');
        } else {
          setState('reconnecting');
        }
        const delay =
          BACKOFF_MS[Math.min(attemptsRef.current - 1, BACKOFF_MS.length - 1)] ?? 15_000;
        retryRef.current = setTimeout(connect, delay);
      };

      // TODO(M4/M5): 按 docs/12 §7.3 消费 approval.* / message.new / media.job 事件；
      // M1 只验证连接状态，不订阅业务语义。
    };

    connect();
    return () => {
      disposedRef.current = true;
      cleanup();
    };
  }, [cleanup]);

  return {
    enabled: SSE_ENABLED,
    state,
    attempts,
    lastConnectedAt,
  };
}

export function realtimeLabel(state: RealtimeState): { text: string; tooltip: string } {
  switch (state) {
    case 'connected':
      return { text: '实时已连接', tooltip: 'SSE 已连接；M1 仅验证连接状态，业务事件在 M4–M5 接入' };
    case 'connecting':
      return { text: '实时连接中', tooltip: '正在连接 /api/events/stream' };
    case 'reconnecting':
      return { text: '实时重连中', tooltip: 'SSE 断开，正在按 1s/2s/4s/8s/15s 退避重连' };
    case 'degraded':
      return { text: '实时降级', tooltip: '连续 3 次失败，已降级；M1 的轮询占位不请求不存在的接口' };
    case 'disabled':
    default:
      return {
        text: '实时未接入',
        tooltip: 'M1 占位：SSE 开关关闭；M4 接审批、M5 接客服',
      };
  }
}
