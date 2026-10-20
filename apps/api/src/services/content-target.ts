/**
 * 内容草稿的审批 target：同一套 core canonicalHash，避免第二份规范化实现。
 *
 * target 绑定 draft 正文 + facts_hash + 平台/类型；编辑正文或主数据事实变化
 * 都会产生不同 hash，使旧 approval 在 decide 时被 428 approval_stale 拦住。
 */
import { canonicalHash } from '@dssaas/core';

export interface ContentDraftTargetSource {
  id: string;
  productId: string;
  platform: string;
  contentType: string;
  body: string;
  facts: unknown;
}

export function contentDraftTargetPayload(draft: ContentDraftTargetSource): Record<string, unknown> {
  const facts = (draft.facts ?? {}) as Record<string, unknown>;
  return {
    subject_type: 'content_draft',
    draft_id: draft.id,
    product_id: draft.productId,
    platform: draft.platform,
    content_type: draft.contentType,
    content: draft.body,
    facts_hash: typeof facts.facts_hash === 'string' ? facts.facts_hash : null,
  };
}

export function contentDraftTargetHash(draft: ContentDraftTargetSource): string {
  return canonicalHash(contentDraftTargetPayload(draft));
}

export function approvalTargetPayloadFromDiff(diff: unknown): Record<string, unknown> | null {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
  const value = (diff as Record<string, unknown>).target_payload;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
