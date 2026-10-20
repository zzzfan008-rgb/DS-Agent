/**
 * 话术模板库（docs/18 §3.3）：平台+意图确定性匹配，weight/最近更新排序；无候选用内置集。
 *
 * schema 缺口：reply_template 无 name/category/priority/usage_count/last_used_at/approved_at/
 * effective_from/to；当前用 intent+platform+content+status+weight 承载，name 为派生值。
 */
import type { Prisma, PrismaClient } from '@dssaas/db';
import { ApiError } from '../lib/errors.js';
import type { AuditService } from './audit.js';

export const TEMPLATE_INTENTS = [
  'general',
  'size',
  'logistics',
  'returns',
  'quote',
  'moq',
  'material',
  'payment',
] as const;

export interface TemplateView {
  id: string;
  name: string;
  intent: string;
  text: string;
  platform: string;
  status: string;
  version: number;
  weight: number;
  approved_at: string | null;
  builtin: boolean;
}

const BUILTIN: Array<{ platform: 'pdd' | '1688'; intent: string; text: string }> = [
  { platform: 'pdd', intent: 'general', text: '您好，我在的，请问有什么可以帮您？' },
  { platform: 'pdd', intent: 'size', text: '麻烦提供一下身高体重，我按尺码表帮您推荐，建议以实际测量为准。' },
  { platform: 'pdd', intent: 'logistics', text: '我帮您查一下物流，发货后一般 2–4 天送达，具体以物流更新为准。' },
  { platform: 'pdd', intent: 'returns', text: '支持 7 天无理由退换，请保持吊牌完整，我帮您走售后流程。' },
  { platform: 'pdd', intent: 'material', text: '面料成分以商品详情页标注为准，我可以帮您核对具体批次。' },
  { platform: '1688', intent: 'general', text: '您好，欢迎咨询，请告知需要的款式、数量和地区，我给您报方案。' },
  { platform: '1688', intent: 'quote', text: '报价会按数量和规格核算，我先确认数量与收货地区，再给您阶梯价。' },
  { platform: '1688', intent: 'moq', text: '起批量按款式不同，常规 2 件起批，可混批；具体以商品起批设置为准。' },
  { platform: '1688', intent: 'material', text: '面料成分和克重可提供检测报告，具体以实际批次为准。' },
  { platform: '1688', intent: 'logistics', text: '交期按库存与数量确认，常规 3–7 天，偏远地区另议。' },
];

function deriveName(row: { platform: string; intent: string; id: string }): string {
  return `${row.platform}:${row.intent}:${row.id.slice(0, 8)}`;
}

function mapRow(row: {
  id: string;
  platform: string;
  intent: string;
  content: string;
  status: string;
  weight: number;
  version: number;
  updatedAt: Date;
}): TemplateView {
  return {
    id: row.id,
    name: deriveName(row),
    intent: row.intent,
    text: row.content,
    platform: row.platform,
    status: row.status,
    version: row.version,
    weight: row.weight,
    approved_at: row.status === 'approved' ? row.updatedAt.toISOString() : null,
    builtin: false,
  };
}

function builtinTemplates(platform: string, intent: string, limit: number): TemplateView[] {
  const exact = BUILTIN.filter((row) => row.platform === platform && row.intent === intent);
  const general = BUILTIN.filter((row) => row.platform === platform && row.intent === 'general');
  return [...exact, ...general]
    .slice(0, limit)
    .map((row, index) => ({
      id: `builtin:${platform}:${row.intent}:${index}`,
      name: `builtin:${platform}:${row.intent}`,
      intent: row.intent,
      text: row.text,
      platform,
      status: 'approved',
      version: 1,
      weight: 0,
      approved_at: null,
      builtin: true,
    }));
}

export async function listTemplates(
  prisma: PrismaClient,
  query: { platform?: string; intent?: string; q?: string; limit: number },
): Promise<{ items: TemplateView[] }> {
  const where: Prisma.ReplyTemplateWhereInput = { orgId: 1n, archivedAt: null };
  if (query.platform) where.platform = query.platform;
  if (query.intent) where.intent = query.intent;
  if (query.q) where.content = { contains: query.q };
  const rows = await prisma.replyTemplate.findMany({
    where,
    orderBy: [{ weight: 'desc' }, { updatedAt: 'desc' }],
    take: query.limit,
  });
  return { items: rows.map(mapRow) };
}

export async function selectFallbackTemplates(
  prisma: PrismaClient,
  input: { platform: string; intent: string; limit: number },
): Promise<TemplateView[]> {
  const rows = await prisma.replyTemplate.findMany({
    where: {
      orgId: 1n,
      archivedAt: null,
      platform: input.platform,
      status: 'approved',
      intent: { in: [input.intent, 'general'] },
    },
    orderBy: [{ weight: 'desc' }, { updatedAt: 'desc' }],
    take: input.limit,
  });
  if (rows.length > 0) return rows.map(mapRow);
  return builtinTemplates(input.platform, input.intent, input.limit);
}

export interface TemplateContext {
  requestId: string;
  userId: string;
  role: string;
  ip: string | null;
  userAgent: string | null;
}

export async function createTemplate(
  deps: { prisma: PrismaClient; audit: AuditService },
  input: {
    name?: string;
    intent: string;
    text: string;
    platform?: 'pdd' | '1688';
    weight?: number;
  },
  context: TemplateContext,
): Promise<TemplateView> {
  if (context.role !== 'admin') throw new ApiError('forbidden', '仅 admin 可维护模板');
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(input.intent)) {
    throw new ApiError('validation_failed', 'intent 必须是 lowercase snake_case', {
      detail: { field: 'intent' },
    });
  }
  if (input.text.trim().length === 0 || input.text.length > 2000) {
    throw new ApiError('validation_failed', 'text 长度必须 1–2000', { detail: { field: 'text' } });
  }
  const row = await deps.prisma.replyTemplate.create({
    data: {
      orgId: 1n,
      platform: input.platform ?? 'pdd',
      intent: input.intent,
      content: input.text,
      status: 'draft',
      weight: input.weight ?? 100,
      createdBy: context.userId,
    },
  });
  await deps.audit.record({
    action: 'reply_template.create',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'reply_template',
    resourceId: row.id,
    after: { intent: row.intent, platform: row.platform, status: row.status, weight: row.weight },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return mapRow(row);
}

export async function patchTemplate(
  deps: { prisma: PrismaClient; audit: AuditService },
  id: string,
  input: { text?: string; intent?: string; status?: 'draft' | 'approved' | 'retired'; weight?: number },
  context: TemplateContext,
): Promise<TemplateView> {
  if (context.role !== 'admin') throw new ApiError('forbidden', '仅 admin 可维护模板');
  const before = await deps.prisma.replyTemplate.findFirst({ where: { id, archivedAt: null } });
  if (!before) throw new ApiError('not_found', '模板不存在');
  if (input.intent !== undefined && !/^[a-z][a-z0-9_]{1,31}$/.test(input.intent)) {
    throw new ApiError('validation_failed', 'intent 必须是 lowercase snake_case', {
      detail: { field: 'intent' },
    });
  }
  if (input.text !== undefined && (input.text.trim().length === 0 || input.text.length > 2000)) {
    throw new ApiError('validation_failed', 'text 长度必须 1–2000', { detail: { field: 'text' } });
  }
  const row = await deps.prisma.replyTemplate.update({
    where: { id },
    data: {
      ...(input.text === undefined ? {} : { content: input.text }),
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.weight === undefined ? {} : { weight: input.weight }),
      version: { increment: 1 },
    },
  });
  await deps.audit.record({
    action: 'reply_template.update',
    actorType: 'user',
    actorId: context.userId,
    requestId: context.requestId,
    resourceType: 'reply_template',
    resourceId: id,
    before: { status: before.status, intent: before.intent, weight: before.weight },
    after: { status: row.status, intent: row.intent, weight: row.weight },
    ip: context.ip,
    userAgent: context.userAgent,
    meta: { actor_role: context.role },
  });
  return mapRow(row);
}
