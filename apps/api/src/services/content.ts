/** 文案草稿生成（M3）：只改写措辞，事实由主数据预装进 facts 信封（docs/08 §0）。 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { factsForJudge, type FactEnvelope } from '@dssaas/core';
import type { ModelGateway } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';
import { buildProductFacts } from './facts.js';

export type ContentType = 'title' | 'selling_points' | 'detail' | 'faq' | 'reply' | 'quote';
const CONTENT_TYPES: ContentType[] = ['title', 'selling_points', 'detail', 'faq', 'reply', 'quote'];

export interface ContentContext {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  ip: string | null;
  userAgent: string | null;
}

export interface ContentDraftInput {
  content_type: ContentType;
  product_id: string;
  platform: 'pdd' | '1688';
  tone?: '专业' | '亲和' | '简洁' | '促销' | '批发';
  constraints?: { length?: number; keywords?: string[]; forbidden?: string[] };
  fact_refs?: string[];
  model_id?: string;
}

export interface ContentDeps {
  prisma: PrismaClient;
  audit: AuditService;
  gateway: ModelGateway;
}

function buildPrompt(
  input: ContentDraftInput,
  product: { name: string; categoryCode: string },
  facts: FactEnvelope,
): string {
  const factsJson = JSON.stringify(factsForJudge(facts));
  return [
    '你是服装电商文案助手。只能使用 facts 中的事实，不得编造价格/库存/成分/尺码/政策。',
    `平台：${input.platform}；内容类型：${input.content_type}；语气：${input.tone ?? '专业'}`,
    `商品：${product.name}（类目 ${product.categoryCode}）`,
    `facts：${factsJson}`,
    input.constraints?.length ? `字数上限：${input.constraints.length}` : '',
    input.constraints?.keywords?.length ? `需包含关键词：${input.constraints.keywords.join('、')}` : '',
    input.constraints?.forbidden?.length ? `禁止出现：${input.constraints.forbidden.join('、')}` : '',
    '请直接输出文案正文，不要解释。',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function createContentDraft(
  deps: ContentDeps,
  input: ContentDraftInput,
  context: ContentContext,
) {
  if (!CONTENT_TYPES.includes(input.content_type)) {
    throw new ApiError('validation_failed', 'content_type 非法', { detail: { field: 'content_type' } });
  }
  const product = await deps.prisma.product.findFirst({
    where: { id: input.product_id, archivedAt: null },
    select: { id: true, name: true, categoryCode: true },
  });
  if (!product) throw new ApiError('not_found', '商品不存在');

  const facts = await buildProductFacts(deps.prisma, input.product_id);
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
    purpose: 'copy',
    requestId: context.requestId,
    actorType: 'user',
    actorId: context.userId,
    subjectType: 'content_draft',
    params: {
      prompt: buildPrompt(input, product, facts),
      temperature: 0.3,
    },
    estimate: { tokensIn: 1200, tokensOut: 500 },
  });
  const body = (result.response.text ?? '').trim();
  if (body.length === 0) {
    throw new ApiError('upstream_5xx', '文案模型返回空内容');
  }
  if (body.length > 20000) {
    throw new ApiError('validation_failed', '生成文案超过 20000 字符，请拆分内容类型', {
      detail: { field: 'body', actual: body.length },
    });
  }

  const draft = await deps.prisma.contentDraft.create({
    data: {
      orgId: 1n,
      productId: product.id,
      platform: input.platform,
      contentType: input.content_type,
      title: input.content_type === 'title' ? body.slice(0, 200) : null,
      body,
      structured: {},
      facts: facts as unknown as Prisma.InputJsonValue,
      factCheck: {},
      status: 'generated',
      modelCallId: result.callLogId,
      promptVersion: 'copy@1.0.0',
      tone: input.tone ?? null,
      wordCount: [...body].length,
      riskFlags: [],
      createdBy: context.userId,
    },
  });

  await deps.audit.record({
    action: 'content.draft.create',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'content_draft',
    resourceId: draft.id,
    after: {
      content_type: input.content_type,
      platform: input.platform,
      product_id: product.id,
      model_call_id: result.callLogId,
      facts_hash: facts.facts_hash,
      word_count: [...body].length,
    },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });

  return {
    draft_id: draft.id,
    content: body,
    fact_refs: input.fact_refs ?? [],
    status: 'drafted' as const,
    judgment_pending: true,
    facts_hash: facts.facts_hash,
    model_call_id: result.callLogId,
  };
}

export async function listContentDrafts(
  deps: ContentDeps,
  query: { product_id?: string; platform?: string; status?: string; created_by?: string; limit: number; cursor?: string },
) {
  const where: Prisma.ContentDraftWhereInput = { orgId: 1n, archivedAt: null };
  if (query.product_id) where.productId = query.product_id;
  if (query.platform) where.platform = query.platform;
  if (query.status) where.status = query.status;
  if (query.created_by) where.createdBy = query.created_by;
  if (query.cursor) where.id = { lt: query.cursor };
  const rows = await deps.prisma.contentDraft.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((row) => ({
      id: row.id,
      content_type: row.contentType,
      product_id: row.productId,
      platform: row.platform,
      status: row.status,
      verdict: null,
      updated_at: row.updatedAt.toISOString(),
      cost_cents: 0,
    })),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  };
}

export async function getContentDraft(deps: ContentDeps, id: string) {
  const row = await deps.prisma.contentDraft.findFirst({
    where: { id, archivedAt: null },
  });
  if (!row) throw new ApiError('not_found', '草稿不存在');
  const judgments = await deps.prisma.judgment.findMany({
    where: { subjectType: 'content_draft', subjectId: id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, status: true, verdict: true, severity: true, createdAt: true },
  });
  return {
    id: row.id,
    content_type: row.contentType,
    content: row.body,
    title: row.title,
    platform: row.platform,
    status: row.status,
    facts: row.facts,
    fact_check: row.factCheck,
    judge_id: row.judgeId,
    risks: row.riskFlags,
    judgments: judgments.map((judgment) => ({
      id: judgment.id,
      status: judgment.status,
      verdict: judgment.verdict,
      severity: judgment.severity,
      created_at: judgment.createdAt.toISOString(),
    })),
  };
}
