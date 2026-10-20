/**
 * Agent 驱动层类型（t3，docs/17）。
 *
 * 三层形状固定：
 *   1) `AgentRunEnvelope`：api → Host 的业务信封（docs/17 §3.1 的 camelCase 形态）；
 *   2) `BridgeEvent`：Host 内部事件（docs/17 §3.2 左列），wire 上是 SSE `event:` 名 + JSON data；
 *   3) `BufferedPublicEvent`：翻译后的公开 SSE 事件（docs/12 §7.3），前端只认这一层。
 *
 * 本文件不依赖 Fastify/Prisma，便于单测与未来的 worker 复用。
 */
import type { Role } from '@dssaas/core';

export const AGENT_INTENTS = [
  'content.draft',
  'content.rewrite',
  'product.qa',
  'support.suggest',
  'inquiry.quote_draft',
  'listing.diagnose',
] as const;

export type AgentIntent = (typeof AGENT_INTENTS)[number];

export const AGENT_INTENT_SET: ReadonlySet<string> = new Set(AGENT_INTENTS);

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timeout',
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** api → Host 信封（docs/17 §3.1）。字段名按该节 camelCase。 */
export interface AgentRunEnvelope {
  runId: string;
  requestId: string;
  userId: string;
  role: Role;
  intent: AgentIntent;
  context: { page: string; objectType?: string; objectId?: string };
  input: { text?: string; params?: Record<string, unknown> };
  /**
   * 事实快照（docs/17 §2.2 ⑤）。M1 尚未实现事实快照服务：`snapshotId`/`hash`
   * 为 null、`version` 为 0；t8/t9 落地后由 api 填充真实快照，Host 侧校验。
   */
  facts: { snapshotId: string | null; hash: string | null; version: number };
  bundle: { preset: string; skills: string[]; manifestHash: string };
  toolsAllow?: string[];
  limits: { timeoutMs: number; maxOutputTokens: number; maxToolCalls: number; maxCostCents: number };
}

/** Host 内部事件（docs/17 §3.2）。`heartbeat` 仅用于客户端容错，不映射公开事件。 */
export type BridgeEvent =
  | { type: 'queued'; position: number }
  | {
      type: 'meta';
      runId: string;
      sessionId?: string;
      bundleVersion?: string;
      modelId?: string;
    }
  | {
      type: 'step';
      seq: number;
      name: string;
      status: 'running' | 'done' | 'failed';
      summary?: string;
    }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; tool: string; argsSummary?: string }
  | { type: 'tool_result'; tool: string; ok: boolean; summary?: string }
  | { type: 'need_input'; question: string; options?: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costCents: number }
  | {
      type: 'final';
      output: { text?: string; artifacts?: unknown[] };
      durationMs?: number;
    }
  | {
      type: 'error';
      code: string;
      message: string;
      retryable?: boolean;
      nextAction?: string;
    }
  | { type: 'heartbeat' };

/** 公开 SSE 事件类型（docs/12 §7.3）。`resync` 用于回放缺口。 */
export type PublicEventType =
  | 'hello'
  | 'resync'
  | 'run.queued'
  | 'run.started'
  | 'run.step'
  | 'run.delta'
  | 'run.tool_call'
  | 'run.tool_result'
  | 'run.need_input'
  | 'run.finished'
  | 'run.error';

/** 一条进入回放缓冲区、也直接写给 SSE 订阅者的公开事件。 */
export interface BufferedPublicEvent {
  /** 单调序号；hello 固定为 0，业务事件从 1 开始。 */
  seq: number;
  type: PublicEventType;
  payload: Record<string, unknown>;
  /** ISO8601 UTC。 */
  ts: string;
  /** `{streamId}-{seq6}`（docs/12 §7.1）。 */
  eventId: string;
}

export interface RunTokens {
  in: number;
  out: number;
}

export interface RunArtifacts {
  text: string;
  artifacts: unknown[];
  partial: boolean;
}

export interface RunErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  next_action: string;
}

export interface RunStepView {
  seq: number;
  name: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  ended_at: string | null;
  summary: string | null;
}

/** `GET /api/agent/runs/:id` 的 data（docs/12 §3.12）。 */
export interface AgentRunView {
  run_id: string;
  status: RunStatus;
  intent: AgentIntent;
  steps: RunStepView[];
  output: RunArtifacts;
  error: RunErrorInfo | null;
  tokens: RunTokens;
  cost_cents: number;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  expires_at: string;
  request_id: string;
  queue_position: number | null;
  model_id: string | null;
  bundle_version: string | null;
  session_key: string;
  first_token_ms: number | null;
  first_token_timeout_ms: number;
}

/** `POST /api/agent/runs/:id/cancel` 的 data（docs/12 §3.12）。 */
export interface CancelRunResult {
  run_id: string;
  status: RunStatus;
  partial_output_ref: string | null;
}

/** 订阅者收到的帧（已含 event_id / SSE 文本由 events.ts 渲染）。 */
export interface RunSubscription {
  /** 已回放的历史事件（按 seq 升序）。 */
  replay: BufferedPublicEvent[];
  /** 历史之后是否还要保持长连接。 */
  live: boolean;
  unsubscribe(): void;
}

/** 桥接健康信息（Host `GET /internal/health`）。 */
export interface BridgeHealth {
  ok: boolean;
  status: 'ok' | 'down' | 'not_configured';
  version: string | null;
  preset: string | null;
  manifest_hash: string | null;
  mcp_tools: number | null;
  latency_ms: number | null;
  error: { code: string; message: string; detail?: unknown } | null;
}
