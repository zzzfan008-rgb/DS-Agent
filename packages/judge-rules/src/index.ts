/**
 * @dssaas/judge-rules —— 判断层规则集与提示词版本库（M1 空壳）。
 *
 * L1 确定性规则（禁限词、字段完整性、价格一致性、类目资质必填）落在这里；
 * L2 LLM 裁决的固定 JSON Schema（verdict / severity / reason / evidence_refs / repair_hint）
 * 与提示词版本也在这里维护，保证可复现、可回溯。
 */
export const JUDGE_RULES_PACKAGE = '@dssaas/judge-rules';
