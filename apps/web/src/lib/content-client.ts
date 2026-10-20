'use client';

import { getEnvelope, getJson, mutateJson } from './m3-api';
import type {
  ApprovalCreateResponse,
  ContentDraftCreateResponse,
  ContentDraftDetail,
  ContentDraftListItem,
  ContentDraftListData,
  ContentType,
  JudgmentResponse,
  Platform,
  Tone,
} from './m3-types';

export interface CreateContentDraftInput {
  product_id: string;
  platform: Platform;
  content_type: ContentType;
  tone?: Tone;
  constraints?: { length?: number; keywords?: string[]; forbidden?: string[] };
}

export async function createContentDraft(
  input: CreateContentDraftInput,
  signal?: AbortSignal,
): Promise<ContentDraftCreateResponse> {
  const result = await mutateJson<ContentDraftCreateResponse>('/api/content/drafts', {
    body: input,
    ...(signal ? { signal } : {}),
  });
  if (!result.ok) throw result;
  return result.data;
}

export interface DraftListResult {
  items: ContentDraftListItem[];
  nextCursor: string | null;
}

export async function fetchDraftList(limit = 20): Promise<DraftListResult> {
  const envelope = await getEnvelope<ContentDraftListData>(
    `/api/content/drafts?limit=${limit}`,
  );
  const next = envelope.meta.next_cursor;
  return {
    items: Array.isArray(envelope.data.items) ? envelope.data.items : [],
    nextCursor: typeof next === 'string' && next.length > 0 ? next : null,
  };
}

export async function fetchDraft(id: string): Promise<ContentDraftDetail> {
  return getJson<ContentDraftDetail>(`/api/content/drafts/${encodeURIComponent(id)}`);
}

export interface CreateJudgmentInput {
  subject_type: 'content_draft';
  subject_id: string;
  platform: Platform;
  content_type: ContentType;
  text?: string;
  run?: 'L1' | 'L2' | 'L1+L2';
}

export async function createJudgment(input: CreateJudgmentInput): Promise<JudgmentResponse> {
  const result = await mutateJson<JudgmentResponse>('/api/judgments', { body: input });
  if (!result.ok) throw result;
  return result.data;
}

export interface ContentApprovalInput {
  subject_id: string;
  platform: Platform;
  content_type: ContentType;
  content: string;
  original_content: string;
  facts_hash: string;
  judgment: JudgmentResponse | null;
  product: { id: string; spu_code: string; name: string; category_code: string } | null;
}

export async function submitContentApproval(
  input: ContentApprovalInput,
): Promise<ApprovalCreateResponse> {
  const riskNotes: string[] = [];
  if (input.judgment) {
    for (const hit of input.judgment.rule_hits) {
      riskNotes.push(`${hit.rule_id}（${hit.severity}）：${hit.matched}`);
    }
    if (input.judgment.escalated) riskNotes.push('L2 升级人工复核');
  }
  const result = await mutateJson<ApprovalCreateResponse>('/api/approvals', {
    body: {
      subject_type: 'content_draft',
      subject_id: input.subject_id,
      action: 'publish',
      platform: input.platform,
      target_payload: {
        draft_id: input.subject_id,
        content_type: input.content_type,
        content: input.content,
        facts_hash: input.facts_hash,
        judgment_id: input.judgment?.judgment_id ?? null,
        verdict: input.judgment?.verdict ?? null,
        severity: input.judgment?.severity ?? null,
      },
      fact_snapshot: {
        facts_hash: input.facts_hash,
        product_id: input.product?.id ?? null,
        spu_code: input.product?.spu_code ?? null,
        product_name: input.product?.name ?? null,
        category_code: input.product?.category_code ?? null,
        judgment_versions: input.judgment?.versions ?? null,
      },
      risk_meta: {
        risk_notes: riskNotes,
        content_type: input.content_type,
        judgment: input.judgment
          ? {
              verdict: input.judgment.verdict,
              severity: input.judgment.severity,
              reason: input.judgment.reason,
              short_circuit: input.judgment.short_circuit ?? null,
            }
          : null,
      },
      diff: {
        content: { before: input.original_content, after: input.content },
      },
    },
  });
  if (!result.ok) throw result;
  return result.data;
}
