/**
 * dsh-bundle/bridge/business-agent.ts —— 业务 Agent 的 Typert Remote service（**参考实现，M3 落地**）。
 *
 * 本文件不属于 M1 编译范围（dsh-bundle 不参与 pnpm workspace typecheck），
 * 但它是 docs/17 §3.1 的可执行化骨架：M3 接入真实 Host 时按此实现并升 bundle 版本。
 *
 * 只使用公共扩展点：
 *   - `@deepseek-ai/dsh-typert-protocol` 的 `Remote` / `TypertRemoteService`（公开包根导出）；
 *   - 不 import 深路径（`/dist`、`/lib`、`/src`），不 fork 内部包（docs/04 Z1/Z2）。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export type AgentIntent =
  | 'content.draft'
  | 'content.rewrite'
  | 'product.qa'
  | 'support.suggest'
  | 'inquiry.quote_draft'
  | 'listing.diagnose';

export interface AgentRunEnvelope {
  runId: string;
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  intent: AgentIntent;
  context: { page: string; objectType?: string; objectId?: string };
  input: { text?: string; params?: Record<string, unknown> };
  facts: { snapshotId: string | null; hash: string | null; version: number };
  bundle: { preset: string; skills: string[]; manifestHash: string };
  toolsAllow?: string[];
  limits: { timeoutMs: number; maxOutputTokens: number; maxToolCalls: number; maxCostCents: number };
}

export type AgentEvent =
  | { type: 'queued'; position: number }
  | { type: 'meta'; runId: string; sessionId: string; bundleVersion: string; modelId: string }
  | { type: 'step'; seq: number; name: string; status: 'running' | 'done' | 'failed'; summary?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; tool: string; argsSummary?: string }
  | { type: 'tool_result'; tool: string; ok: boolean; summary?: string }
  | { type: 'need_input'; question: string; options: string[] }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costCents: number }
  | { type: 'final'; output: { text: string; artifacts: unknown[] }; durationMs: number }
  | { type: 'error'; code: string; message: string; retryable: boolean; nextAction: string };

const INTENT_ROLES: Record<AgentIntent, ReadonlyArray<AgentRunEnvelope['role']>> = {
  'content.draft': ['operator', 'admin'],
  'content.rewrite': ['operator', 'admin'],
  'product.qa': ['operator', 'admin'],
  'support.suggest': ['operator', 'admin'],
  'inquiry.quote_draft': ['operator', 'admin'],
  'listing.diagnose': ['admin'],
};

/** 预设工具集（与 apps/api/src/agent/intents.ts 保持一致；Host 侧再校验一次）。 */
const INTENT_TOOLS: Record<AgentIntent, ReadonlySet<string>> = {
  'content.draft': new Set(['kb.search', 'product.read', 'content.draft']),
  'content.rewrite': new Set(['kb.search', 'product.read', 'content.draft']),
  'product.qa': new Set(['kb.search', 'product.read']),
  'support.suggest': new Set(['kb.search', 'conversation.read', 'reply.suggest']),
  'inquiry.quote_draft': new Set(['kb.search', 'product.read', 'quote.draft']),
  'listing.diagnose': new Set(['kb.search', 'listing.read', 'platform.rules']),
};

export class BusinessAgentService extends TypertRemoteService {
  constructor(ctx: ConstructorParameters<typeof TypertRemoteService>[0]) {
    super(ctx, 'businessAgent', { namespace: 'businessAgent' });
  }

  /**
   * 执行一次业务 Agent 运行。`signal` 必须是最后一个 Host 参数（wire 上不存在），
   * 由 Gateway 在解码后的业务参数之后注入（docs/17 §3.1）。
   */
  @Remote({ mode: 'stream' })
  async *run(env: AgentRunEnvelope, signal: AbortSignal): AsyncIterable<AgentEvent> {
    // 1) Host 侧再校验 role × intent（防 api 被攻破后越权）。
    const roles = INTENT_ROLES[env.intent];
    if (!roles || !roles.includes(env.role)) {
      yield {
        type: 'error',
        code: 'forbidden',
        message: `role=${env.role} 不能发起 intent=${env.intent}`,
        retryable: false,
        nextAction: 'contact_admin',
      };
      return;
    }
    // 2) toolsAllow 只能收窄：出现集合外工具 → 直接拒绝（api 已忽略，但 Host 不信任）。
    const allowed = INTENT_TOOLS[env.intent];
    const deniedTool = (env.toolsAllow ?? []).find((tool) => !allowed.has(tool));
    if (deniedTool) {
      yield {
        type: 'error',
        code: 'remote-access/denied',
        message: `tool not allowed: ${deniedTool}`,
        retryable: false,
        nextAction: 'contact_admin',
      };
      return;
    }
    // 3) 会话/上下文：按 docs/17 §5 的 sessionKey 取会话；事实块只读。
    //    真实实现（M3）：
    //      const session = await this.ctx.get('agentSessions').resolve(env);
    //      const agent = this.ctx.get('agent'); // 按 deployment 的 agent loop 组装
    //      for await (const event of agent.run(...)) { if (signal.aborted) return; yield map(event); }
    //
    // 4) 本骨架只发一个占位事件流，便于 IDE 类型检查与契约对齐；不得用于生产。
    yield {
      type: 'meta',
      runId: env.runId,
      sessionId: `todo-${env.runId}`,
      bundleVersion: '1.0.0',
      modelId: 'unconfigured',
    };
    if (signal.aborted) return;
    yield {
      type: 'error',
      code: 'dsh_unavailable',
      message: 'business-agent 参考实现未接入真实 agent loop（M3）',
      retryable: true,
      nextAction: 'retry_later',
    };
  }
}
