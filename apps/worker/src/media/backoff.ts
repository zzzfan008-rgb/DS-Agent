/**
 * 轮询/重试退避曲线（docs/10 §5.3）：
 *   delay(n) = min(base * 2^n, cap) * (1 + jitter), jitter ∈ [-0.2, +0.2]
 * image/render: base 2s, cap 30s；video: base 5s, cap 120s。
 * random 可注入，测试用 0.5 得到零抖动。
 */
import type { MediaPurpose } from './types.js';

export interface BackoffCurve {
  baseMs: number;
  capMs: number;
  jitterRatio: number;
}

export function backoffCurve(purpose: MediaPurpose): BackoffCurve {
  return purpose === 'video'
    ? { baseMs: 5_000, capMs: 120_000, jitterRatio: 0.2 }
    : { baseMs: 2_000, capMs: 30_000, jitterRatio: 0.2 };
}

export function backoffDelayMs(
  purpose: MediaPurpose,
  n: number,
  random: () => number = Math.random,
): number {
  const curve = backoffCurve(purpose);
  const raw = Math.min(curve.baseMs * 2 ** Math.max(0, n), curve.capMs);
  const jitter = (random() * 2 - 1) * curve.jitterRatio;
  return Math.max(0, Math.round(raw * (1 + jitter)));
}
