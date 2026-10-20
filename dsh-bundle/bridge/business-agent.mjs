/**
 * business-agent.mjs —— 真实 DSH Host 内的业务 Agent Remote service（t18 开发版）。
 *
 * 与 `business-agent.ts`（参考实现）相比，本文件是**可在真实 Host 里加载的运行时实现**：
 *   - 通过 `TypertRemoteService` 注册 `businessAgent` 服务、`run(env, signal)` 为 stream Remote 方法；
 *   - 直接使用 Host 的 sessionController（create / prompt / cancel）驱动真实 agent loop；
 *   - 监听 `agent/assistant-stream`（文本增量）与 `session/event`（turn/step/tool/usage）映射为
 *     `AgentEvent`（docs/17 §3.2 左列），由 business-bridge 写入 SSE。
 *
 * 「不写装饰器、不用编译」：Node 24 不执行 TS 装饰器语法，这里用公开的 `Remote()` 装饰器工厂
 * 配合一个最小合法的 decorator context 在实例构造时打标记；只依赖 `@deepseek-ai/dsh-typert-protocol`
 * 的公开导出（通过 dsh-bundle/bridge/node_modules junction 解析到 Host 同一份包实例）。
 *
 * 边界：这是 **dev 联调实现**，不是 M3 生产版：
 *   - 会话不经 Redis 归属映射（每次 run 新建 session；由 t3 的 api 侧 sessionKey 负责归属）；
 *   - 成本为按 token 的估算值（价格可配），不是 model_call_log 的真实计价；
 *   - 不实现 need_input 澄清（业务 preset 也没有提问工具）。
 */

import { appendFileSync } from 'node:fs';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { loadInjectedSkills } from './skill-injection.mjs';

const INTENT_ROLES = {
  'content.draft': ['operator', 'admin'],
  'content.rewrite': ['operator', 'admin'],
  'product.qa': ['operator', 'admin'],
  'support.suggest': ['operator', 'admin'],
  'inquiry.quote_draft': ['operator', 'admin'],
  'listing.diagnose': ['admin'],
};

const INTENT_TOOLS = {
  'content.draft': ['kb.search', 'product.read', 'content.draft'],
  'content.rewrite': ['kb.search', 'product.read', 'content.draft'],
  'product.qa': ['kb.search', 'product.read'],
  'support.suggest': ['kb.search', 'conversation.read', 'reply.suggest'],
  'inquiry.quote_draft': ['kb.search', 'product.read', 'quote.draft'],
  'listing.diagnose': ['kb.search', 'listing.read', 'platform.rules'],
};

/** 用公开 Remote() 装饰器工厂在实例上打 stream 方法标记（避免 TS 装饰器语法）。 */
function streamMethodInitializer(method) {
  let initializer;
  const context = {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    access: { has: () => false, get: () => undefined },
    addInitializer(fn) {
      initializer = fn;
    },
  };
  Remote({ mode: 'stream' })(undefined, context);
  if (typeof initializer !== 'function') throw new Error('business-agent: Remote() 未注册 initializer');
  return initializer;
}

const markRunAsRemoteStream = streamMethodInitializer('run');

function textOfBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function reasoningWanted(config, intent) {
  return Boolean(config?.reasoningEffort?.[intent] ?? config?.defaultReasoningEffort);
}

function debugRecord(config, record) {
  const file = config?.skillInjection?.debugFile;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}
`, 'utf8');
  } catch {
    // 调试日志失败不影响运行
  }
}

function buildPrompt(env, skillText = '') {
  const lines = [`意图：${env.intent}`];
  if (env.context?.page) lines.push(`页面：${env.context.page}`);
  if (env.context?.objectType) lines.push(`对象：${env.context.objectType}${env.context.objectId ? `/${env.context.objectId}` : ''}`);
  if (skillText) lines.push(skillText.trim());
  if (env.input?.text) lines.push(`用户输入：${env.input.text}`);
  if (env.input?.params && Object.keys(env.input.params).length > 0) {
    lines.push(`参数：${JSON.stringify(env.input.params).slice(0, 2000)}`);
  }
  lines.push('请直接用中文给出最终结果，不要复述本说明，不要输出思考过程。');
  return lines.join('\n');
}

export class BusinessAgentService extends TypertRemoteService {
  static inject = ['agents', 'sessionController', 'sessionProjections'];

  constructor(ctx, config = {}) {
    super(ctx, 'businessAgent', { namespace: 'businessAgent' });
    markRunAsRemoteStream.call(this);
    this.config = config;
  }

  /** 真实 Host 上的流式运行：sessionController.create → prompt → 事件映射。 */
  async *run(env, signal) {
    const startedAt = Date.now();
    const roles = INTENT_ROLES[env?.intent] ?? [];
    if (!roles.includes(env?.role)) {
      yield { type: 'error', code: 'forbidden', message: `role=${env?.role} 不能发起 intent=${env?.intent}`, retryable: false, nextAction: 'contact_admin' };
      return;
    }
    const allowedTools = new Set(INTENT_TOOLS[env.intent] ?? []);
    const deniedTool = (env.toolsAllow ?? []).find((tool) => !allowedTools.has(tool));
    if (deniedTool) {
      yield { type: 'error', code: 'remote-access/denied', message: `tool not allowed: ${deniedTool}`, retryable: false, nextAction: 'contact_admin' };
      return;
    }

    const config = this.config ?? {};
    const cwd = config.cwd ?? process.cwd();
    const preset = env.bundle?.preset ?? config.preset ?? 'clothing-ops';

    // F1：业务意图（默认 support.suggest）把 skill 正文前置注入，省掉 tool-skill 往返。
    // 不注入时保持原工具加载路径（探索/管理型会话可自行调用 skill）。
    let skillInjection = null;
    let skillInjectionError = null;
    try {
      skillInjection = loadInjectedSkills(env.intent, config.skillInjection ?? {});
    } catch (error) {
      skillInjectionError = error instanceof Error ? error.message : String(error);
    }

    let sessionId;
    try {
      const created = await this.ctx.sessionController.create({ cwd, agentPreset: preset });
      sessionId = created.sessionId;
    } catch (error) {
      yield {
        type: 'error',
        code: 'dsh_unavailable',
        message: `创建 Host 会话失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        nextAction: 'retry_later',
      };
      return;
    }

    let modelId = config.modelLabel ?? 'deepseek-flash';
    let providerId = null;
    const bundleVersion = config.bundleVersion ?? 'host-1.0.0';
    try {
      const session = this.ctx.agents.get(sessionId)?.session ?? this.ctx.sessions?.get(sessionId);
      const selection = session ? this.ctx.sessionProjections?.stateOf?.(session, 'modelSelection') : undefined;
      modelId = selection?.next?.model ?? selection?.lastUsed?.model ?? modelId;
      providerId = selection?.next?.provider ?? selection?.lastUsed?.provider ?? null;
    } catch {
      // 投影不可用时用配置兜底
    }
    if (reasoningWanted(config, env.intent) && !providerId) {
      try {
        const catalog = await this.ctx.sessionController.modelCatalog();
        const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
        const group = groups.find((item) => Array.isArray(item.models) && item.models.some((model) => model.id === modelId));
        providerId = group?.id ?? null;
      } catch (error) {
        debugRecord(config, {
          runId: env.runId,
          event: 'model-catalog-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // F1 延迟：客服 reply_draft 不需要 deep reasoning；把 reasoningEffort 降到 off/low，
    // 否则 deepseek-flash 默认 high 会先做隐藏思考，首 token 仍 >5s（实测见验收记录）。
    const reasoningEffort = config.reasoningEffort?.[env.intent] ?? config.defaultReasoningEffort;
    if (reasoningEffort && providerId && modelId) {
      try {
        await this.ctx.sessionController.selectModel({
          sessionId,
          provider: providerId,
          model: modelId,
          reasoningEffort,
        });
      } catch (error) {
        debugRecord(config, {
          runId: env.runId,
          event: 'select-model-error',
          reasoningEffort,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    debugRecord(config, {
      runId: env.runId,
      event: 'model-selection',
      providerId,
      modelId,
      reasoningEffort: reasoningEffort ?? null,
    });

    debugRecord(config, {
      runId: env.runId,
      intent: env.intent,
      injection: skillInjection
        ? { skills: skillInjection.skills, bytes: skillInjection.bytes, tokens: skillInjection.tokens_estimate }
        : null,
      injectionError: skillInjectionError,
      promptChars: buildPrompt(env, skillInjection?.text ?? '').length,
      promptPreview: buildPrompt(env, skillInjection?.text ?? '').slice(0, 600),
    });

    yield {
      type: 'meta',
      runId: env.runId,
      sessionId,
      bundleVersion,
      modelId,
      skillInjection: skillInjection
        ? {
            mode: 'preinjected',
            skills: skillInjection.skills,
            bytes: skillInjection.bytes,
            tokens_estimate: skillInjection.tokens_estimate,
          }
        : { mode: 'tool', error: skillInjectionError },
    };

    const queue = [];
    let notify = null;
    let ending = false;
    let assistantText = '';
    let finalText = '';
    let usage = null;
    let turnEndReason = null;
    let startedTurn = false;
    const toolNames = new Map();

    const push = (item) => {
      queue.push(item);
      const resume = notify;
      notify = null;
      resume?.();
    };
    const onAssistantStream = ({ agent, frame }) => {
      if (agent?.session?.id !== sessionId) return;
      if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
        push({ kind: 'delta', text: frame.chunk.text });
      }
    };
    const onSessionEvent = (session, event) => {
      if (session?.id !== sessionId) return;
      const stepSeq = (event.data?.turn ?? 1) * 100 + (event.data?.step ?? 1);
      switch (event.type) {
        case 'turn/start':
          startedTurn = true;
          break;
        case 'step/start':
          push({ kind: 'step', status: 'running', seq: stepSeq, turn: event.data?.turn, step: event.data?.step });
          break;
        case 'step/end':
          push({ kind: 'step', status: 'done', seq: stepSeq, turn: event.data?.turn, step: event.data?.step });
          break;
        case 'tool/call': {
          const callId = event.data?.callId ?? 'tool';
          if (event.data?.name) toolNames.set(callId, event.data.name);
          debugRecord(config, {
            runId: env.runId,
            event: 'tool/call',
            callId,
            name: event.data?.name ?? null,
            arguments: event.data?.arguments ?? null,
          });
          push({ kind: 'tool_call', tool: event.data?.name ?? callId, argsSummary: JSON.stringify(event.data?.arguments ?? {}).slice(0, 500) });
          break;
        }
        case 'tool/result': {
          const callId = event.data?.message?.callId ?? 'tool';
          push({
            kind: 'tool_result',
            tool: toolNames.get(callId) ?? callId,
            ok: event.data?.message?.isError !== true,
            summary: textOfBlocks(event.data?.message?.content).slice(0, 500),
          });
          break;
        }
        case 'assistant/message': {
          const blocksText = textOfBlocks(event.data?.message?.content);
          if (blocksText) finalText = blocksText;
          if (event.data?.usage) usage = event.data.usage;
          break;
        }
        case 'turn/end':
          turnEndReason = event.data?.reason ?? null;
          ending = true;
          push({ kind: 'end' });
          break;
        default:
          break;
      }
    };

    const offStream = this.ctx.on('agent/assistant-stream', onAssistantStream, { global: true });
    const offEvent = this.ctx.on('session/event', onSessionEvent, { global: true });
    const onAbort = () => {
      const resume = notify;
      notify = null;
      resume?.();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.ctx.sessionController.prompt(
        {
          sessionId,
          requestId: env.requestId ?? env.runId,
          mode: 'queue',
          content: [{ type: 'text', text: buildPrompt(env, skillInjection?.text ?? '') }],
        },
        signal,
      );

      let seq = 0;
      while (!signal.aborted) {
        if (queue.length === 0) {
          if (ending) break;
          await new Promise((resolve) => {
            notify = resolve;
            const timer = setTimeout(resolve, 500);
            timer.unref?.();
          });
          continue;
        }
        const item = queue.shift();
        if (item.kind === 'end') break;
        if (item.kind === 'delta') {
          assistantText += item.text;
          yield { type: 'delta', text: item.text };
        } else if (item.kind === 'step') {
          yield {
            type: 'step',
            seq: item.seq,
            name: `agent.${item.turn ?? 1}.${item.step ?? 1}`,
            status: item.status,
            ...(item.status === 'done' ? { summary: `turn ${item.turn ?? 1} step ${item.step ?? 1} 完成` } : {}),
          };
        } else if (item.kind === 'tool_call') {
          yield { type: 'tool_call', tool: item.tool ?? 'unknown', ...(item.argsSummary ? { argsSummary: item.argsSummary } : {}) };
        } else if (item.kind === 'tool_result') {
          yield { type: 'tool_result', tool: item.tool ?? 'tool', ok: item.ok === true, ...(item.summary ? { summary: item.summary } : {}) };
        }
      }

      if (signal.aborted) {
        await this.cancelQuietly(sessionId);
        return;
      }

      if (turnEndReason && turnEndReason.kind === 'error') {
        yield {
          type: 'error',
          code: 'upstream_5xx',
          message: turnEndReason.error?.message ?? 'Host agent turn 失败',
          retryable: true,
          nextAction: 'retry_later',
        };
        return;
      }
      if (turnEndReason && turnEndReason.kind === 'aborted') {
        return;
      }

      // usage 优先取 durable assistant/message 的 usage；缺失时读会话投影的 tokenUsage。
      let inputTokens = 0;
      let outputTokens = 0;
      if (usage) {
        inputTokens = numberOrZero(usage.uncachedInputTokens ?? usage.inputTokens ?? usage.input);
        outputTokens = numberOrZero(usage.outputTokens ?? usage.output);
      } else {
        try {
          const session = this.ctx.agents.get(sessionId)?.session ?? this.ctx.sessions?.get(sessionId);
          const tokenUsage = session ? this.ctx.sessionProjections?.stateOf?.(session, 'tokenUsage') : undefined;
          if (tokenUsage) {
            inputTokens = numberOrZero(tokenUsage.uncachedInputTokens) + numberOrZero(tokenUsage.cacheReadTokens) + numberOrZero(tokenUsage.cacheWriteTokens);
            outputTokens = numberOrZero(tokenUsage.outputTokens);
          }
        } catch {
          // 保留 0
        }
      }
      const priceIn = numberOrZero(config.priceInCentsPer1k ?? 1);
      const priceOut = numberOrZero(config.priceOutCentsPer1k ?? 2);
      const costCents = Math.ceil((inputTokens / 1000) * priceIn + (outputTokens / 1000) * priceOut);
      yield { type: 'usage', inputTokens, outputTokens, costCents };

      const text = assistantText || finalText;
      yield {
        type: 'final',
        output: { text, artifacts: [] },
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      if (signal.aborted) {
        await this.cancelQuietly(sessionId);
        return;
      }
      yield {
        type: 'error',
        code: 'dsh_unavailable',
        message: `Host agent 调用失败：${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
        nextAction: 'retry_later',
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      offStream();
      offEvent();
      if (signal.aborted) await this.cancelQuietly(sessionId);
    }
  }

  async cancelQuietly(sessionId) {
    try {
      await this.ctx.sessionController.cancel({ sessionId });
    } catch {
      // 会话已结束/已取消，忽略
    }
  }
}

export default BusinessAgentService;
export const name = 'business-agent';
export const inject = BusinessAgentService.inject;
