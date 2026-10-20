/**
 * Idempotency-Key 中间件（docs/12 §6）。
 *
 * 行为：
 * - 写操作（POST/PUT/PATCH/DELETE）默认要求 `Idempotency-Key`；路由可配 `idempotency:false` 豁免；
 * - 同键 + 同 payload → 回放缓存响应，并加 `Idempotent-Replayed: true`；
 * - 同键 + 不同 payload → 409 idempotency_conflict；
 * - 同键仍在处理中 → 409 conflict + Retry-After: 2；
 * - 窗口 24h，作用域 `(org_id, key)`。
 *
 * M1 说明：`idempotency_key` 表由 t12 补迁移，本实现先用进程内存储顶住；
 * 接口（get/setInFlight/complete/fail）保持不变，t12 落地后换 Redis/Postgres 实现即可。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { sha256Json } from '../lib/ids.js';

export interface CachedResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface Entry {
  payloadHash: string;
  state: 'in_flight' | 'completed';
  cached?: CachedResponse;
  createdAt: number;
  expiresAt: number;
}

export interface IdempotencyContext {
  key: string;
  headerValue: string;
  payloadHash: string;
}

const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class MemoryIdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs = 24 * 3600 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.cleanupTimer = setInterval(() => this.purge(), 60_000);
    this.cleanupTimer.unref();
  }

  get(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  setInFlight(key: string, payloadHash: string): void {
    const now = this.now();
    this.entries.set(key, {
      payloadHash,
      state: 'in_flight',
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
  }

  complete(key: string, response: CachedResponse): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.state = 'completed';
    entry.cached = response;
  }

  fail(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    clearInterval(this.cleanupTimer);
  }

  size(): number {
    return this.entries.size;
  }

  private purge(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }
}

export function registerIdempotency(
  app: FastifyInstance,
  store: MemoryIdempotencyStore,
  options: { headerName?: string } = {},
): void {
  const headerName = (options.headerName ?? 'Idempotency-Key').toLowerCase();

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING_METHODS.has(request.method.toUpperCase())) return;
    if (!request.url.startsWith('/api/')) return;
    if (request.routeOptions.config?.idempotency === false) return;

    const rawHeader = request.headers[headerName];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!headerValue || !KEY_PATTERN.test(headerValue)) {
      throw new ApiError('validation_failed', '写操作必须带合法 Idempotency-Key（16–128 位）', {
        detail: { field: 'Idempotency-Key' },
      });
    }

    const payloadHash = sha256Json({
      method: request.method.toUpperCase(),
      path: request.routeOptions.url ?? request.url.split('?')[0],
      body: request.body ?? null,
    });
    const key = `org:${request.auth?.orgId ?? 1}:${headerValue}`;
    const existing = store.get(key);

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ApiError('idempotency_conflict', '同一 Idempotency-Key 对应了不同请求内容');
      }
      if (existing.state === 'in_flight') {
        throw new ApiError('conflict', '相同幂等键的请求仍在处理中', {
          headers: { 'Retry-After': '2' },
          detail: { sub: 'idempotency_in_flight' },
        });
      }
      reply
        .code(existing.cached!.status)
        .headers(existing.cached!.headers)
        .header('Idempotent-Replayed', 'true')
        .type('application/json; charset=utf-8')
        .send(existing.cached!.body);
      return reply;
    }

    store.setInFlight(key, payloadHash);
    request.idempotency = { key, headerValue, payloadHash };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const context = request.idempotency;
    if (!context) return payload;
    const entry = store.get(context.key);
    if (!entry || entry.state !== 'in_flight') return payload;
    if (reply.statusCode >= 500 || typeof payload !== 'string') {
      store.fail(context.key);
      return payload;
    }
    const contentType = reply.getHeader('content-type');
    store.complete(context.key, {
      status: reply.statusCode,
      body: payload,
      headers: {
        'content-type':
          typeof contentType === 'string' ? contentType : 'application/json; charset=utf-8',
      },
    });
    return payload;
  });

  app.addHook('onClose', async () => store.clear());
}
