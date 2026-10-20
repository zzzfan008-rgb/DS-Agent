/**
 * intent 白名单、角色 × intent、默认工具集与单次运行限额（docs/17 §6.2、docs/12 §8.1）。
 *
 * 这里是 api 侧策略执行点的一部分：Host 侧还会再校验一次（纵深防御），
 * 但 api 必须先做角色与 intent 的判定，未通过不进桥接。
 */
import type { Role } from '@dssaas/core';
import { sha256Hex } from '../lib/ids.js';
import { AGENT_INTENTS, type AgentIntent } from './types.js';

export interface IntentRule {
  /** 允许发起该 intent 的最低业务角色之外的显式清单（viewer 永不发起 run）。 */
  roles: readonly Role[];
  /** 默认工具集（只能被 tools_allow 收窄，不能扩权）。 */
  tools: readonly string[];
  modelRoute: string;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxCostCents: number;
}

export const INTENT_RULES: Record<AgentIntent, IntentRule> = {
  'content.draft': {
    roles: ['operator', 'admin'],
    tools: ['kb.search', 'product.read', 'content.draft'],
    modelRoute: 'copy-default',
    maxOutputTokens: 4000,
    maxToolCalls: 8,
    maxCostCents: 200,
  },
  'content.rewrite': {
    roles: ['operator', 'admin'],
    tools: ['kb.search', 'product.read', 'content.draft'],
    modelRoute: 'copy-default',
    maxOutputTokens: 4000,
    maxToolCalls: 8,
    maxCostCents: 200,
  },
  'product.qa': {
    roles: ['operator', 'admin'],
    tools: ['kb.search', 'product.read'],
    modelRoute: 'qa-default',
    maxOutputTokens: 4000,
    maxToolCalls: 8,
    maxCostCents: 100,
  },
  'support.suggest': {
    roles: ['operator', 'admin'],
    tools: ['kb.search', 'conversation.read', 'reply.suggest'],
    modelRoute: 'reply-default',
    maxOutputTokens: 4000,
    maxToolCalls: 8,
    maxCostCents: 100,
  },
  'inquiry.quote_draft': {
    roles: ['operator', 'admin'],
    tools: ['kb.search', 'product.read', 'quote.draft'],
    modelRoute: 'copy-default',
    maxOutputTokens: 4000,
    maxToolCalls: 8,
    maxCostCents: 200,
  },
  'listing.diagnose': {
    roles: ['admin'],
    tools: ['kb.search', 'listing.read', 'platform.rules'],
    modelRoute: 'diagnose-default',
    maxOutputTokens: 8000,
    maxToolCalls: 8,
    maxCostCents: 500,
  },
};

export function ruleForIntent(intent: AgentIntent): IntentRule {
  return INTENT_RULES[intent];
}

export function roleCanRunIntent(role: Role, intent: AgentIntent): boolean {
  return INTENT_RULES[intent].roles.includes(role);
}

export interface NarrowedTools {
  /** 实际下发给 Host 的工具白名单（默认集与请求集的交集）。 */
  tools: string[];
  /** 请求里越权/未知、被忽略并审计的项。 */
  ignored: string[];
}

/**
 * `tools_allow` 只能收窄预设工具集；越权项忽略并审计（docs/12 §8.1），不报错也不扩权。
 * 传 undefined 表示使用 intent 默认工具集。
 */
export function narrowTools(intent: AgentIntent, requested: readonly string[] | undefined): NarrowedTools {
  const allowed = new Set(INTENT_RULES[intent].tools);
  if (requested === undefined) return { tools: [...INTENT_RULES[intent].tools], ignored: [] };
  const tools: string[] = [];
  const ignored: string[] = [];
  for (const tool of requested) {
    if (allowed.has(tool)) {
      if (!tools.includes(tool)) tools.push(tool);
    } else {
      ignored.push(tool);
    }
  }
  return { tools, ignored };
}

/**
 * 会话键：sha256("v1|" + org_id + "|" + user_id + "|" + intent + "|" + objectType + "|" +
 * objectId + "|" + objectVersion)（docs/17 §5.1）。
 *
 * M1 尚未接入事实快照服务，objectVersion 取 facts.version（0）；lib 层先保证算法与拼接顺序固定，
 * t8/t9 提供真实版本号后无需改这里。
 */
export function sessionKeyOf(input: {
  orgId: number | bigint;
  userId: string;
  intent: AgentIntent;
  objectType?: string | null;
  objectId?: string | null;
  objectVersion?: number | null;
}): string {
  const canonical = [
    'v1',
    String(input.orgId),
    input.userId,
    input.intent,
    input.objectType ?? '',
    input.objectId ?? '',
    input.objectVersion === null || input.objectVersion === undefined ? '0' : String(input.objectVersion),
  ].join('|');
  return sha256Hex(canonical);
}

export const INTENT_LIST: readonly AgentIntent[] = AGENT_INTENTS;
