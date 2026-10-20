/**
 * SSE 秒级提醒事件中枢（docs/18 §2）。
 *
 * M5 使用进程内 ring buffer（最近 1000 帧）做 Last-Event-ID 回放；事件同时写
 * `events_outbox` 供后续 worker 扇出/补偿。多实例需换 Redis，缺口登记验收记录。
 * 事件 id 为严格递增的整数序列（SSE `id:`），不使用时间戳。
 */
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@dssaas/db';

export type RealtimeEventType =
  | 'message.created'
  | 'draft.updated'
  | 'approval.pending'
  | 'unread.snapshot'
  | 'resync';

export interface RealtimeEvent {
  seq: number;
  eventId: string;
  type: RealtimeEventType;
  ts: string;
  payload: Record<string, unknown>;
}

export interface ReplayResult {
  events: RealtimeEvent[];
  resyncReason: 'gap' | 'expired' | 'unknown_id' | 'ahead' | null;
  oldestSeq: number | null;
  currentSeq: number;
}

const RING_LIMIT = 1000;

export class RealtimeHub {
  private seq = 0;
  private readonly ring: RealtimeEvent[] = [];
  private readonly subscribers = new Set<(event: RealtimeEvent) => void>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  get currentSeq(): number {
    return this.seq;
  }

  publish(type: RealtimeEventType, payload: Record<string, unknown>, explicitSeq?: number): RealtimeEvent {
    const seq = explicitSeq ?? this.seq + 1;
    if (seq > this.seq) this.seq = seq;
    const event: RealtimeEvent = {
      seq,
      eventId: String(seq),
      type,
      ts: this.clock().toISOString(),
      payload,
    };
    this.ring.push(event);
    if (this.ring.length > RING_LIMIT) this.ring.splice(0, this.ring.length - RING_LIMIT);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // 单个订阅者写失败不阻塞其他连接；路由自行清理。
      }
    }
    return event;
  }

  /** 使用 event_log.seq 作为 SSE id 发布实时事件（DB 重放与实时流同一游标）。 */
  publishWithSeq(seq: number, type: RealtimeEventType, payload: Record<string, unknown>): RealtimeEvent {
    return this.publish(type, payload, seq);
  }

  subscribe(listener: (event: RealtimeEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** 按 Last-Event-ID 计算重放；显式返回空洞/过期/非法原因，供路由发 resync。 */
  replay(lastEventId: string | null): ReplayResult {
    const oldestSeq = this.ring.length > 0 ? this.ring[0]!.seq : null;
    const currentSeq = this.seq;
    if (lastEventId === null || lastEventId === '') {
      return { events: [], resyncReason: null, oldestSeq, currentSeq };
    }
    if (!/^\d{1,12}$/.test(lastEventId)) {
      return { events: [], resyncReason: 'unknown_id', oldestSeq, currentSeq };
    }
    const last = Number(lastEventId);
    if (!Number.isSafeInteger(last) || last < 0) {
      return { events: [], resyncReason: 'unknown_id', oldestSeq, currentSeq };
    }
    if (last > currentSeq) {
      return { events: [], resyncReason: 'ahead', oldestSeq, currentSeq };
    }
    if (oldestSeq !== null && last < oldestSeq - 1) {
      return { events: [], resyncReason: 'expired', oldestSeq, currentSeq };
    }
    const events = this.ring.filter((event) => event.seq > last);
    const first = events[0];
    if (first && first.seq > last + 1) {
      return { events, resyncReason: 'gap', oldestSeq, currentSeq };
    }
    return { events, resyncReason: null, oldestSeq, currentSeq };
  }
}

const hubs = new WeakMap<FastifyInstance, RealtimeHub>();

export function getRealtimeHub(app: FastifyInstance): RealtimeHub {
  const existing = hubs.get(app);
  if (existing) return existing;
  const hub = new RealtimeHub();
  hubs.set(app, hub);
  return hub;
}

export async function writeOutbox(
  prisma: PrismaClient,
  input: { topic: string; aggregateId: string | null; payload: Record<string, unknown> },
): Promise<string> {
  const row = await prisma.eventsOutbox.create({
    data: {
      orgId: 1n,
      topic: input.topic,
      aggregateId: input.aggregateId,
      payload: input.payload as never,
    },
  });
  return row.id;
}

/** 事务外事件：先落 outbox，再推 SSE；outbox 失败只记录不阻断业务。 */
export async function emitRealtime(
  app: FastifyInstance,
  input: {
    type: RealtimeEventType;
    aggregateId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<RealtimeEvent> {
  try {
    await writeOutbox(app.prisma, {
      topic: input.type,
      aggregateId: input.aggregateId,
      payload: input.payload,
    });
  } catch (error) {
    app.log.warn(
      { err: error, topic: input.type, aggregate_id: input.aggregateId },
      'events_outbox write failed; SSE event still published',
    );
  }
  let seq: number | undefined;
  try {
    const row = await app.prisma.eventLog.create({
      data: { topic: input.type, payload: input.payload as never },
      select: { seq: true },
    });
    seq = Number(row.seq);
  } catch (error) {
    app.log.warn({ err: error, topic: input.type }, 'event_log write failed; live SSE still published');
  }
  return getRealtimeHub(app).publish(input.type, input.payload, seq);
}

export function renderRealtimeFrame(event: RealtimeEvent, requestId: string): string {
  return `event: ${event.type}\nid: ${event.eventId}\ndata: ${JSON.stringify({
    event_id: event.eventId,
    type: event.type,
    seq: event.seq,
    ts: event.ts,
    request_id: requestId,
    payload: event.payload,
  })}\n\n`;
}

/**
 * 从 Postgres `event_log` 做 Last-Event-ID 重放（重启/跨实例可用）。
 * `event_log.seq` 是事件级游标，与 `message.event_seq` 不是同一条序列，禁止混用。
 */
export async function loadEventLogReplay(
  prisma: PrismaClient,
  lastEventId: string | null,
): Promise<ReplayResult> {
  const latest = await prisma.eventLog.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } });
  const oldest = await prisma.eventLog.findFirst({ orderBy: { seq: 'asc' }, select: { seq: true } });
  const currentSeq = latest ? Number(latest.seq) : 0;
  const oldestSeq = oldest ? Number(oldest.seq) : null;
  if (lastEventId === null || lastEventId === '') {
    return { events: [], resyncReason: null, oldestSeq, currentSeq };
  }
  if (!/^\d{1,18}$/.test(lastEventId)) {
    return { events: [], resyncReason: 'unknown_id', oldestSeq, currentSeq };
  }
  const last = BigInt(lastEventId);
  if (!latest) return { events: [], resyncReason: 'expired', oldestSeq, currentSeq };
  if (last > latest.seq) return { events: [], resyncReason: 'ahead', oldestSeq, currentSeq };
  if (oldest && last < oldest.seq - 1n) {
    return { events: [], resyncReason: 'expired', oldestSeq, currentSeq };
  }
  const rows = await prisma.eventLog.findMany({
    where: { seq: { gt: last } },
    orderBy: { seq: 'asc' },
    take: 501,
  });
  if (rows.length > 500) {
    return { events: [], resyncReason: 'expired', oldestSeq, currentSeq };
  }
  const events = rows.map<RealtimeEvent>((row) => ({
    seq: Number(row.seq),
    eventId: String(row.seq),
    type: row.topic as RealtimeEvent['type'],
    ts: row.createdAt.toISOString(),
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
  const first = events[0];
  if (first && first.seq > Number(last) + 1) {
    return { events, resyncReason: 'gap', oldestSeq, currentSeq };
  }
  return { events, resyncReason: null, oldestSeq, currentSeq };
}
