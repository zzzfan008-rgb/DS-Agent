/**
 * Agent 路由（docs/12 §3.12、§7、§8；docs/17 §6）。
 *
 *   POST /api/agent/run
 *   GET  /api/agent/runs/:id
 *   GET  /api/agent/runs/:id/events   （SSE）
 *   POST /api/agent/runs/:id/cancel
 *
 * 认证：浏览器 Cookie（`__Host-dssaas_sid`）；写操作额外校验 CSRF 双提交与
 * Idempotency-Key，均由 t2 的插件完成。SSE 是只读 GET，不校验 CSRF。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { sha256Json } from '../lib/ids.js';
import { sessionKeyOf } from './intents.js';
import { AGENT_INTENTS, type AgentIntent } from './types.js';
import {
  helloEvent,
  parseEventSeq,
  renderHeartbeatComment,
  renderRetryFrame,
  renderSseFrame,
  SseClosedError,
  writeSseChunk,
} from './sse.js';
import type { RunActor } from './run-manager.js';

const PAGE_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;
const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;
const TOOL_PATTERN = /^[a-z][a-z0-9_.:-]{1,63}$/;

const ContextSchema = z
  .object({
    page: z.string().regex(PAGE_PATTERN, 'page 只允许小写标识符（不允许 URL/路径/SQL）'),
    object_type: z.string().regex(OBJECT_TYPE_PATTERN).optional(),
    object_id: z.string().uuid().optional(),
  })
  .strict();

const InputSchema = z
  .object({
    text: z.string().min(1).max(8000).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const RunRequestSchema = z
  .object({
    intent: z.enum(AGENT_INTENTS),
    context: ContextSchema,
    input: InputSchema.default({}),
    stream: z.boolean().default(true),
    timeout_ms: z.number().int().min(1000).max(600_000).optional(),
    /** F1 诊断/测量用：只覆盖本次 run 的首 token 超时，不改全局默认。 */
    first_token_timeout_ms: z.number().int().min(100).max(60_000).optional(),
    tools_allow: z.array(z.string().regex(TOOL_PATTERN)).max(32).optional(),
    confirm_irreversible: z.literal(false).optional(),
  })
  .strict();

export const CancelRequestSchema = z
  .object({ reason: z.string().min(1).max(200).optional() })
  .strict();

function actorOf(request: FastifyRequest): RunActor {
  const auth = request.auth;
  if (!auth) throw new ApiError('unauthorized', '请先登录');
  return {
    userId: auth.userId,
    role: auth.role,
    orgId: auth.orgId,
    requestId: request.requestId,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function registerAgentRoutes(app: FastifyInstance): void {
  app.post(
    '/api/agent/run',
    { config: { minRole: 'operator' } },
    async (request, reply) => {
      const body = RunRequestSchema.parse(request.body ?? {});
      if (jsonSize(body.input) > 16 * 1024) {
        throw new ApiError('validation_failed', 'input 过大（>16KB），请缩小参数或改用事实引用', {
          detail: { field: 'input' },
        });
      }
      const maxTimeout = app.config.agentMaxTimeoutMs;
      const timeoutMs = body.timeout_ms ?? app.config.agentRunTimeoutMs;
      if (timeoutMs > maxTimeout) {
        throw new ApiError('validation_failed', `timeout_ms 不得超过 ${maxTimeout}`, {
          detail: { field: 'timeout_ms', max: maxTimeout },
        });
      }
      if (body.first_token_timeout_ms !== undefined && body.first_token_timeout_ms > timeoutMs) {
        throw new ApiError('validation_failed', 'first_token_timeout_ms 不得大于 timeout_ms', {
          detail: { field: 'first_token_timeout_ms', max: timeoutMs },
        });
      }
      const actor = actorOf(request);
      const result = await app.agentRuns.createRun({
        actor,
        intent: body.intent as AgentIntent,
        context: {
          page: body.context.page,
          ...(body.context.object_type ? { objectType: body.context.object_type } : {}),
          ...(body.context.object_id ? { objectId: body.context.object_id } : {}),
        },
        input: body.input,
        stream: body.stream,
        timeoutMs,
        ...(body.first_token_timeout_ms === undefined
          ? {}
          : { firstTokenTimeoutMs: body.first_token_timeout_ms }),
        toolsAllow: body.tools_allow,
        confirmIrreversible: false,
      });
      request.auditLogged = true;
      reply.code(202);
      return ok(request, result);
    },
  );

  app.get(
    '/api/agent/runs/:id',
    { config: { minRole: 'viewer', audit: false } },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const view = app.agentRuns.getRun(params.id, actorOf(request));
      return ok(request, view);
    },
  );

  app.post(
    '/api/agent/runs/:id/cancel',
    { config: { minRole: 'operator' } },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = CancelRequestSchema.parse(request.body ?? {});
      const actor = actorOf(request);
      const result = await app.agentRuns.cancelRun(params.id, actor, body.reason ?? null);
      request.auditLogged = true;
      return ok(request, result);
    },
  );

  app.get(
    '/api/agent/runs/:id/events',
    { config: { minRole: 'viewer', audit: false } },
    async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const actor = actorOf(request);
      // 先取一次，未授权/不存在在升级为 SSE 之前返回 JSON 错误。
      const view = app.agentRuns.getRun(params.id, actor);
      const rawLastId =
        request.headers['last-event-id'] ??
        (typeof request.query === 'object' && request.query !== null
          ? (request.query as Record<string, unknown>).last_event_id
          : undefined);
      const lastEventId =
        typeof rawLastId === 'string'
          ? rawLastId
          : Array.isArray(rawLastId) && typeof rawLastId[0] === 'string'
            ? rawLastId[0]
            : null;
      await streamRunEvents(app, request, reply, params.id, actor, lastEventId, view.request_id);
    },
  );
}

async function streamRunEvents(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  runId: string,
  actor: ReturnType<typeof actorOf>,
  lastEventId: string | null,
  requestId: string,
): Promise<void> {
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

  const orgId = actor.orgId;
  const heartbeatMs = app.config.agentHeartbeatMs;
  const hello = helloEvent({
    runId,
    requestId,
    orgId,
    heartbeatSeconds: Math.round(heartbeatMs / 1000),
    now: Date.now(),
  });
  const queue: string[] = [];
  let cursor = 0;
  let pumping = false;
  let closed = false;
  let closeAfterDrain = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let subscription: ReturnType<typeof app.agentRuns.subscribe> | null = null;

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    subscription?.unsubscribe();
    res.off('close', close);
    if (!res.writableEnded) res.end();
  };

  try {
    await writeSseChunk(res, hello.frame);
  } catch {
    close();
    return;
  }

  const pump = async (): Promise<void> => {
    if (pumping || closed) return;
    pumping = true;
    try {
      while (queue.length > 0 && !closed) {
        const chunk = queue.shift()!;
        await writeSseChunk(res, chunk);
      }
      if (closeAfterDrain && !closed) close();
    } catch (error) {
      if (!(error instanceof SseClosedError)) {
        request.log.warn({ err: error, run_id: runId }, 'agent SSE write failed');
      }
      close();
    } finally {
      pumping = false;
    }
  };

  const enqueueEvent = (event: ReturnType<typeof helloEvent>['event']): void => {
    if (closed || event.seq <= cursor) return;
    cursor = event.seq;
    queue.push(renderSseFrame(event, requestId, orgId));
    if (event.type === 'run.finished' || event.type === 'run.error') closeAfterDrain = true;
    void pump();
  };

  subscription = app.agentRuns.subscribe(runId, actor, lastEventId, (event) => {
    enqueueEvent(event);
  });

  if (subscription.gap) {
    // 缺口过大：先 resync + 全量快照，再整体回放（docs/12 §7.1）。
    queue.push(
      renderSseFrame(
        {
          seq: cursor,
          type: 'resync',
          ts: new Date().toISOString(),
          eventId: `${runId}-${String(cursor).padStart(6, '0')}`,
          payload: { reason: 'buffer_gap', snapshot: app.agentRuns.getRun(runId, actor) },
        },
        requestId,
        orgId,
      ),
    );
  }
  for (const event of subscription.replay) enqueueEvent(event);
  if (!subscription.live) closeAfterDrain = true;
  if (!queue.length && closeAfterDrain) close();
  else void pump();

  heartbeat = setInterval(() => {
    if (closed) return;
    if (res.writableLength > 0) return;
    res.write(renderHeartbeatComment(Date.now()));
  }, heartbeatMs);
  heartbeat.unref?.();

  res.on('close', close);
  res.on('error', close);
  request.raw.on('error', close);

  // 让 handler 立即返回，响应由 raw socket 接管。
  await new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    if (closed) resolve();
  });
}

/** 供测试/自检：计算会话键（避免测试重复实现）。 */
export function computeSessionKey(input: {
  orgId: number;
  userId: string;
  intent: AgentIntent;
  objectType?: string;
  objectId?: string;
}): string {
  return sessionKeyOf({ ...input, objectVersion: 0 });
}

/** 供测试/自检：请求体指纹（幂等重放断言）。 */
export function runRequestFingerprint(body: unknown): string {
  return sha256Json(body);
}

/** 解析 `Last-Event-ID`（导出给测试用）。 */
export function eventSeqOf(runId: string, eventId: string | null): number | null {
  return eventId === null ? null : parseEventSeq(eventId, runId);
}
