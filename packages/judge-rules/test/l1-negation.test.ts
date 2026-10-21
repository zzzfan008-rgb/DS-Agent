/**
 * L1 否定语境判定测试（t42 质量对照收尾）。
 *
 * 背景：docs/42-F1质量对照.md §三 记录了两处「裸字符串匹配把正确拒绝话术判成违规」：
 *   - A05「不能直接按『七天无理由』答复」→ 误报 L1-POL-001
 *   - L01「不能承诺当天发货」→ 误报 L1-POL-002
 *
 * 本文件固化三类断言：
 *   1) 4 条拒绝话术 → 不判违规（无 blocker/high/medium 命中）；
 *   2) 4 条真承诺 → 仍判违规；
 *   3) 2 条边界样本 → 明确判定并给出理由；
 *   4) A05 / L01 原始输出回归（取自 apps/api/test/agent-quality-off.json）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectNegation, NEGATION_MARKERS } from '../src/negation.js';
import { normalizeText } from '../src/normalize.js';
import { l1HighestSeverity, runL1 } from '../src/l1.js';
import type { JudgeInput, L1Hit, L1Result, Severity } from '../src/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const QUALITY_OFF = path.join(REPO_ROOT, 'apps/api/test/agent-quality-off.json');

/** 判定为「违规」的严重度门槛：blocker / high / medium 都算；info / low 不算。 */
const VIOLATION_SEVERITIES = new Set<Severity>(['blocker', 'high', 'medium']);

function judge(overrides: Partial<JudgeInput> & Pick<JudgeInput, 'text'>): L1Result {
  return runL1({
    platform: overrides.platform ?? 'pdd',
    content_type: overrides.content_type ?? 'reply',
    text: overrides.text,
    facts: overrides.facts ?? { lead_time_days: 2 },
    as_of: overrides.as_of,
  });
}

function violations(result: L1Result): L1Hit[] {
  return result.hits.filter((hit) => VIOLATION_SEVERITIES.has(hit.severity));
}

function negatedHits(result: L1Result): L1Hit[] {
  return result.hits.filter((hit) => hit.negated === true);
}

function explain(result: L1Result): string {
  return result.hits
    .map((hit) => `${hit.rule_id}/${hit.severity}/${hit.matched}${hit.negated ? `(否定:${hit.negation_marker})` : ''}`)
    .join(' | ') || '(无命中)';
}

/* ------------------------------------------------------------------ */
/* 1) 拒绝话术：不判违规                                               */
/* ------------------------------------------------------------------ */

test('拒绝话术 1：不能承诺当天发货 → 不判违规（降级 info）', () => {
  const result = judge({ text: '结论：不能承诺当天发货。事实快照里没有发货时效数据，需人工确认。' });
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  assert.equal(result.blocked, false, explain(result));
  const degraded = negatedHits(result);
  assert.ok(degraded.length > 0, `应保留降级记录以便复核，实际 ${explain(result)}`);
  assert.ok(degraded.every((hit) => hit.severity === 'info'));
  assert.ok(degraded.some((hit) => hit.negation_marker === '不能承诺'), explain(result));
});

test('拒绝话术 2：不能直接按「七天无理由」答复 → 不判违规（降级 info）', () => {
  const result = judge({
    text: '结论：不能直接按「七天无理由」答复，需先确认本单是 1688 批发采购单还是零售单。',
  });
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  assert.equal(result.blocked, false, explain(result));
  const degraded = negatedHits(result);
  assert.ok(degraded.length > 0, `应保留降级记录，实际 ${explain(result)}`);
  assert.ok(degraded.every((hit) => hit.severity === 'info'));
});

test('拒绝话术 3：无法保证 24 小时内发货 → 不判违规（降级 info）', () => {
  const result = judge({
    text: '亲，这款目前无法保证 24 小时内发货，实际以仓库截单时间和物流更新为准。',
  });
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  assert.ok(negatedHits(result).length > 0, explain(result));
});

test('拒绝话术 4：不会承诺赔付，也不会承诺补发 → 不判违规（降级 info）', () => {
  const result = judge({
    text: '客服不能承诺赔付金额，也不会承诺补发；补偿需走审批，请留在平台会话内沟通。',
  });
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  assert.equal(result.blocked, false, explain(result));
  assert.ok(negatedHits(result).length > 0, explain(result));
});

/* ------------------------------------------------------------------ */
/* 2) 真承诺：仍判违规（不能因否定判定而漏判）                          */
/* ------------------------------------------------------------------ */

test('真承诺 1：我们保证当天发货 → 仍判违规（high）', () => {
  const result = judge({ text: '我们保证当天发货，下单后 3 小时内出库。' });
  const ruleIds = violations(result).map((hit) => hit.rule_id);
  assert.ok(ruleIds.includes('L1-POL-002'), explain(result));
  assert.equal(result.hits.find((hit) => hit.rule_id === 'L1-POL-002')?.negated, undefined);
});

test('真承诺 2：支持七天无理由，运费我们承担 → 仍判违规（blocker）', () => {
  const result = judge({ text: '支持七天无理由退换，运费我们承担，直接退款。' });
  assert.equal(result.blocked, true, explain(result));
  const pol = result.hits.filter((hit) => hit.rule_id === 'L1-POL-001');
  assert.ok(pol.length > 0, explain(result));
  assert.ok(pol.some((hit) => !hit.negated), explain(result));
});

test('真承诺 3：24 小时内发货 → 仍判违规（high）', () => {
  const result = judge({ text: '今天 18 点前下单，24 小时内发货。' });
  const ruleIds = violations(result).map((hit) => hit.rule_id);
  assert.ok(ruleIds.includes('L1-POL-002'), explain(result));
});

test('真承诺 4：可直接补发并赔付 → 仍判违规（high）', () => {
  const result = judge({ text: '亲，质量问题我们直接补发，并赔付 10 元。' });
  const ruleIds = violations(result).map((hit) => hit.rule_id);
  assert.ok(ruleIds.includes('L1-REP-001'), explain(result));
  assert.equal(result.hits.find((hit) => hit.rule_id === 'L1-REP-001')?.negated, undefined);
});

/* ------------------------------------------------------------------ */
/* 3) 边界样本：明确判定 + 理由                                        */
/* ------------------------------------------------------------------ */

test('边界 1：「不保证当天发货，但一般当天发」→ 判违规（转折后是隐含承诺）', () => {
  const result = judge({ text: '不保证当天发货，但一般当天发。' });
  // 判定：违规。理由：前半句是否定（降级 info），但「但」转折后的「一般当天发」
  // 仍是给客户的可执行预期，等价于软承诺；作用域不跨转折词，因此必须继续命中。
  const pol002 = result.hits.filter((hit) => hit.rule_id === 'L1-POL-002');
  assert.equal(pol002.length, 2, explain(result));
  const [first, second] = pol002 as [L1Hit, L1Hit];
  assert.equal(first.negated, true);
  assert.equal(first.severity, 'info');
  assert.equal(second.negated, undefined);
  assert.equal(second.severity, 'high');
  assert.ok(violations(result).some((hit) => hit.rule_id === 'L1-POL-002'), explain(result));
});

test('边界 2：「当天发货需确认」→ 判违规（否定标记在后缀，前缀判定不覆盖）', () => {
  const result = judge({ text: '当天发货需确认，我这边跟仓库核实后回复您。' });
  // 判定：违规。理由：本实现只做**前缀**否定判定（否定标记必须在命中词之前），
  // 后缀式「需确认」不降级。取舍依据：宁可保留一条待人工复核的命中，
  // 也不让「当天发货…」这类未完成承诺从 blocker 通道漏过（docs/08 §12.3 漏判 0 优先）。
  // 已知局限记录在 docs/42；后续若误杀率上升，再扩到后缀判定并回归黄金集。
  const pol002 = result.hits.filter((hit) => hit.rule_id === 'L1-POL-002');
  assert.equal(pol002.length, 1, explain(result));
  assert.equal(pol002[0]!.negated, undefined);
  assert.equal(pol002[0]!.severity, 'high');
  assert.ok(violations(result).some((hit) => hit.rule_id === 'L1-POL-002'), explain(result));
});

/* ------------------------------------------------------------------ */
/* 4) A05 / L01 原始输出回归（docs/42 §三 的两条误报）                  */
/* ------------------------------------------------------------------ */

interface QualitySample {
  id: string;
  output: string;
}

function qualitySample(id: string): QualitySample {
  const parsed = JSON.parse(readFileSync(QUALITY_OFF, 'utf8')) as { samples: QualitySample[] };
  const sample = parsed.samples.find((item) => item.id === id);
  assert.ok(sample, `agent-quality-off.json 缺少场景 ${id}`);
  assert.ok(sample.output.length > 0, `场景 ${id} 的 output 为空`);
  return sample;
}

test('回归 A05：1688 退换原始输出 → 不再误报 blocker', () => {
  const sample = qualitySample('A05');
  const result = judge({
    platform: '1688',
    content_type: 'reply',
    text: sample.output,
    facts: { lead_time_days: 2 },
  });
  assert.equal(result.blocked, false, explain(result));
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  const degraded = negatedHits(result);
  assert.ok(
    degraded.some((hit) => hit.rule_id === 'L1-POL-001' && hit.negation_marker),
    `应把「七天无理由」降级并记录否定标记，实际 ${explain(result)}`,
  );
});

test('回归 L01：物流原始输出 → 不再误报 blocker', () => {
  const sample = qualitySample('L01');
  const result = judge({ platform: 'pdd', content_type: 'reply', text: sample.output });
  assert.equal(result.blocked, false, explain(result));
  assert.deepEqual(violations(result).map((hit) => hit.rule_id), [], explain(result));
  const pol002 = result.hits.filter((hit) => hit.rule_id === 'L1-POL-002');
  assert.ok(pol002.length > 0, `应命中「当天发货」并降级，实际 ${explain(result)}`);
  assert.ok(pol002.every((hit) => hit.negated === true && hit.severity === 'info'), explain(result));
});

test('回归：A05/L01 两条输出合并判定仍不产生 blocker（误杀率对照基线）', () => {
  const merged = [qualitySample('A05').output, qualitySample('L01').output].join('\n\n');
  const result = judge({ platform: 'pdd', content_type: 'reply', text: merged });
  assert.equal(result.blocked, false, explain(result));
  assert.ok(l1HighestSeverity(result) === 'info' || l1HighestSeverity(result) === 'low', explain(result));
});

/* ------------------------------------------------------------------ */
/* 5) 否定判定单元约束：不漏判、不误判                                  */
/* ------------------------------------------------------------------ */

test('detectNegation：双重否定视为肯定（不能不承诺…）', () => {
  const { normalized } = normalizeText('不能不承诺当天发货');
  const index = normalized.indexOf('当天发货');
  const negation = detectNegation(normalized, index);
  assert.equal(negation.marker_count, 2);
  assert.equal(negation.negated, false);
});

test('detectNegation：非否定用法不算标记（不仅/不但/不得不）', () => {
  for (const text of ['不仅当天发货', '不但当天发货', '不得不当天发货']) {
    const { normalized } = normalizeText(text);
    const negation = detectNegation(normalized, normalized.indexOf('当天发货'));
    assert.equal(negation.negated, false, `${text} 不应被判为否定语境`);
  }
});

test('detectNegation：作用域不跨标点与转折词', () => {
  const { normalized } = normalizeText('不保证当天发货，但一般当天发');
  const first = detectNegation(normalized, normalized.indexOf('当天发货'));
  assert.equal(first.negated, true);
  const second = detectNegation(normalized, normalized.indexOf('当天发', first.marker_index! + 4));
  assert.equal(second.negated, false);
});

test('detectNegation：否定标记清单覆盖任务约定的 10 个标记', () => {
  const required = [
    '不', '不能', '无法', '不可', '不会', '禁止', '不得', '无法保证', '暂不支持', '需确认',
  ];
  for (const marker of required) {
    assert.ok(
      (NEGATION_MARKERS as readonly string[]).includes(marker),
      `否定标记清单缺少「${marker}」`,
    );
  }
});

test('detectNegation：否定标记必须出现在命中词之前，且窗口 10 字内', () => {
  // 窗口内（命中词前 2 字）
  const near = normalizeText('不能当天发货').normalized;
  assert.equal(detectNegation(near, near.indexOf('当天发货')).negated, true);
  // 超出窗口（前面隔了 12 个非边界字符）
  const far = normalizeText('不能一二三四五六七八九十甲乙当天发货').normalized;
  assert.equal(detectNegation(far, far.indexOf('当天发货')).negated, false);
});

test('否定判定不改变 L0 绝对禁词的严重度（平台机审不识别否定语境）', () => {
  const result = judge({
    content_type: 'detail',
    text: '不能使用「全网最低」这种表述，我们也不刷单。',
  });
  // L0 类（LEX-001/LEX-007）不参与否定降级：文案里出现即违规，必须改写。
  const ruleIds = result.hits.map((hit) => hit.rule_id);
  assert.ok(ruleIds.includes('L1-LEX-001'), explain(result));
  assert.ok(ruleIds.includes('L1-LEX-007'), explain(result));
  const lex001 = result.hits.find((hit) => hit.rule_id === 'L1-LEX-001')!;
  assert.equal(lex001.negated, undefined);
  assert.equal(lex001.severity, 'blocker');
});
