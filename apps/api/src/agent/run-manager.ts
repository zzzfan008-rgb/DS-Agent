/**
 * Agent 运行管理器（t3）。
 *
 * 职责（全部在 api 进程内，Host 只做有界任务）：
 *   - 创建 run：角色/intent 已由路由校验，这里做 Host 可用性预检、信封装配、并发闸门；
 *   - 执行 run：消费桥接事件流，翻译成公开 SSE 事件并缓存（支持 Last-Event-ID 回放）；
 *   - 终态：succeeded / failed / cancelled / timeout，终态后不再产出事件；
 *   - 取消：排队中直接移除；运行中 AbortSignal 传到 Host，5s 未释放则强制收尾；
 *   - 超时：整次运行 timeout_ms 强制 abort；桥接首 token 超时由 client 抛 `timeout`；
 *   - 审计与指标：agent.accept / agent.run / agent.cancel / agent.overload / agent.unavailable。
 *
 * M1 的 run 状态与事件缓冲均为进程内（可重建的派生数据），不新增业务表（docs/17 §5.2）；
 * 后续换 Redis Stream 时保持 `getRun` / `subscribe` / `cancel` 三个方法签名不变。
 */
import type { Role } from '@dssaas/core';
import type { AppConfig } from '../config.js';
import {
  ApiError,
  ERROR_DEFS,
  type ErrorCode,
  type NextAction,
} from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { AuditRecordInput, AuditService } from '../services/audit.js';
import type { MetricsRegistry } from '../services/metrics.js';
import { BridgeError, type TypertBridgeClient } from './bridge-client.js';
import { bundleDescriptor, skillsForIntent } from './bundle.js';
import { AgentConcurrencyGate } from './concurrency.js';
import { narrowTools, roleCanRunIntent, ruleForIntent, sessionKeyOf } from './intents.js';
import {
  isTerminalStatus,
  type AgentIntent,
  type AgentRunEnvelope,
  type AgentRunView,
  type BufferedPublicEvent,
  type CancelRunResult,
  type PublicEventType,
  type RunErrorInfo,
  type RunStatus,
  type RunStepView,
} from './types.js';

const MAX_BUFFERED_EVENTS = 1000;
const FORCE_CANCEL_GRACE_MS = 5000;
/** 公开事件 seq 的填充宽度（docs/12 §7.1 示例 `-000042`）。 */
const EVENT_SEQ_PAD = 6;

export interface RunActor {
  userId: string;
  role: Role;
  orgId: number;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface CreateRunInput {
  actor: RunActor;
  intent: AgentIntent;
  context: { page: string; objectType?: string; objectId?: string };
  input: { text?: string; params?: Record<string, unknown> };
  stream: boolean;
  timeoutMs: number;
  toolsAllow?: string[];
  confirmIrreversible: boolean;
}

export interface CreateRunOutput {
  run_id: string;
  status: Extract<RunStatus, 'queued' | 'running'>;
  sse_url: string;
  expires_at: string;
  concurrency_remaining: number;
  queue_position: number | null;
}

export interface RunSubscriptionHandle {
  replay: BufferedPublicEvent[];
  /** true = 历史里存在无法补齐的缺口，客户端应先整体刷新（docs/12 §7.1 `resync`）。 */
  gap: boolean;
  live: boolean;
  unsubscribe(): void;
}

interface RunRecord {
  runId: string;
  requestId: string;
  orgId: number;
  userId: string;
  role: Role;
  intent: AgentIntent;
  sessionKey: string;
  status: RunStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  timeoutMs: number;
  streamRequested: boolean;
  tools: string[];
  toolsIgnored: string[];
  envelope: AgentRunEnvelope;
  steps: Map<number, RunStepView>;
  outputText: string;
  artifacts: unknown[];
  tokens: { in: number; out: number };
  costCents: number;
  modelId: string | null;
  bundleVersion: string | null;
  sessionId: string | null;
  error: RunErrorInfo | null;
  firstTokenMs: number | null;
  queuePosition: number | null;
  events: BufferedPublicEvent[];
  nextSeq: number;
  subscribers: Set<(event: BufferedPublicEvent) => void>;
  terminal: boolean;
  terminalEmitted: boolean;
  startedEventEmitted: boolean;
  cancelRequested: boolean;
  timeoutFired: boolean;
  controller: AbortController | null;
  runTimer: NodeJS.Timeout | null;
  queueTimer: NodeJS.Timeout | null;
  forceCancelTimer: NodeJS.Timeout | null;
  retentionTimer: NodeJS.Timeout | null;
}

export interface RunManagerDeps {
  config: AppConfig;
  bridge: TypertBridgeClient;
  audit: AuditService;
  metrics: MetricsRegistry;
  now?: () => number;
  log?: { warn: (obj: unknown, msg?: string) => void; error?: (obj: unknown, msg?: string) => void };
}

function isOwnedBy(run: RunRecord, actor: Pick<RunActor, 'userId' | 'role'>): boolean {
  return run.userId === actor.userId || actor.role === 'admin';
}

function errorInfo(code: string, message: string, fallbackRetryable = false): RunErrorInfo {
  const known = (code in ERROR_DEFS ? code : 'internal_error') as ErrorCode;
  const def = ERROR_DEFS[known];
  const nextAction: NextAction = known === 'internal_error' ? 'contact_admin' : def.nextAction;
  return {
    code: known,
    message,
    retryable: def.retryable || fallbackRetryable,
    next_action: nextAction,
  };
}

export class AgentRunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly gate: AgentConcurrencyGate;
  private readonly now: () => number;
  private readonly log: RunManagerDeps['log'];
  private closed = false;

  constructor(private readonly deps: RunManagerDeps) {
    const { config } = deps;
    this.gate = new AgentConcurrencyGate(
      {
        maxConcurrency: config.agentMaxConcurrency,
        queueLimit: config.agentQueueLimit,
        maxPerUser: config.agentUserConcurrency,
        maxPerSession: config.agentSessionConcurrency,
      },
      deps.now,
    );
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log;
  }

  // ---------------------------------------------------------------------------
  // 创建 / 查询 / 取消
  // ---------------------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<CreateRunOutput> {
    if (this.closed) throw new ApiError('dsh_unavailable', 'Agent 驱动层正在关闭，请稍后重试');
    if (input.confirmIrreversible) {
      throw new ApiError('validation_failed', 'confirm_irreversible 必须为 false（Agent 永不直接写平台）', {
        detail: { field: 'confirm_irreversible' },
      });
    }
    if (!roleCanRunIntent(input.actor.role, input.intent)) {
      await this.auditOverload({
        actor: input.actor,
        reason: 'role_intent_denied',
        intent: input.intent,
        role: input.actor.role,
      });
      throw new ApiError('forbidden', `当前角色（${input.actor.role}）不能发起 ${input.intent}`, {
        detail: { intent: input.intent, required_roles: ruleForIntent(input.intent).roles },
      });
    }

    // Host 可用性预检：Host 未启动/令牌不可用 → POST 直接 503 dsh_unavailable（不是 202）。
    const health = await this.deps.bridge.health();
    if (!health.ok) {
      await this.auditUnavailable(input.actor, input.intent, health.error);
      throw new ApiError(
        'dsh_unavailable',
        `DSH Host 不可达（${this.deps.config.dshBridgeUrl}）：${
          health.error?.message ?? '健康检查失败'
        }。AI 能力暂不可用，可先用话术模板/人工处理。`,
        {
          detail: {
            reason:
              (health.error?.detail as { reason?: unknown } | undefined)?.reason ??
              health.error?.code ??
              'host_unavailable',
            bridge_url: this.deps.config.dshBridgeUrl,
          },
        },
      );
    }

    const rule = ruleForIntent(input.intent);
    const narrowed = narrowTools(input.intent, input.toolsAllow);
    const sessionKey = sessionKeyOf({
      orgId: input.actor.orgId,
      userId: input.actor.userId,
      intent: input.intent,
      objectType: input.context.objectType,
      objectId: input.context.objectId,
      objectVersion: 0,
    });
    const runId = uuidv7();
    const bundle = bundleDescriptor();
    const envelope: AgentRunEnvelope = {
      runId,
      requestId: input.actor.requestId,
      userId: input.actor.userId,
      role: input.actor.role,
      intent: input.intent,
      context: input.context,
      input: input.input,
      // M1：事实快照服务尚未落地（t8/t9），这里显式留空并在审计标注；Host 侧 M3 起校验。
      facts: { snapshotId: null, hash: null, version: 0 },
      bundle: {
        preset: bundle.preset,
        skills: skillsForIntent(input.intent),
        manifestHash: bundle.manifestHash,
      },
      ...(narrowed.tools.length > 0 ? { toolsAllow: narrowed.tools } : {}),
      limits: {
        timeoutMs: input.timeoutMs,
        maxOutputTokens: rule.maxOutputTokens,
        maxToolCalls: rule.maxToolCalls,
        maxCostCents: rule.maxCostCents,
      },
    };

    const admission = this.gate.admit({
      runId,
      userId: input.actor.userId,
      sessionKey,
    });
    if (admission.kind === 'rejected') {
      await this.auditOverload({
        actor: input.actor,
        reason: admission.reason,
        intent: input.intent,
        role: input.actor.role,
        queueDepth: admission.queue_depth,
      });
      const headers: Record<string, string> = { 'Retry-After': String(admission.retryAfterSeconds) };
      if (admission.reason === 'user_busy') {
        throw new ApiError('concurrency_user_limit', '同一用户并发运行已达上限（2），请等待当前运行结束', {
          headers,
          detail: { sub: 'user_busy', concurrency: this.deps.config.agentUserConcurrency },
        });
      }
      if (admission.reason === 'session_busy') {
        throw new ApiError('concurrency_session_limit', '该会话已有运行中的任务（单会话并发 1）', {
          headers,
          detail: { sub: 'agent_running', concurrency: this.deps.config.agentSessionConcurrency },
        });
      }
      throw new ApiError('queue_full', 'Agent 队列已满（30），请稍后重试或降级为话术模板', {
        headers,
        detail: { sub: 'queue_full', queue_limit: this.deps.config.agentQueueLimit },
      });
    }

    const run = this.newRecord({
      runId,
      input,
      envelope,
      sessionKey,
      tools: narrowed.tools,
      toolsIgnored: narrowed.ignored,
      status: admission.kind === 'started' ? 'running' : 'queued',
      queuePosition: admission.kind === 'queued' ? admission.position : null,
    });
    this.runs.set(runId, run);
    this.deps.metrics.set('agent_active_runs', 'Agent 运行中数量', {}, this.gate.activeCount());
    this.deps.metrics.set('agent_queue_depth', 'Agent 排队数量', {}, this.gate.queueDepth());

    await this.auditAccept(run);

    if (admission.kind === 'queued') {
      run.queueTimer = setTimeout(() => {
        void this.onQueueTimeout(run);
      }, this.deps.config.agentQueueWaitMs);
      run.queueTimer.unref?.();
      this.emit(run, 'run.queued', { run_id: run.runId, position: admission.position });
    } else {
      this.startExecution(run);
    }

    return {
      run_id: run.runId,
      status: run.status === 'queued' ? 'queued' : 'running',
      sse_url: `/api/agent/runs/${run.runId}/events`,
      expires_at: new Date(run.createdAt + this.deps.config.agentRunRetentionMs).toISOString(),
      concurrency_remaining: Math.max(0, this.deps.config.agentMaxConcurrency - this.gate.activeCount()),
      queue_position: run.queuePosition,
    };
  }

  getRun(runId: string, actor: Pick<RunActor, 'userId' | 'role'>): AgentRunView {
    const run = this.runs.get(runId);
    if (!run || !isOwnedBy(run, actor)) throw new ApiError('not_found', '运行不存在或已过期');
    return this.toView(run);
  }

  async cancelRun(
    runId: string,
    actor: Pick<RunActor, 'userId' | 'role' | 'requestId' | 'ip' | 'userAgent' | 'orgId'>,
    reason: string | null,
  ): Promise<CancelRunResult> {
    const run = this.runs.get(runId);
    if (!run || !isOwnedBy(run, actor)) throw new ApiError('not_found', '运行不存在或已过期');
    if (isTerminalStatus(run.status)) {
      return {
        run_id: run.runId,
        status: run.status,
        partial_output_ref: run.status === 'cancelled' ? this.partialRef(run) : null,
      };
    }
    run.cancelRequested = true;
    await this.auditCancel(run, actor, reason);
    if (run.status === 'queued') {
      this.gate.removeQueued(run.runId);
      this.clearQueueTimer(run);
      this.finish(run, 'cancelled', { reason: reason ?? 'client_cancelled' });
    } else {
      run.controller?.abort(new Error(reason ?? 'client_cancelled'));
      // 取消后 5 秒仍未释放槽位 → 强制收尾并计 agent_leak（docs/17 §3.4）。
      if (!run.forceCancelTimer) {
        run.forceCancelTimer = setTimeout(() => {
          if (!run.terminal) {
            this.deps.metrics.inc('agent_leak_total', '取消 5s 后未释放的 run', {});
            this.finish(run, 'cancelled', { reason: 'cancel_grace_expired' });
          }
        }, FORCE_CANCEL_GRACE_MS);
        run.forceCancelTimer.unref?.();
      }
    }
    return {
      run_id: run.runId,
      status: 'cancelled',
      partial_output_ref: this.partialRef(run),
    };
  }

  /**
   * 订阅某 run 的事件：先注册（避免丢事件）再把历史快照交给调用方。
   * `lastEventId` 形如 `{runId}-000042`；缺口过大时 `gap=true`，调用方发 `resync`。
   */
  subscribe(
    runId: string,
    actor: Pick<RunActor, 'userId' | 'role'>,
    lastEventId: string | null,
    onEvent: (event: BufferedPublicEvent) => void,
  ): RunSubscriptionHandle {
    const run = this.runs.get(runId);
    if (!run || !isOwnedBy(run, actor)) throw new ApiError('not_found', '运行不存在或已过期');

    const listener = (event: BufferedPublicEvent): void => {
      onEvent(event);
    };
    run.subscribers.add(listener);

    const cursor = this.parseLastEventSeq(run, lastEventId);
    const firstSeq = run.events[0]?.seq ?? 0;
    const gap = lastEventId !== null && cursor !== null && cursor < firstSeq - 1;
    const replay = gap
      ? [...run.events]
      : run.events.filter((event) => (cursor === null ? true : event.seq > cursor));
    return {
      replay,
      gap,
      live: !run.terminal,
      unsubscribe: () => {
        run.subscribers.delete(listener);
      },
    };
  }

  getQueuePosition(runId: string): number | null {
    return this.runs.get(runId)?.queuePosition ?? null;
  }

  stats(): { active: number; queued: number; runs: number } {
    const snapshot = this.gate.snapshot();
    return { active: snapshot.active, queued: snapshot.queued, runs: this.runs.size };
  }

  /** 进程关闭：中止所有在跑 run，清理定时器。 */
  close(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      this.clearRunTimers(run);
      run.controller?.abort(new Error('api_shutdown'));
      run.subscribers.clear();
    }
    this.runs.clear();
    this.gate.clear();
  }

  // ---------------------------------------------------------------------------
  // 内部：执行 / 终态
  // ---------------------------------------------------------------------------

  private newRecord(args: {
    runId: string;
    input: CreateRunInput;
    envelope: AgentRunEnvelope;
    sessionKey: string;
    tools: string[];
    toolsIgnored: string[];
    status: RunStatus;
    queuePosition: number | null;
  }): RunRecord {
    const now = this.now();
    return {
      runId: args.runId,
      requestId: args.input.actor.requestId,
      orgId: args.input.actor.orgId,
      userId: args.input.actor.userId,
      role: args.input.actor.role,
      intent: args.input.intent,
      sessionKey: args.sessionKey,
      status: args.status,
      createdAt: now,
      startedAt: args.status === 'running' ? now : null,
      endedAt: null,
      timeoutMs: args.input.timeoutMs,
      streamRequested: args.input.stream,
      tools: args.tools,
      toolsIgnored: args.toolsIgnored,
      envelope: args.envelope,
      steps: new Map(),
      outputText: '',
      artifacts: [],
      tokens: { in: 0, out: 0 },
      costCents: 0,
      modelId: null,
      bundleVersion: bundleDescriptor().bundleVersion,
      sessionId: null,
      error: null,
      firstTokenMs: null,
      queuePosition: args.queuePosition,
      events: [],
      nextSeq: 0,
      subscribers: new Set(),
      terminal: false,
      terminalEmitted: false,
      startedEventEmitted: false,
      cancelRequested: false,
      timeoutFired: false,
      controller: null,
      runTimer: null,
      queueTimer: null,
      forceCancelTimer: null,
      retentionTimer: null,
    };
  }

  private startExecution(run: RunRecord): void {
    if (run.terminal) return;
    run.status = 'running';
    run.startedAt = run.startedAt ?? this.now();
    this.startRunTimer(run);
    void this.execute(run);
  }

  private startRunTimer(run: RunRecord): void {
    if (run.runTimer) return;
    run.runTimer = setTimeout(() => {
      run.timeoutFired = true;
      run.controller?.abort(new Error('run_timeout'));
    }, run.timeoutMs);
    run.runTimer.unref?.();
  }

  private async execute(run: RunRecord): Promise<void> {
    if (run.terminal) return;
    if (run.cancelRequested) {
      this.finish(run, 'cancelled', { reason: 'cancelled_before_start' });
      return;
    }
    const controller = new AbortController();
    run.controller = controller;
    const startedAt = this.now();
    run.startedAt = run.startedAt ?? startedAt;

    let terminalEventSeen = false;
    try {
      for await (const event of this.deps.bridge.run(run.envelope, controller.signal, {
        firstTokenTimeoutMs: this.deps.config.agentFirstTokenTimeoutMs,
        onFirstToken: (elapsed) => {
          run.firstTokenMs = elapsed;
          this.deps.metrics.observe(
            'agent_first_token_seconds',
            'Agent 首 token 延迟（秒）',
            { intent: run.intent },
            elapsed / 1000,
          );
        },
        onMeta: (meta) => {
          run.modelId = meta.modelId ?? null;
          run.sessionId = meta.sessionId ?? null;
          run.bundleVersion = meta.bundleVersion ?? run.bundleVersion;
          this.emitStarted(run);
        },
      })) {
        if (event.type === 'heartbeat') continue;
        if (run.terminal) break;
        if (event.type !== 'meta' && event.type !== 'queued' && !run.startedEventEmitted) {
          this.emitStarted(run);
        }
        switch (event.type) {
          case 'queued':
            this.emit(run, 'run.queued', { run_id: run.runId, position: event.position });
            break;
          case 'meta':
            break;
          case 'step': {
            const existing = run.steps.get(event.seq);
            const ts = new Date(this.now()).toISOString();
            run.steps.set(event.seq, {
              seq: event.seq,
              name: event.name,
              status: event.status,
              started_at: existing?.started_at ?? ts,
              ended_at: event.status === 'running' ? null : ts,
              summary: event.summary ?? existing?.summary ?? null,
            });
            this.emit(run, 'run.step', {
              run_id: run.runId,
              seq: event.seq,
              name: event.name,
              status: event.status,
              ...(event.summary ? { summary: event.summary } : {}),
            });
            break;
          }
          case 'delta':
            run.outputText += event.text;
            this.emit(run, 'run.delta', { run_id: run.runId, seq: run.nextSeq + 1, text: event.text });
            break;
          case 'tool_call':
            this.emit(run, 'run.tool_call', {
              run_id: run.runId,
              tool: event.tool,
              ...(event.argsSummary ? { args_summary: event.argsSummary } : {}),
            });
            break;
          case 'tool_result':
            this.emit(run, 'run.tool_result', {
              run_id: run.runId,
              tool: event.tool,
              ok: event.ok,
              ...(event.summary ? { summary: event.summary } : {}),
            });
            break;
          case 'need_input':
            this.emit(run, 'run.need_input', {
              run_id: run.runId,
              question: event.question,
              options: event.options ?? [],
            });
            break;
          case 'usage':
            run.tokens = { in: event.inputTokens, out: event.outputTokens };
            run.costCents = event.costCents;
            break;
          case 'final': {
            terminalEventSeen = true;
            const finalText = event.output.text ?? '';
            if (finalText.length >= run.outputText.length) run.outputText = finalText;
            if (event.output.artifacts) run.artifacts = event.output.artifacts;
            if (run.cancelRequested) {
              this.finish(run, 'cancelled', { reason: 'client_cancelled' });
            } else {
              this.finish(run, 'succeeded', {
                durationMs: event.durationMs ?? this.now() - startedAt,
              });
            }
            break;
          }
          case 'error':
            terminalEventSeen = true;
            if (run.cancelRequested) this.finish(run, 'cancelled', { reason: 'client_cancelled' });
            else if (run.timeoutFired) this.finish(run, 'timeout', { reason: 'run_timeout' });
            else this.finishFromBridgeError(run, event.code, event.message, event.retryable, event.nextAction);
            break;
        }
        if (run.terminal) break;
      }

      if (!run.terminal) {
        if (!terminalEventSeen) {
          if (run.timeoutFired) this.finish(run, 'timeout', { reason: 'run_timeout' });
          else if (run.cancelRequested) this.finish(run, 'cancelled', { reason: 'client_cancelled' });
          else {
            this.finishFromBridgeError(
              run,
              'dsh_unavailable',
              'DSH Host 事件流在 final/error 之前结束（可能 Host 重启或网络中断）',
              true,
            );
          }
        }
      }
    } catch (error) {
      this.handleExecutionError(run, error);
    } finally {
      run.controller = null;
      this.clearRunTimer(run);
      this.clearForceCancelTimer(run);
      this.drainQueue();
    }
  }

  private handleExecutionError(run: RunRecord, error: unknown): void {
    if (run.terminal) return;
    if (run.cancelRequested) {
      this.finish(run, 'cancelled', { reason: 'client_cancelled' });
      return;
    }
    if (run.timeoutFired) {
      this.finish(run, 'timeout', { reason: 'run_timeout' });
      return;
    }
    if (error instanceof BridgeError) {
      if (error.code === 'cancelled') {
        this.finish(run, 'cancelled', { reason: 'client_cancelled' });
        return;
      }
      if (error.code === 'timeout') {
        this.deps.metrics.inc('agent_degraded_total', 'Agent 降级次数', { reason: 'first_token_timeout' });
        this.finish(run, 'timeout', {
          reason: 'first_token_timeout',
          message: `${error.message}；已中止本次运行，可重试或改用手工模板`,
        });
        return;
      }
      this.finishFromBridgeError(run, error.code, error.message, error.retryable);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.finishFromBridgeError(run, 'dsh_unavailable', `DSH Host 调用失败：${message}`, true);
  }

  private finishFromBridgeError(
    run: RunRecord,
    code: string,
    message: string,
    retryable?: boolean,
    nextAction?: string,
  ): void {
    const info = errorInfo(code, message, retryable === true);
    if (nextAction) info.next_action = nextAction;
    const status: RunStatus = code === 'timeout' ? 'timeout' : 'failed';
    if (code === 'dsh_unavailable' || code === 'upstream_5xx') {
      this.deps.metrics.inc('agent_degraded_total', 'Agent 降级次数', { reason: code });
    }
    run.error = info;
    this.finish(run, status, { reason: code });
  }

  private finish(
    run: RunRecord,
    status: RunStatus,
    options: { reason?: string; message?: string; durationMs?: number } = {},
  ): void {
    if (run.terminal) return;
    run.status = status;
    run.endedAt = this.now();
    run.queuePosition = null;
    this.clearRunTimer(run);
    this.clearQueueTimer(run);
    this.clearForceCancelTimer(run);
    run.controller?.abort(new Error(`finished:${status}`));
    const durationMs = options.durationMs ?? Math.max(0, run.endedAt - (run.startedAt ?? run.createdAt));

    if (status !== 'succeeded' && status !== 'cancelled' && !run.error) {
      run.error = errorInfo(
        status === 'timeout' ? 'timeout' : 'internal_error',
        options.message ?? (status === 'timeout' ? '运行超时' : '运行失败'),
      );
    }
    if (!run.startedEventEmitted && (status === 'succeeded' || status === 'cancelled')) {
      this.emitStarted(run);
    }
    if (status === 'succeeded' || status === 'cancelled') {
      this.emitTerminal(run, 'run.finished', {
        run_id: run.runId,
        status,
        output: {
          text: run.outputText,
          artifacts: run.artifacts,
          partial: status === 'cancelled',
        },
        tokens: { in: run.tokens.in, out: run.tokens.out },
        cost_cents: run.costCents,
        duration_ms: durationMs,
        ...(options.reason ? { reason: options.reason } : {}),
      });
    } else {
      const info =
        run.error ??
        errorInfo(
          status === 'timeout' ? 'timeout' : 'internal_error',
          options.message ?? (status === 'timeout' ? '运行超时' : '运行失败'),
        );
      run.error = info;
      this.emitTerminal(run, 'run.error', {
        run_id: run.runId,
        code: info.code,
        message: info.message,
        retryable: info.retryable,
        next_action: info.next_action,
        ...(options.reason ? { reason: options.reason } : {}),
      });
    }

    run.terminal = true;
    run.terminalEmitted = true;
    run.subscribers.clear();
    this.gate.release(run.runId);
    this.deps.metrics.inc('agent_runs_total', 'Agent 运行总数', { status, intent: run.intent });
    this.deps.metrics.observe(
      'agent_duration_seconds',
      'Agent 运行时长（秒）',
      { intent: run.intent, status },
      durationMs / 1000,
    );
    if (run.costCents > 0) {
      this.deps.metrics.inc('agent_cost_cents_total', 'Agent 成本（分）', { intent: run.intent }, run.costCents);
    }
    this.deps.metrics.set('agent_active_runs', 'Agent 运行中数量', {}, this.gate.activeCount());
    this.deps.metrics.set('agent_queue_depth', 'Agent 排队数量', {}, this.gate.queueDepth());
    void this.auditTerminal(run, status, durationMs);

    run.retentionTimer = setTimeout(() => {
      if (run.terminal) this.runs.delete(run.runId);
    }, this.deps.config.agentRunRetentionMs);
    run.retentionTimer.unref?.();
  }

  private clearRunTimers(run: RunRecord): void {
    this.clearRunTimer(run);
    this.clearQueueTimer(run);
    this.clearForceCancelTimer(run);
  }

  private clearRunTimer(run: RunRecord): void {
    if (run.runTimer) clearTimeout(run.runTimer);
    run.runTimer = null;
  }

  private clearQueueTimer(run: RunRecord): void {
    if (run.queueTimer) clearTimeout(run.queueTimer);
    run.queueTimer = null;
  }

  private clearForceCancelTimer(run: RunRecord): void {
    if (run.forceCancelTimer) clearTimeout(run.forceCancelTimer);
    run.forceCancelTimer = null;
  }

  private async onQueueTimeout(run: RunRecord): Promise<void> {
    if (run.terminal || run.status !== 'queued') return;
    this.gate.removeQueued(run.runId);
    run.queuePosition = null;
    run.status = 'failed';
    run.endedAt = this.now();
    run.error = errorInfo('quota', `排队超过 ${Math.round(this.deps.config.agentQueueWaitMs / 1000)}s 仍未执行，已取消（不无限排队）`);
    run.error.retryable = true;
    this.deps.metrics.inc('agent_degraded_total', 'Agent 降级次数', { reason: 'queue_timeout' });
    this.emitTerminal(run, 'run.error', {
      run_id: run.runId,
      code: 'quota',
      message: run.error.message,
      retryable: true,
      next_action: 'retry_later',
    });
    run.terminal = true;
    run.subscribers.clear();
    this.deps.metrics.inc('agent_runs_total', 'Agent 运行总数', { status: 'failed', intent: run.intent });
    void this.auditTerminal(run, 'failed', 0);
    run.retentionTimer = setTimeout(() => {
      if (run.terminal) this.runs.delete(run.runId);
    }, this.deps.config.agentRunRetentionMs);
    run.retentionTimer.unref?.();
    this.deps.metrics.set('agent_queue_depth', 'Agent 排队数量', {}, this.gate.queueDepth());
  }

  private drainQueue(): void {
    if (this.closed) return;
    for (;;) {
      const ticket = this.gate.dequeue();
      if (!ticket) return;
      const run = this.runs.get(ticket.runId);
      if (!run || run.terminal || run.status !== 'queued') {
        this.gate.release(ticket.runId);
        continue;
      }
      this.clearQueueTimer(run);
      run.queuePosition = null;
      this.startExecution(run);
    }
  }

  private emitStarted(run: RunRecord): void {
    if (run.startedEventEmitted || run.terminal) return;
    run.startedEventEmitted = true;
    this.emit(run, 'run.started', {
      run_id: run.runId,
      model_id: run.modelId,
      started_at: new Date(run.startedAt ?? this.now()).toISOString(),
      ...(run.sessionId ? { session_id: run.sessionId } : {}),
      ...(run.bundleVersion ? { bundle_version: run.bundleVersion } : {}),
    });
  }

  private emit(run: RunRecord, type: PublicEventType, payload: Record<string, unknown>): void {
    this.emitInternal(run, type, payload, false);
  }

  private emitTerminal(run: RunRecord, type: PublicEventType, payload: Record<string, unknown>): void {
    if (run.terminalEmitted) return;
    this.emitInternal(run, type, payload, true);
  }

  private emitInternal(
    run: RunRecord,
    type: PublicEventType,
    payload: Record<string, unknown>,
    terminal: boolean,
  ): void {
    if (run.terminal && !terminal) return;
    if (terminal && run.terminalEmitted) return;
    run.nextSeq += 1;
    const event: BufferedPublicEvent = {
      seq: run.nextSeq,
      type,
      payload,
      ts: new Date(this.now()).toISOString(),
      eventId: `${run.runId}-${String(run.nextSeq).padStart(EVENT_SEQ_PAD, '0')}`,
    };
    run.events.push(event);
    if (run.events.length > MAX_BUFFERED_EVENTS) {
      run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
    }
    for (const listener of run.subscribers) {
      try {
        listener(event);
      } catch (error) {
        this.log?.warn({ err: error, run_id: run.runId }, 'agent SSE subscriber failed');
      }
    }
  }

  private parseLastEventSeq(run: RunRecord, lastEventId: string | null): number | null {
    if (!lastEventId) return null;
    const match = /-(\d{1,12})$/.exec(lastEventId);
    if (!match) return null;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    // 其它 run 的事件 id：按缺口处理，回放全部。
    if (!lastEventId.startsWith(`${run.runId}-`)) return -1;
    return seq;
  }

  private partialRef(run: RunRecord): string | null {
    if (!run.outputText) return null;
    return `mem://agent-runs/${run.runId}/partial.txt`;
  }

  private toView(run: RunRecord): AgentRunView {
    return {
      run_id: run.runId,
      status: run.status,
      intent: run.intent,
      steps: [...run.steps.values()].sort((a, b) => a.seq - b.seq),
      output: {
        text: run.outputText,
        artifacts: run.artifacts,
        partial: run.status === 'cancelled',
      },
      error: run.error,
      tokens: { in: run.tokens.in, out: run.tokens.out },
      cost_cents: run.costCents,
      started_at: run.startedAt === null ? null : new Date(run.startedAt).toISOString(),
      ended_at: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
      created_at: new Date(run.createdAt).toISOString(),
      expires_at: new Date(
        (run.endedAt ?? run.createdAt) + this.deps.config.agentRunRetentionMs,
      ).toISOString(),
      request_id: run.requestId,
      queue_position: run.queuePosition,
      model_id: run.modelId,
      bundle_version: run.bundleVersion,
      session_key: run.sessionKey,
    };
  }

  // ---------------------------------------------------------------------------
  // 审计
  // ---------------------------------------------------------------------------

  private async safeAudit(input: AuditRecordInput): Promise<void> {
    try {
      await this.deps.audit.record(input);
    } catch (error) {
      this.deps.metrics.inc('agent_degraded_total', 'Agent 降级次数', { reason: 'audit_failed' });
      this.log?.warn({ err: error, action: input.action }, 'agent audit write failed');
    }
  }

  private async auditAccept(run: RunRecord): Promise<void> {
    await this.safeAudit({
      action: 'agent.accept',
      actorType: 'user',
      actorId: run.userId,
      requestId: run.requestId,
      resourceType: 'agent_run',
      resourceId: run.runId,
      orgId: run.orgId,
      before: {},
      after: {
        status: run.status,
        intent: run.intent,
        role: run.role,
        queue_position: run.queuePosition,
        tools: run.tools,
      },
      meta: {
        run_id: run.runId,
        intent: run.intent,
        actor_role: run.role,
        preset: run.envelope.bundle.preset,
        bundle_version: run.bundleVersion,
        manifest_hash: run.envelope.bundle.manifestHash,
        skills: run.envelope.bundle.skills,
        tools_ignored: run.toolsIgnored,
        timeout_ms: run.timeoutMs,
        session_key: run.sessionKey,
        facts_snapshot: run.envelope.facts,
      },
    });
  }

  private async auditTerminal(run: RunRecord, status: RunStatus, durationMs: number): Promise<void> {
    await this.safeAudit({
      action: 'agent.run',
      actorType: 'user',
      actorId: run.userId,
      requestId: run.requestId,
      resourceType: 'agent_run',
      resourceId: run.runId,
      orgId: run.orgId,
      before: {},
      after: {
        status,
        intent: run.intent,
        tokens: { in: run.tokens.in, out: run.tokens.out },
        cost_cents: run.costCents,
        duration_ms: durationMs,
        cancelled: status === 'cancelled',
        error_code: run.error?.code ?? null,
      },
      meta: {
        run_id: run.runId,
        intent: run.intent,
        actor_role: run.role,
        preset: run.envelope.bundle.preset,
        bundle_version: run.bundleVersion,
        model_id: run.modelId,
        dsh_session: run.sessionId,
        result: status,
        cancelled: status === 'cancelled',
        degraded: status === 'failed' || status === 'timeout' || status === 'cancelled',
        first_token_ms: run.firstTokenMs,
        tools: run.tools,
        tools_ignored: run.toolsIgnored,
      },
    });
  }

  private async auditCancel(
    run: RunRecord,
    actor: Pick<RunActor, 'userId' | 'requestId' | 'ip' | 'userAgent' | 'orgId'>,
    reason: string | null,
  ): Promise<void> {
    await this.safeAudit({
      action: 'agent.cancel',
      actorType: 'user',
      actorId: actor.userId,
      requestId: actor.requestId,
      resourceType: 'agent_run',
      resourceId: run.runId,
      orgId: actor.orgId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      before: { status: run.status },
      after: { status: 'cancelled' },
      meta: { run_id: run.runId, intent: run.intent, reason: reason ?? 'user_cancelled' },
    });
  }

  private async auditOverload(input: {
    actor: Pick<RunActor, 'userId' | 'requestId' | 'ip' | 'userAgent' | 'orgId'>;
    reason: string;
    intent: AgentIntent;
    role: Role;
    queueDepth?: number;
  }): Promise<void> {
    await this.safeAudit({
      action: 'agent.overload',
      actorType: 'user',
      actorId: input.actor.userId,
      requestId: input.actor.requestId,
      resourceType: 'agent_gate',
      resourceId: null,
      orgId: input.actor.orgId,
      ip: input.actor.ip,
      userAgent: input.actor.userAgent,
      before: {},
      after: { rejected: true, reason: input.reason, intent: input.intent, role: input.role },
      meta: {
        reason: input.reason,
        intent: input.intent,
        queue_depth: input.queueDepth ?? this.gate.queueDepth(),
        active: this.gate.activeCount(),
      },
    });
  }

  private async auditUnavailable(
    actor: Pick<RunActor, 'userId' | 'requestId' | 'ip' | 'userAgent' | 'orgId'>,
    intent: AgentIntent,
    error: { code: string; message: string; detail?: unknown } | null,
  ): Promise<void> {
    await this.safeAudit({
      action: 'agent.unavailable',
      actorType: 'user',
      actorId: actor.userId,
      requestId: actor.requestId,
      resourceType: 'dsh_host',
      resourceId: null,
      orgId: actor.orgId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      before: {},
      after: { available: false, intent, code: error?.code ?? 'dsh_unavailable' },
      meta: {
        intent,
        bridge_url: this.deps.config.dshBridgeUrl,
        error: error ?? null,
      },
    });
  }
}
