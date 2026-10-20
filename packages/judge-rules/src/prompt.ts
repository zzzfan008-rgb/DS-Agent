/** L2 提示词（docs/08 §7.2 的六段结构，M3 精简版；版本号固定）。 */
import type { EvidenceRef, JudgeInput } from './types.js';
import { JUDGE_PROMPT_VERSION } from './types.js';

export interface JudgePromptInput {
  input: JudgeInput;
  l1Hits: Array<{ rule_id: string; severity: string; matched: string }>;
  evidence: EvidenceRef[];
}

export function renderJudgePrompt(prompt: JudgePromptInput): string {
  const facts = JSON.stringify(prompt.input.facts, null, 0);
  const evidence = prompt.evidence
    .map(
      (ref) =>
        `- chunk_id=${ref.chunk_id} doc_id=${ref.doc_id} version=${ref.doc_version} quote=${ref.quote}`,
    )
    .join('\n');
  return [
    'P1 角色与禁令：你是服装电商文案合规判定器。不产生事实、不改写事实、不臆测。',
    'P2 输入定义：platform/content_type/text/l1_hits/facts/evidence。',
    `P3 证据使用：只能引用下列证据；reject/needs_revision 必带引用；引用须逐字摘录；无证据→escalate。\n${evidence || '(无可用证据)'}`,
    'P4 判定标准：检查夸大宣传、功效暗示、售后承诺越界、场景与尺码话术；硬事实以 facts 为准。',
    'P5 输出契约：只输出 JudgmentV1 JSON（verdict/severity/reason/repair_hint/evidence_refs/confidence）。',
    'P6 示例：{"verdict":"pass","severity":"low","reason":"未发现违规","repair_hint":"无需修改","evidence_refs":[]}',
    '',
    `[platform] ${prompt.input.platform}`,
    `[content_type] ${prompt.input.content_type}`,
    `[text]\n${prompt.input.text}`,
    `[facts] ${facts}`,
    `[l1_hits] ${JSON.stringify(prompt.l1Hits)}`,
    `[prompt_version] ${JUDGE_PROMPT_VERSION}`,
  ].join('\n');
}
