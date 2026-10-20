/**
 * GET /api/events/stream（SSE，docs/18 §2）：心跳 15s、Last-Event-ID 重放、连接时未读快照。
 *
 * 进程内 ring buffer 支持最近 1000 帧；事件同时写 events_outbox 供后续 worker 扇出。
 * 多实例需 Redis pub/sub（缺口登记验收记录）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serviceContext } from '../lib/service-context.js';
import { getRealtimeHub, loadEventLogReplay, renderRealtimeFrame, type RealtimeEvent } from '../realtime/hub.js';
import { unreadSnapshot } from '../services/conversations.js';
import { getM5Services } from '../services/m5.js';
import {
  renderHeartbeatComment,
  renderRetryFrame,
  writeSseChunk,
} from '../agent/sse.js';

const Query = z.object({
  topics: z.string().optional(),
  last_event_id: z.string().optional(),
});

function snapshotFrame(payload: Record<string, unknown>, seq: number): string {
  return `event: unread.snapshot\nid: ${seq}\ndata: ${JSON.stringify({
    event_id: String(seq),
    type: 'unread.snapshot',
    seq,
    ts: new Date().toISOString(),
    payload,
  })}\n\n`;
}

function resyncFrame(reason: string, seq: number): string {
  return `event: resync\nid: ${seq}\ndata: ${JSON.stringify({
    event_id: String(seq),
    type: 'resync',
    seq,
    ts: new Date().toISOString(),
    payload: { reason, current_seq: seq },
  })}\n\n`;
}

export function registerEventRoutes(app: FastifyInstance): void {
  const { conversations, hub } = getM5Services(app);

  app.get(
    '/api/events/stream',
    { config: { minRole: 'viewer', audit: false } },
    async (request, reply) => {
      const query = Query.parse(request.query ?? {});
      const context = serviceContext(request);
      const rawLast =
        request.headers['last-event-id'] ??
        query.last_event_id ??
        null;
      const lastEventId =
        typeof rawLast === 'string'
          ? rawLast
          : Array.isArray(rawLast) && typeof rawLast[0] === 'string'
            ? rawLast[0]
            : null;
      const topics = new Set(
        (query.topics ?? 'message,draft,approval')
          .split(',')
          .map((topic) => topic.trim())
          .filter(Boolean),
      );
      const topicAllowed = (type: string): boolean =>
        topics.has(type.split('.')[0]!) || topics.has('all');

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': request.requestId,
      });
      res.write(renderRetryFrame());

      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      let writing: Promise<void> = Promise.resolve();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        res.off('close', cleanup);
        if (!res.writableEnded) res.end();
      };

      const write = (chunk: string): void => {
        writing = writing
          .then(() => writeSseChunk(res, chunk))
          .catch(() => cleanup());
      };

      res.on('close', cleanup);
      try {
        const replay = await loadEventLogReplay(app.prisma, lastEventId);
        const currentSeq = replay.currentSeq || hub.currentSeq;
        const snapshot = await unreadSnapshot(conversations, context.userId, currentSeq);
        write(snapshotFrame(snapshot as unknown as Record<string, unknown>, currentSeq));
        if (replay.resyncReason) write(resyncFrame(replay.resyncReason, currentSeq));
        for (const event of replay.events) {
          if (topicAllowed(event.type)) write(renderRealtimeFrame(event, request.requestId));
        }
        unsubscribe = hub.subscribe((event: RealtimeEvent) => {
          if (!topicAllowed(event.type)) return;
          write(renderRealtimeFrame(event, request.requestId));
        });
        heartbeat = setInterval(() => {
          if (closed) return;
          write(renderHeartbeatComment(Date.now()));
        }, 15_000);
        heartbeat.unref?.();
      } catch {
        cleanup();
        return;
      }
      // 连接保持到客户端关闭；Fastify reply 已 hijack。
    },
  );
}
