/**
 * 公开 SSE 帧渲染与背压写入（docs/12 §7.1、§7.2）。
 *
 * 帧格式：`event: <type>` / `id: <event_id>` / `data: <json>` / 空行；
 * 首帧 `retry: 3000`；心跳是注释行 `: hb <ts>`，不计事件。
 */
import type { ServerResponse } from 'node:http';
import type { BufferedPublicEvent } from './types.js';

export const SSE_RETRY_MS = 3000;
const WRITE_TIMEOUT_MS = 30_000;
export const SSE_HEARTBEAT_COMMENT_PREFIX = ': hb ';

export interface SseEnvelope {
  event_id: string;
  type: string;
  seq: number;
  ts: string;
  org_id: number;
  request_id: string;
  payload: Record<string, unknown>;
}

export function helloEvent(args: {
  runId: string;
  requestId: string;
  orgId: number;
  heartbeatSeconds: number;
  now: number;
}): { event: BufferedPublicEvent; frame: string } {
  const ts = new Date(args.now).toISOString();
  const event: BufferedPublicEvent = {
    seq: 0,
    type: 'hello',
    ts,
    eventId: `${args.runId}-${'0'.padStart(6, '0')}`,
    payload: {
      stream_id: args.runId,
      server_time: ts,
      heartbeat_s: args.heartbeatSeconds,
    },
  };
  return { event, frame: renderSseFrame(event, args.requestId, args.orgId) };
}

export function renderSseFrame(
  event: BufferedPublicEvent,
  requestId: string,
  orgId: number,
): string {
  const envelope: SseEnvelope = {
    event_id: event.eventId,
    type: event.type,
    seq: event.seq,
    ts: event.ts,
    org_id: orgId,
    request_id: requestId,
    payload: event.payload,
  };
  return `event: ${event.type}\nid: ${event.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function renderRetryFrame(): string {
  return `retry: ${SSE_RETRY_MS}\n\n`;
}

export function renderHeartbeatComment(now: number): string {
  return `${SSE_HEARTBEAT_COMMENT_PREFIX}${new Date(now).toISOString()}\n\n`;
}

export class SseClosedError extends Error {
  constructor() {
    super('SSE 连接已关闭（背压超时或客户端断开）');
    this.name = 'SseClosedError';
  }
}

/** 写一帧并等待 flush；30s 未消费则认定为背压超时（docs/12 §7.1）。 */
export function writeSseChunk(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.reject(new SseClosedError());
  if (res.writableLength > 1024 * 1024) {
    res.destroy();
    return Promise.reject(new SseClosedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      res.destroy();
      reject(new SseClosedError());
    }, WRITE_TIMEOUT_MS);
    timer.unref?.();
    res.write(chunk, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

/** 拆 `{runId}-000042` → 42；非法返回 null。 */
export function parseEventSeq(eventId: string, runId: string): number | null {
  if (!eventId.startsWith(`${runId}-`)) return null;
  const suffix = eventId.slice(runId.length + 1);
  if (!/^\d{1,12}$/.test(suffix)) return null;
  const seq = Number(suffix);
  return Number.isSafeInteger(seq) ? seq : null;
}
