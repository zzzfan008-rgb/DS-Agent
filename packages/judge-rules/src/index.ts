/**
 * @dssaas/judge-rules —— 判断层规则集、L2 Schema 与合并逻辑（M3）。
 *
 * - L1：确定性规则（禁限词、价格/库存/成分/尺码/政策硬事实、标题结构），
 *   每条命中带 rule_id + span（原文偏移）+ matched + suggestion；
 *   否定语境（「不能承诺当天发货」）命中降级为 info 并标 negated（见 negation.ts）；
 * - L2：JudgmentV1 JSON Schema + 后置校验（证据白名单、引用逐字、无引用升级、置信度）；
 * - 合并：L1 blocker 短路 reject；L1 high/medium 不得被 L2 降为 pass；escalate 优先。
 */
export const JUDGE_RULES_PACKAGE = '@dssaas/judge-rules';

export * from './types.js';
export * from './normalize.js';
export * from './negation.js';
export * from './l1.js';
export * from './l2.js';
export * from './merge.js';
export * from './prompt.js';
