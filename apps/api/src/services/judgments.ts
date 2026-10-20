/**
 * 判断层编排（M3）：facts 校验 → L1 →（blocker 短路）→ 证据加载 → L2 → 后置校验 → 合并 → 落库。
 *
 * 关键纪律（docs/08 §0/§8/§11）：
 * - 硬事实不许模型生成；facts_hash 与当前主数据不一致直接 422 invalid_fact；
 * - L1 blocker 不调 L2（成本 0）；
 * - 无证据不调 L2，直接 escalate；L2 输出无引用/引用不可解析/低置信 → escalate；
 * - L2 永不单独放行：最终 verdict 只是进入审批的输入。
 */
import { Prisma, type PrismaClient } from '@dssaas/db';
import {
  JUDGE_PROMPT_VERSION,
  LEXICON_VERSION,
  RULE_SET_VERSION,
  escalateOutput,
  mergeJudgments,
  renderJudgePrompt,
  runL1,
  validateL2Output,
  type EvidenceRef,
  type JudgeContentType,
  type L1Result,
  type L2Output,
  type MergedVerdict,
  type Platform,
  type Verdict,
} from '@dssaas/judge-rules';
import { validateFactEnvelope, type FactEnvelope } from '@dssaas/core';
import type { ModelGateway } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { buildJudgeFacts, buildProductFacts, loadEvidence, verifyFactsAgainstMaster } from './facts.js';

export interface JudgmentContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export interface JudgmentRequestInput {
  subject_type: 'content_draft' | 'message' | 'media_asset' | 'listing' | 'quote' | 'kb_answer';
  subject_id: string;
  platform: Platform;
  content_type: JudgeContentType;
  text?: string;
  facts?: FactEnvelope;
  run?: 'L1' | 'L2' | 'L1+L2';
}

export interface L2CallResult {
  raw: string;
  modelCallId: string | null;
  costCents: number;
  latencyMs: number;
}

export type L2Runner = (input: {
  prompt: string;
  requestId: string;
  context: JudgmentContext;
  attempt: number;
}) => Promise<L2CallResult>;

export interface JudgmentDeps {
  prisma: PrismaClient;
  audit: AuditService;
  gateway?: ModelGateway;
  /** t22 知识库：为 L2 补政策/规则/FAQ 软证据。 */
  knowledge?: Pick<KnowledgeService, 'resolveEvidence'>;
  l2Runner?: L2Runner;
  now?: () => Date;
}

export interface JudgmentResponse {
  judgment_id: string;
  status: string;
  verdict: Verdict;
  severity: string;
  reason: string | null;
  repair_hint: string | null;
  evidence_refs: EvidenceRef[];
  rule_hits: L1Result['hits'];
  l1: L1Result;
  l2: L2Output | null;
  versions: { rule_set: string; lexicon: string; prompt: string };
  cost_cents: number;
  latency_ms: number;
  escalated: boolean;
  short_circuit?: string;
  facts_hash: string;
}

function statusForVerdict(verdict: Verdict): string {
  switch (verdict) {
    case 'pass':
      return 'passed';
    case 'needs_revision':
      return 'needs_revision';
    case 'reject':
      return 'rejected';
    default:
      return 'escalated';
  }
}

async function loadDraft(prisma: PrismaClient, subjectId: string) {
  const draft = await prisma.contentDraft.findFirst({
    where: { id: subjectId, archivedAt: null },
  });
  if (!draft) throw new ApiError('not_found', '内容草稿不存在');
  return draft;
}

async function resolveInput(
  deps: JudgmentDeps,
  input: JudgmentRequestInput,
): Promise<{ text: string; facts: FactEnvelope; productId: string | null }> {
  if (input.subject_type === 'content_draft') {
    const draft = await loadDraft(deps.prisma, input.subject_id);
    const facts = (input.facts ?? (draft.facts as unknown as FactEnvelope)) as FactEnvelope;
    const storedHash = (draft.facts as { facts_hash?: string } | null)?.facts_hash;
    if (input.facts && storedHash && input.facts.facts_hash !== storedHash) {
      throw new ApiError('invalid_fact', 'facts 与草稿绑定的事实快照不一致', {
        detail: { expected_hash: storedHash, actual_hash: input.facts.facts_hash },
      });
    }
    return {
      text: input.text ?? draft.body,
      facts,
      productId: draft.productId,
    };
  }
  if (!input.text || input.text.trim().length === 0) {
    throw new ApiError('validation_failed', '非草稿对象必须提供 text', {
      detail: { field: 'text' },
    });
  }
  if (!input.facts) {
    throw new ApiError('invalid_fact', '缺少 facts（事实信封）', { detail: { field: 'facts' } });
  }
  return { text: input.text, facts: input.facts, productId: null };
}

async function defaultL2Runner(deps: JudgmentDeps): Promise<L2Runner> {
  return async ({ prompt, requestId, context }) => {
    if (!deps.gateway) throw new Error('no_route');
    const role = await deps.prisma.role.findFirst({
      where: { code: context.role, orgId: 1n, archivedAt: null },
      select: { id: true },
    });
    const result = await deps.gateway.invoke({
      principal: {
        orgId: 1,
        userId: context.userId,
        roles: [context.role],
        roleIds: role ? [role.id] : [],
      },
      purpose: 'judge',
      requestId,
      actorType: 'user',
      actorId: context.userId,
      subjectType: 'judgment',
      params: { prompt, temperature: 0 },
      estimate: { tokensIn: Math.min(3000, prompt.length), tokensOut: 800 },
    });
    return {
      raw: result.response.text ?? '',
      modelCallId: result.callLogId,
      costCents: result.costCents,
      latencyMs: result.latencyMs,
    };
  };
}

export async function createJudgment(
  deps: JudgmentDeps,
  input: JudgmentRequestInput,
  context: JudgmentContext,
): Promise<JudgmentResponse> {
  const run = input.run ?? 'L1+L2';
  const now = deps.now?.() ?? new Date();
  const { text, facts, productId } = await resolveInput(deps, input);

  const factsValidation = validateFactEnvelope(facts);
  if (!factsValidation.ok) {
    throw new ApiError('invalid_fact', 'facts 信封非法', {
      detail: { issues: factsValidation.issues },
    });
  }
  if (productId) {
    const verification = await verifyFactsAgainstMaster(deps.prisma, productId, facts);
    if (!verification.ok) {
      throw new ApiError('invalid_fact', 'facts_hash 与当前主数据不一致（事实已变更）', {
        detail: { expected_hash: verification.expectedHash, actual_hash: facts.facts_hash },
      });
    }
  }

  const judgeFacts = await buildJudgeFacts(deps.prisma, productId, facts);
  const l1 = runL1({
    platform: input.platform,
    content_type: input.content_type,
    text,
    facts: judgeFacts,
    as_of: now.toISOString(),
  });

  let l2: L2Output | null = null;
  let merged: MergedVerdict | undefined;
  let shortCircuit: string | undefined;
  let costCents = 0;
  let latencyMs = l1.duration_ms;
  let modelCallId: string | null = null;

  if (run === 'L1' || l1.blocked || l1.errors.length > 0) {
    merged = mergeJudgments(l1, null);
    shortCircuit = l1.blocked ? 'L1_BLOCKER' : run === 'L1' ? 'L2_SKIPPED' : 'L1_ERROR';
    if (l1.errors.length > 0) {
      merged = {
        verdict: 'escalate',
        severity: 'high',
        reason: `L1 规则执行异常：${l1.errors.map((error) => error.rule_id).join(',')}`,
        repair_hint: '转 L3 人工复核',
        evidence_refs: [],
      };
    }
  } else {
    const factEvidence = await loadEvidence(deps.prisma, facts, context.role, now);
    let softEvidence: EvidenceRef[] = [];
    if (deps.knowledge && text.trim().length > 0) {
      try {
        const kb = await deps.knowledge.resolveEvidence(
          `${text}\n${input.content_type} ${input.platform}`,
          {
            role: context.role,
            k: 5,
            domains: ['policy', 'platform'],
            asOf: now,
            requestId: context.requestId,
            actorId: context.userId,
          },
        );
        softEvidence = kb.evidence_refs.map((citation) => ({
          doc_id: citation.doc_id,
          chunk_id: citation.chunk_id,
          doc_version: citation.doc_version,
          quote: citation.quote,
          effective_from: citation.effective_from,
          source: 'kb' as const,
        }));
      } catch {
        // 知识库不可用时保留事实证据链；软证据缺失会走 escalate，不静默放行。
        softEvidence = [];
      }
    }
    const seenChunks = new Set<string>();
    const evidence: EvidenceRef[] = [];
    for (const ref of [...factEvidence, ...softEvidence]) {
      const normalized: EvidenceRef = { ...ref, source: ref.source ?? 'kb' };
      if (seenChunks.has(normalized.chunk_id)) continue;
      seenChunks.add(normalized.chunk_id);
      evidence.push(normalized);
    }
    if (evidence.length === 0) {
      merged = mergeJudgments(l1, escalateOutput('no_evidence_available'), { noEvidence: true });
      merged.short_circuit = 'NO_EVIDENCE';
      shortCircuit = 'NO_EVIDENCE';
    } else {
      const runner = deps.l2Runner ?? (await defaultL2Runner(deps));
      const prompt = renderJudgePrompt({
        input: {
          platform: input.platform,
          content_type: input.content_type,
          text,
          facts: judgeFacts,
          as_of: now.toISOString(),
        },
        l1Hits: l1.hits.map((hit) => ({
          rule_id: hit.rule_id,
          severity: hit.severity,
          matched: hit.matched,
        })),
        evidence,
      });
      let raw = '';
      let validation;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const result = await runner({ prompt, requestId: context.requestId, context, attempt });
          costCents += result.costCents;
          latencyMs += result.latencyMs;
          modelCallId = result.modelCallId ?? modelCallId;
          raw = result.raw;
          validation = validateL2Output(raw, evidence, { requireCitation: evidence.length > 0 });
          if (validation.ok) break;
          if (attempt === 1 && ['schema_invalid', 'missing_evidence'].includes(validation.reason)) {
            continue;
          }
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          validation = { ok: false as const, reason: 'schema_invalid' as const };
          merged = mergeJudgments(l1, escalateOutput(`l2_call_failed:${message}`));
          shortCircuit = 'L2_FAILED';
          break;
        }
      }
      if (!merged) {
        if (validation?.ok) {
          l2 = validation.output;
          merged = mergeJudgments(l1, l2);
        } else {
          const reason =
            validation && !validation.ok ? validation.reason : 'schema_invalid';
          merged = mergeJudgments(l1, escalateOutput(reason));
          shortCircuit = `L2_${reason.toUpperCase()}`;
        }
      }
    }
  }

  const verdict = merged!.verdict;
  const status = statusForVerdict(verdict);
  const judgment = await deps.prisma.judgment.create({
    data: {
      orgId: 1n,
      subjectType: input.subject_type,
      subjectId: input.subject_id,
      platform: input.platform,
      contentType: input.content_type,
      status,
      verdict,
      severity: merged!.severity,
      l1Result: l1 as unknown as Prisma.InputJsonValue,
      l1HitRuleIds: l1.hits.map((hit) => hit.rule_id),
      l2Result: l2 ? (l2 as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      evidenceRefs: merged!.evidence_refs as unknown as Prisma.InputJsonValue,
      reason: merged!.reason.slice(0, 2000),
      repairHint: merged!.repair_hint ? merged!.repair_hint.slice(0, 1000) : null,
      modelCallId,
      ruleSetVersion: RULE_SET_VERSION,
      lexiconVersion: LEXICON_VERSION,
      promptVersion: JUDGE_PROMPT_VERSION,
      factsHash: facts.facts_hash,
      costCents,
      latencyMs,
      appealStatus: 'none',
      escalated: verdict === 'escalate',
      createdBy: context.userId,
    },
  });

  if (input.subject_type === 'content_draft') {
    await deps.prisma.contentDraft.update({
      where: { id: input.subject_id },
      data: {
        status: verdict === 'reject' ? 'rejected' : verdict === 'needs_revision' ? 'needs_revision' : 'judged',
        judgeId: judgment.id,
        riskFlags: l1.hits.map((hit) => hit.rule_id),
        factCheck: l1 as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await deps.audit.record({
    action: 'judgment.create',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'judgment',
    resourceId: judgment.id,
    after: {
      verdict,
      severity: merged!.severity,
      short_circuit: shortCircuit ?? null,
      l1_hits: l1.hits.map((hit) => hit.rule_id),
      facts_hash: facts.facts_hash,
    },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role, subject_type: input.subject_type, subject_id: input.subject_id },
  });

  return {
    judgment_id: judgment.id,
    status,
    verdict,
    severity: merged!.severity,
    reason: merged!.reason,
    repair_hint: merged!.repair_hint || null,
    evidence_refs: merged!.evidence_refs,
    rule_hits: l1.hits,
    l1,
    l2,
    versions: {
      rule_set: RULE_SET_VERSION,
      lexicon: LEXICON_VERSION,
      prompt: JUDGE_PROMPT_VERSION,
    },
    cost_cents: costCents,
    latency_ms: latencyMs,
    escalated: verdict === 'escalate',
    ...(shortCircuit ? { short_circuit: shortCircuit } : {}),
    facts_hash: facts.facts_hash,
  };
}

export async function getJudgment(deps: JudgmentDeps, id: string) {
  const row = await deps.prisma.judgment.findFirst({ where: { id, archivedAt: null } });
  if (!row) throw new ApiError('not_found', '判定记录不存在');
  return {
    id: row.id,
    subject_type: row.subjectType,
    subject_id: row.subjectId,
    platform: row.platform,
    content_type: row.contentType,
    status: row.status,
    verdict: row.verdict,
    severity: row.severity,
    reason: row.reason,
    repair_hint: row.repairHint,
    evidence_refs: row.evidenceRefs,
    rule_hits: (row.l1Result as { hits?: unknown[] } | null)?.hits ?? [],
    l1_result: row.l1Result,
    l2_result: row.l2Result,
    l1_hit_rule_ids: row.l1HitRuleIds,
    rule_set_version: row.ruleSetVersion,
    lexicon_version: row.lexiconVersion,
    prompt_version: row.promptVersion,
    facts_hash: row.factsHash,
    cost_cents: row.costCents,
    latency_ms: row.latencyMs,
    escalated: row.escalated,
    appeal_status: row.appealStatus,
    appeal_reason: row.appealReason,
    final_verdict: row.finalVerdict,
    created_at: row.createdAt.toISOString(),
  };
}

export async function appealJudgment(
  deps: JudgmentDeps,
  id: string,
  reason: string,
  context: JudgmentContext,
): Promise<{ id: string; appeal_status: string }> {
  if (context.role === 'viewer') {
    throw new ApiError('forbidden', 'viewer 不能申诉');
  }
  if (reason.trim().length < 10) {
    throw new ApiError('validation_failed', '申诉理由至少 10 字', { detail: { field: 'reason' } });
  }
  const row = await deps.prisma.judgment.findFirst({ where: { id, archivedAt: null } });
  if (!row) throw new ApiError('not_found', '判定记录不存在');
  if (row.severity === 'blocker') {
    throw new ApiError('forbidden', 'blocker 级禁词命中不可申诉，只能改内容重判');
  }
  if (row.appealStatus !== 'none') {
    throw new ApiError('conflict', '同一判定最多申诉 1 次', { detail: { appeal_status: row.appealStatus } });
  }
  const now = deps.now?.() ?? new Date();
  if (now.getTime() - row.createdAt.getTime() > 24 * 3600 * 1000) {
    throw new ApiError('conflict', '判定已超过 24h，不受理申诉');
  }
  await deps.prisma.judgment.update({
    where: { id },
    data: {
      appealStatus: 'requested',
      appealReason: reason,
      appealedBy: context.userId,
      appealedAt: now,
    },
  });
  await deps.audit.record({
    action: 'judgment.appeal',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'judgment',
    resourceId: id,
    before: { appeal_status: row.appealStatus },
    after: { appeal_status: 'requested', reason },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return { id, appeal_status: 'requested' };
}

export async function reviewAppeal(
  deps: JudgmentDeps,
  id: string,
  input: { decision: 'upheld' | 'overridden'; final_verdict?: Verdict; note: string },
  context: JudgmentContext,
): Promise<{ id: string; appeal_status: string; status: string; final_verdict: Verdict | null }> {
  if (context.role !== 'admin') throw new ApiError('forbidden', '仅 admin 可复核申诉');
  const row = await deps.prisma.judgment.findFirst({ where: { id, archivedAt: null } });
  if (!row) throw new ApiError('not_found', '判定记录不存在');
  if (row.appealStatus !== 'requested') {
    throw new ApiError('conflict', '该判定没有待复核申诉', { detail: { appeal_status: row.appealStatus } });
  }
  if (input.decision === 'overridden' && !input.final_verdict) {
    throw new ApiError('validation_failed', '改判必须提供 final_verdict', {
      detail: { field: 'final_verdict' },
    });
  }
  const finalVerdict = input.decision === 'overridden' ? input.final_verdict! : (row.verdict as Verdict);
  const nextStatus =
    input.decision === 'upheld'
      ? row.status
      : statusForVerdict(finalVerdict);
  await deps.prisma.judgment.update({
    where: { id },
    data: {
      appealStatus: input.decision === 'upheld' ? 'upheld' : 'overridden',
      reviewedBy: context.userId,
      reviewedAt: deps.now?.() ?? new Date(),
      finalVerdict: input.decision === 'overridden' ? finalVerdict : row.finalVerdict,
      status: nextStatus,
      ...(input.decision === 'overridden' ? { verdict: finalVerdict } : {}),
    },
  });
  await deps.audit.record({
    action: 'judgment.appeal_review',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'judgment',
    resourceId: id,
    before: { appeal_status: 'requested', status: row.status },
    after: { appeal_status: input.decision, status: nextStatus, final_verdict: finalVerdict, note: input.note },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return {
    id,
    appeal_status: input.decision,
    status: nextStatus,
    final_verdict: input.decision === 'overridden' ? finalVerdict : (row.finalVerdict as Verdict | null),
  };
}

export async function buildFactsForContent(
  deps: JudgmentDeps,
  productId: string,
): Promise<FactEnvelope> {
  return buildProductFacts(deps.prisma, productId);
}
