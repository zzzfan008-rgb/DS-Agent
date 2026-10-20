'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiFailure } from '@/lib/api';
import {
  createContentDraft,
  createJudgment,
  fetchDraft,
  fetchDraftList,
  submitContentApproval,
} from '@/lib/content-client';
import { fetchProduct, fetchProductList } from '@/lib/products-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import {
  contentTypeLabel,
  severityLabel,
  TONE_OPTIONS,
  verdictLabel,
} from '@/lib/m3-format';
import { formatCents } from '@/lib/format';
import type {
  ApprovalCreateResponse,
  ContentDraftCreateResponse,
  ContentDraftListItem,
  ContentType,
  EvidenceRef,
  JudgmentResponse,
  L1Hit,
  Platform,
  ProductListItem,
  Tone,
  Verdict,
} from '@/lib/m3-types';
import { Chip, Drawer, InlineAlert, SectionCard, Spinner } from '@/components/m3/M3Ui';
import { Icon } from '@/components/common/Icon';
import { EmptyState } from '@/components/states/EmptyState';
import styles from './copy.module.css';
import m3 from '@/components/m3/m3.module.css';

const PLATFORMS: Array<{ value: Platform; label: string }> = [
  { value: 'pdd', label: '拼多多' },
  { value: '1688', label: '1688' },
];

const CONTENT_TYPES: Array<{ value: ContentType; label: string }> = [
  { value: 'title', label: '标题' },
  { value: 'selling_points', label: '卖点' },
  { value: 'detail', label: '详情' },
  { value: 'faq', label: 'FAQ' },
];

const VERDICT_TONE: Record<Verdict, 'success' | 'warning' | 'danger' | 'violet'> = {
  pass: 'success',
  needs_revision: 'warning',
  reject: 'danger',
  escalate: 'violet',
};

function splitList(value: string): string[] {
  return value
    .split(/[,，、\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(0);
  useEffect(() => {
    if (!active) return;
    started.current = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started.current) / 100) / 10);
    }, 100);
    return () => window.clearInterval(timer);
  }, [active]);
  return elapsed;
}

interface HitRange {
  start: number;
  end: number;
  hits: L1Hit[];
}

function buildRanges(text: string, hits: L1Hit[]): HitRange[] {
  const ranges: HitRange[] = [];
  const sorted = hits
    .map((hit) => ({
      hit,
      start: Math.max(0, Math.min(text.length, hit.span[0])),
      end: Math.max(0, Math.min(text.length, hit.span[1])),
    }))
    .filter((entry) => entry.end > entry.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const entry of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && entry.start <= last.end) {
      last.end = Math.max(last.end, entry.end);
      last.hits.push(entry.hit);
    } else {
      ranges.push({ start: entry.start, end: entry.end, hits: [entry.hit] });
    }
  }
  return ranges;
}

function HighlightedText({
  text,
  hits,
  activeRule,
  onSelectRule,
}: {
  text: string;
  hits: L1Hit[];
  activeRule: string | null;
  onSelectRule: (ruleId: string) => void;
}) {
  if (!text) return null;
  if (hits.length === 0) return <p className={styles.hitPreview}>{text}</p>;
  const ranges = buildRanges(text, hits);
  const segments: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) segments.push(text.slice(cursor, range.start));
    const ruleIds = range.hits.map((hit) => hit.rule_id);
    const active = activeRule !== null && ruleIds.includes(activeRule);
    segments.push(
      <mark
        key={`${range.start}-${range.end}-${index}`}
        className={`${styles.mark} ${active ? styles.markActive : ''}`}
        title={ruleIds.join(' / ')}
        onClick={() => {
          const first = ruleIds[0];
          if (first) onSelectRule(first);
        }}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) segments.push(text.slice(cursor));
  return <p className={styles.hitPreview}>{segments}</p>;
}

function decisionAllowsSubmit(judgment: JudgmentResponse | null): { ok: boolean; reason: string | null } {
  if (!judgment) return { ok: false, reason: '请先完成判定（L1+L2）' };
  if (judgment.verdict === 'reject') {
    return { ok: false, reason: '驳回内容不可提交审批；请按修复建议修改后重新判定' };
  }
  return { ok: true, reason: null };
}

export interface CopyWorkbenchProps {
  canWrite: boolean;
}

export function CopyWorkbench({ canWrite }: CopyWorkbenchProps) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ProductListItem[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [product, setProduct] = useState<ProductListItem | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [platform, setPlatform] = useState<Platform>('pdd');
  const [contentType, setContentType] = useState<ContentType>('title');
  const [tone, setTone] = useState<Tone>('专业');
  const [lengthLimit, setLengthLimit] = useState('60');
  const [keywords, setKeywords] = useState('');
  const [forbidden, setForbidden] = useState('');
  const [runMode, setRunMode] = useState<'L1+L2' | 'L1'>('L1+L2');

  const [draft, setDraft] = useState<ContentDraftCreateResponse | null>(null);
  const [text, setText] = useState('');
  const [originalText, setOriginalText] = useState('');
  const [judgedText, setJudgedText] = useState('');
  const [judgment, setJudgment] = useState<JudgmentResponse | null>(null);
  const [activeRule, setActiveRule] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<EvidenceRef | null>(null);
  const [compare, setCompare] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [judging, setJudging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const elapsed = useElapsed(generating);
  const abortRef = useRef<AbortController | null>(null);

  const [approval, setApproval] = useState<ApprovalCreateResponse | null>(null);
  const [previousHash, setPreviousHash] = useState<string | null>(null);
  const [approvedContent, setApprovedContent] = useState<string | null>(null);
  const [existingApprovalId, setExistingApprovalId] = useState<string | null>(null);

  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<ContentDraftListItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<ApiFailure | null>(null);

  /* 商品搜索 */
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setOptionsLoading(true);
      fetchProductList({ q: query, limit: 20 })
        .then((result) => {
          if (!cancelled) setOptions(result.items);
        })
        .catch((caught: unknown) => {
          if (!cancelled && isApiFailure(caught) && caught.status === 401) redirectToLogin();
        })
        .finally(() => {
          if (!cancelled) setOptionsLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pickerOpen, query]);

  /* 支持从商品详情 ?product=<id> 进入 */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const productId = new URLSearchParams(window.location.search).get('product');
    if (!productId) return;
    fetchProduct(productId)
      .then((detail) => {
        setProduct({
          id: detail.product.id,
          spu_code: detail.product.spu_code,
          name: detail.product.name,
          category_code: detail.product.category_code,
          fit: detail.product.fit,
          color_count: new Set(detail.skus.map((sku) => sku.color_id)).size,
          sku_count: detail.skus.length,
          status: detail.product.status,
          size_chart_version: detail.size_chart[0]?.version_no ?? 0,
          updated_at: '',
        });
      })
      .catch((caught: unknown) => {
        if (isApiFailure(caught) && caught.status === 401) redirectToLogin();
      });
  }, []);

  /* 历史草稿 */
  useEffect(() => {
    if (!historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchDraftList(20)
      .then((result) => {
        if (!cancelled) setHistory(result.items);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) redirectToLogin();
          else setHistoryError(caught);
          return;
        }
        setHistoryError({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '历史草稿加载失败',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen]);

  const resetOutput = () => {
    setDraft(null);
    setText('');
    setOriginalText('');
    setJudgedText('');
    setJudgment(null);
    setApproval(null);
    setPreviousHash(null);
    setApprovedContent(null);
    setExistingApprovalId(null);
    setFailure(null);
    setNotice(null);
    setActiveRule(null);
    setEvidence(null);
  };

  const generate = async () => {
    if (!product || !canWrite) return;
    resetOutput();
    setGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const lengthValue = Number(lengthLimit);
      const result = await createContentDraft(
        {
          product_id: product.id,
          platform,
          content_type: contentType,
          tone,
          ...(Number.isFinite(lengthValue) && lengthValue > 0
            ? {
                constraints: {
                  length: Math.round(lengthValue),
                  ...(splitList(keywords).length > 0 ? { keywords: splitList(keywords) } : {}),
                  ...(splitList(forbidden).length > 0 ? { forbidden: splitList(forbidden) } : {}),
                },
              }
            : {}),
        },
        controller.signal,
      );
      setDraft(result);
      setText(result.content);
      setOriginalText(result.content);
      setNotice(`已生成（facts_hash ${result.facts_hash.slice(0, 12)}…，模型调用 ${shortId(result.model_call_id ?? '—')}）`);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setFailure(caught);
      } else {
        setFailure({
          ok: false,
          status: 0,
          code: 'aborted_or_network',
          message: controller.signal.aborted ? '已取消请求（模型调用可能仍在服务端继续，成本可能产生）' : '生成失败：网络错误',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const judge = async () => {
    if (!draft || !canWrite) return;
    setJudging(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await createJudgment({
        subject_type: 'content_draft',
        subject_id: draft.draft_id,
        platform,
        content_type: contentType,
        text,
        run: runMode,
      });
      setJudgment(result);
      setJudgedText(text);
      setActiveRule(result.rule_hits[0]?.rule_id ?? null);
      setNotice(`判定完成：${verdictLabel(result.verdict)} · ${severityLabel(result.severity)} · ${result.latency_ms}ms`);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setFailure(caught);
      } else {
        setFailure({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '判定失败：网络错误',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      }
    } finally {
      setJudging(false);
    }
  };

  const submitApproval = async () => {
    if (!draft || !canWrite) return;
    setSubmitting(true);
    setFailure(null);
    setNotice(null);
    setExistingApprovalId(null);
    try {
      const result = await submitContentApproval({
        subject_id: draft.draft_id,
        platform,
        content_type: contentType,
        content: text,
        original_content: originalText,
        facts_hash: draft.facts_hash,
        judgment,
        product: product
          ? {
              id: product.id,
              spu_code: product.spu_code,
              name: product.name,
              category_code: product.category_code,
            }
          : null,
      });
      setPreviousHash(approval?.target_hash ?? null);
      setApproval(result);
      setApprovedContent(text);
      setNotice(`审批已创建：${result.level} 级 · target_hash ${result.target_hash.slice(0, 12)}…`);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        if (caught.status === 409) {
          const detail = caught.detail;
          if (detail && typeof detail.approval_id === 'string') {
            setExistingApprovalId(detail.approval_id);
            setFailure({
              ...caught,
              message: '同一内容已有待审批记录（409 conflict），请前往审批中心查看。',
            });
            return;
          }
        }
        setFailure(caught);
      } else {
        setFailure({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '提交审批失败：网络错误',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const loadHistoryDraft = async (item: ContentDraftListItem) => {
    setHistoryOpen(false);
    setFailure(null);
    setNotice(null);
    try {
      const [detail, productDetail] = await Promise.all([
        fetchDraft(item.id),
        fetchProduct(item.product_id).catch(() => null),
      ]);
      setDraft({
        draft_id: detail.id,
        content: detail.content,
        fact_refs: [],
        status: detail.status,
        judgment_pending: false,
        facts_hash: detail.facts?.facts_hash ?? '',
        model_call_id: null,
      });
      setText(detail.content);
      setOriginalText(detail.content);
      setJudgedText('');
      setJudgment(null);
      setApproval(null);
      setPreviousHash(null);
      setApprovedContent(null);
      setPlatform(detail.platform);
      setContentType(detail.content_type);
      if (productDetail) {
        setProduct({
          id: productDetail.product.id,
          spu_code: productDetail.product.spu_code,
          name: productDetail.product.name,
          category_code: productDetail.product.category_code,
          fit: productDetail.product.fit,
          color_count: new Set(productDetail.skus.map((sku) => sku.color_id)).size,
          sku_count: productDetail.skus.length,
          status: productDetail.product.status,
          size_chart_version: productDetail.size_chart[0]?.version_no ?? 0,
          updated_at: '',
        });
      }
      setNotice('已载入历史草稿；正文未持久化编辑（后端无 PATCH），判定/审批按当前正文进行。');
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) redirectToLogin();
        else setFailure(caught);
      }
    }
  };

  const contentChangedAfterApproval =
    approvedContent !== null && text !== approvedContent;
  const baseGuard = decisionAllowsSubmit(judgment);
  const submitGuard =
    approval !== null && approvedContent === text
      ? { ok: false, reason: '同一内容已有待审批（target_hash 相同）；修改正文后可提交新审批' }
      : baseGuard;
  const hits = judgment?.rule_hits ?? [];
  const judgedMatchesCurrent = judgment !== null && judgedText === text;

  const evidenceList = useMemo(() => {
    const map = new Map<string, EvidenceRef>();
    for (const ref of judgment?.evidence_refs ?? []) map.set(ref.chunk_id, ref);
    for (const ref of judgment?.l2?.evidence_refs ?? []) map.set(ref.chunk_id, ref);
    return [...map.values()];
  }, [judgment]);

  return (
    <div className={m3.pageStack}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>文案工作台</h1>
          <p className={styles.subtitle}>
            生成 → L1/L2 判定 → 提交审批。生成使用用途路由 copy；模型由路由策略自动选择，本页不提供模型开关。
          </p>
        </div>
        <div className={m3.inlineActions}>
          <Chip tone="info">M3</Chip>
          <button type="button" className="buttonSecondary" onClick={() => setHistoryOpen(true)}>
            <Icon name="list" size={15} />
            历史草稿
          </button>
        </div>
      </div>

      {failure ? (
        <InlineAlert tone="error" title={`${failure.code}（request_id: ${failure.requestId ?? '—'}）`}>
          {failure.message}
          {existingApprovalId ? (
            <>
              {' '}
              <Link href={`/approvals/${existingApprovalId}`}>打开已有审批 →</Link>
            </>
          ) : null}
        </InlineAlert>
      ) : null}
      {notice ? <InlineAlert tone="info">{notice}</InlineAlert> : null}

      <div className={styles.layout}>
        {/* 左：输入 */}
        <div className={styles.column}>
          <SectionCard
            title="输入"
            description="商品、渠道、内容类型与约束；未选商品不能生成。"
            extra={canWrite ? null : <Chip tone="warning">只读</Chip>}
          >
            <div className={styles.fieldStack}>
              <div>
                <span className={m3.label}>商品 *</span>
                {product ? (
                  <div className={styles.selectedProduct}>
                    <div>
                      <p className={styles.selectedName}>{product.name}</p>
                      <p className={styles.selectedMeta}>
                        {product.spu_code} · {product.category_code} · {product.sku_count} SKU
                      </p>
                    </div>
                    <button
                      type="button"
                      className="buttonQuiet"
                      onClick={() => {
                        setProduct(null);
                        setPickerOpen(true);
                      }}
                    >
                      更换
                    </button>
                  </div>
                ) : (
                  <button type="button" className="buttonSecondary" onClick={() => setPickerOpen(true)}>
                    <Icon name="search" size={15} />
                    选择商品
                  </button>
                )}
                {pickerOpen ? (
                  <div className={styles.picker}>
                    <input
                      className={m3.input}
                      autoFocus
                      placeholder="搜索 SPU / 名称"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <div className={styles.pickerList}>
                      {optionsLoading ? (
                        <p className={m3.muted}>加载中…</p>
                      ) : options.length === 0 ? (
                        <p className={m3.muted}>没有匹配商品</p>
                      ) : (
                        options.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className={styles.pickerItem}
                            onClick={() => {
                              setProduct(option);
                              setPickerOpen(false);
                              resetOutput();
                            }}
                          >
                            <span className={styles.pickerName}>{option.name}</span>
                            <span className={styles.pickerMeta}>
                              {option.spu_code} · {option.sku_count} SKU
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <button type="button" className="buttonQuiet" onClick={() => setPickerOpen(false)}>
                      收起
                    </button>
                  </div>
                ) : null}
              </div>

              <div>
                <span className={m3.label}>渠道 *</span>
                <div className={m3.segmented} role="group" aria-label="渠道">
                  {PLATFORMS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={platform === item.value ? m3.segmentActive : undefined}
                      aria-pressed={platform === item.value}
                      onClick={() => setPlatform(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className={m3.label}>类型 *</span>
                <div className={m3.segmented} role="group" aria-label="内容类型">
                  {CONTENT_TYPES.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className={contentType === item.value ? m3.segmentActive : undefined}
                      aria-pressed={contentType === item.value}
                      onClick={() => setContentType(item.value)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className={styles.field}>
                <span className={m3.label}>语气</span>
                <select className={m3.select} value={tone} onChange={(event) => setTone(event.target.value as Tone)}>
                  {TONE_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span className={m3.label}>字数上限</span>
                <input
                  className={m3.input}
                  value={lengthLimit}
                  onChange={(event) => setLengthLimit(event.target.value.replace(/\D/g, ''))}
                  inputMode="numeric"
                  placeholder="60"
                />
              </label>
              <label className={styles.field}>
                <span className={m3.label}>需包含关键词</span>
                <input
                  className={m3.input}
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  placeholder="逗号分隔"
                />
              </label>
              <label className={styles.field}>
                <span className={m3.label}>禁止出现</span>
                <input
                  className={m3.input}
                  value={forbidden}
                  onChange={(event) => setForbidden(event.target.value)}
                  placeholder="逗号分隔，如 最、第一"
                />
              </label>

              <div className={styles.modelNote}>
                <Icon name="model" size={14} />
                模型：由路由策略自动选择（copy 用途）
              </div>

              {canWrite ? (
                <button
                  type="button"
                  className="buttonPrimary"
                  onClick={() => void generate()}
                  disabled={!product || generating}
                >
                  {generating ? <Spinner label={`生成中 ${elapsed.toFixed(1)}s`} /> : '生成文案'}
                </button>
              ) : (
                <InlineAlert tone="info">当前账号没有 content.write 权限，只能查看历史草稿与判定。</InlineAlert>
              )}
              {generating ? (
                <button
                  type="button"
                  className="buttonQuiet"
                  onClick={() => abortRef.current?.abort()}
                >
                  取消请求
                </button>
              ) : null}
            </div>
          </SectionCard>
        </div>

        {/* 中：结果与编辑 */}
        <div className={styles.column}>
          <SectionCard
            title="结果与编辑"
            description="生成结果可编辑；编辑后需重新判定。后端无草稿 PATCH，编辑仅本地生效。"
            extra={
              draft ? (
                <div className={m3.inlineActions}>
                  <Chip tone="neutral">{contentTypeLabel(contentType)}</Chip>
                  <Chip tone="neutral">{platform === 'pdd' ? '拼多多' : '1688'}</Chip>
                </div>
              ) : null
            }
          >
            {!draft ? (
              <EmptyState
                title="还没有生成结果"
                description="选择商品与参数后点击“生成文案”；生成是同步请求，耗时取决于路由模型。"
                icon="copy"
              />
            ) : (
              <div className={styles.resultStack}>
                <div className={styles.resultMeta}>
                  <span>字数 {[...text].length}</span>
                  <span>·</span>
                  <span>facts_hash <span className={m3.mono}>{draft.facts_hash.slice(0, 16)}…</span></span>
                  <span>·</span>
                  <span>model_call_id <span className={m3.mono}>{shortId(draft.model_call_id ?? '—')}</span></span>
                </div>

                <div className={m3.inlineActions}>
                  <button
                    type="button"
                    className={compare ? 'buttonSecondary' : 'buttonQuiet'}
                    onClick={() => setCompare((value) => !value)}
                  >
                    <Icon name="list" size={14} />
                    {compare ? '返回编辑' : '对比 AI 原文'}
                  </button>
                  <button
                    type="button"
                    className="buttonQuiet"
                    onClick={() => void navigator.clipboard.writeText(text)}
                  >
                    复制
                  </button>
                </div>

                {compare ? (
                  <div className={styles.compareGrid}>
                    <div>
                      <p className={m3.sectionTitle}>AI 原文</p>
                      <pre className={styles.compareBox}>{originalText}</pre>
                    </div>
                    <div>
                      <p className={m3.sectionTitle}>当前编辑</p>
                      <pre className={styles.compareBox}>{text}</pre>
                    </div>
                  </div>
                ) : (
                  <textarea
                    className={`${m3.textarea} ${styles.editor}`}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    aria-label="文案正文"
                    readOnly={!canWrite}
                  />
                )}

                {judgment ? (
                  <div>
                    <div className={styles.previewHead}>
                      <span className={m3.sectionTitle}>
                        命中预览（{judgedMatchesCurrent ? '与当前正文一致' : '基于上次判定文本，已过期'})
                      </span>
                      {!judgedMatchesCurrent ? (
                        <button type="button" className="buttonQuiet" onClick={() => void judge()}>
                          重新判定
                        </button>
                      ) : null}
                    </div>
                    <HighlightedText
                      text={judgedMatchesCurrent ? text : judgedText}
                      hits={hits}
                      activeRule={activeRule}
                      onSelectRule={setActiveRule}
                    />
                  </div>
                ) : null}

                <div className={styles.resultActions}>
                  <div className={m3.inlineActions}>
                    <select
                      className={m3.select}
                      value={runMode}
                      onChange={(event) => setRunMode(event.target.value as typeof runMode)}
                      aria-label="判定模式"
                    >
                      <option value="L1+L2">L1+L2（默认）</option>
                      <option value="L1">仅 L1（快速）</option>
                    </select>
                    <button
                      type="button"
                      className="buttonSecondary"
                      onClick={() => void judge()}
                      disabled={!canWrite || judging || !text.trim()}
                    >
                      {judging ? <Spinner label="判定中" /> : '判定 L1/L2'}
                    </button>
                  </div>
                  <span className={m3.muted}>
                    {judgment ? `本次判定 ${verdictLabel(judgment.verdict)} · ${severityLabel(judgment.severity)}` : '尚未判定'}
                  </span>
                </div>
              </div>
            )}
          </SectionCard>
        </div>

        {/* 右：判定 + 审批 */}
        <div className={styles.column}>
          <SectionCard title="判定结果">
            {!judgment ? (
              <div className={styles.placeholder}>
                <Icon name="shield" size={20} />
                <p>完成生成后点击“判定 L1/L2”。L1 命中会给出 rule_id、命中片段与建议；L2 引用可点击查看原文。</p>
              </div>
            ) : (
              <div className={styles.judgmentStack}>
                <div className={`${styles.verdictBanner} ${styles[`verdict_${judgment.verdict}`] ?? ''}`}>
                  <div className={styles.verdictTop}>
                    <strong>{verdictLabel(judgment.verdict)}</strong>
                    <Chip tone={VERDICT_TONE[judgment.verdict]}>{severityLabel(judgment.severity)}</Chip>
                    {judgment.escalated ? <Chip tone="violet">需人工复核</Chip> : null}
                  </div>
                  {judgment.short_circuit ? (
                    <p className={styles.shortCircuit}>短路：{judgment.short_circuit}</p>
                  ) : null}
                  {judgment.reason ? <p className={styles.reason}>{judgment.reason}</p> : null}
                  {judgment.repair_hint ? (
                    <p className={styles.repairHint}>
                      <strong>修复建议：</strong>
                      {judgment.repair_hint}
                    </p>
                  ) : null}
                  {judgment.verdict === 'escalate' ? (
                    <p className={styles.escalateHint}>
                      这是升级态，不是通过。系统不会自动放行；需人工复核/修改后重判或提交审批由人决定。
                    </p>
                  ) : null}
                </div>

                <div>
                  <p className={m3.sectionTitle}>L1 命中（{hits.length}）</p>
                  {hits.length === 0 ? (
                    <p className={m3.muted}>L1 未命中规则。</p>
                  ) : (
                    <ul className={styles.l1List}>
                      {hits.map((hit, index) => (
                        <li
                          key={`${hit.rule_id}-${index}`}
                          className={`${styles.l1Item} ${activeRule === hit.rule_id ? styles.l1Active : ''}`}
                          onClick={() => setActiveRule(hit.rule_id)}
                        >
                          <div className={styles.l1Head}>
                            <span className={m3.mono}>{hit.rule_id}</span>
                            <Chip tone={hit.severity === 'blocker' || hit.severity === 'high' ? 'danger' : hit.severity === 'medium' ? 'warning' : 'neutral'}>
                              {severityLabel(hit.severity)}
                            </Chip>
                          </div>
                          <p className={styles.l1Matched}>「{hit.matched}」</p>
                          <p className={styles.l1Suggestion}>{hit.suggestion}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <p className={m3.sectionTitle}>L2 裁决</p>
                  {judgment.l2 ? (
                    <div className={styles.l2Box}>
                      <p>
                        <Chip tone={VERDICT_TONE[judgment.l2.verdict]}>{verdictLabel(judgment.l2.verdict)}</Chip>{' '}
                        {severityLabel(judgment.l2.severity)}
                        {judgment.l2.confidence !== undefined ? ` · confidence ${judgment.l2.confidence}` : ''}
                      </p>
                      <p className={styles.reason}>{judgment.l2.reason}</p>
                      {judgment.l2.repair_hint ? <p className={m3.muted}>修复：{judgment.l2.repair_hint}</p> : null}
                    </div>
                  ) : (
                    <p className={m3.muted}>
                      未调用/无 L2 结果{judgment.short_circuit ? `（${judgment.short_circuit}）` : ''}。
                      商品草稿的 facts 当前不含 KB 证据，L2 通常不可达（G21）；本页不伪造 L2。
                    </p>
                  )}
                </div>

                <div>
                  <p className={m3.sectionTitle}>证据引用（{evidenceList.length}）</p>
                  {evidenceList.length === 0 ? (
                    <p className={m3.muted}>无引用证据。</p>
                  ) : (
                    <div className={styles.evidenceRow}>
                      {evidenceList.map((ref, index) => (
                        <button
                          key={`${ref.chunk_id}-${index}`}
                          type="button"
                          className={styles.evidenceChip}
                          onClick={() => setEvidence(ref)}
                        >
                          <Icon name="kb" size={13} />
                          E{index + 1} · {ref.doc_id.slice(0, 8)}… · v{ref.doc_version}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <dl className={m3.infoGrid}>
                  <div className={m3.infoItem}>
                    <dt>规则集 / 词表 / 提示词</dt>
                    <dd className={m3.mono}>
                      {judgment.versions.rule_set} / {judgment.versions.lexicon} / {judgment.versions.prompt}
                    </dd>
                  </div>
                  <div className={m3.infoItem}>
                    <dt>成本 / 延迟</dt>
                    <dd>
                      {formatCents(judgment.cost_cents)} · {judgment.latency_ms}ms
                    </dd>
                  </div>
                  <div className={m3.infoItem}>
                    <dt>facts_hash</dt>
                    <dd className={m3.mono}>{judgment.facts_hash.slice(0, 18)}…</dd>
                  </div>
                </dl>
              </div>
            )}
          </SectionCard>

          <SectionCard title="提交审批" description="审批级别由服务端计算；前端只显示。" >
            {!draft ? (
              <p className={m3.muted}>先生成文案。</p>
            ) : (
              <div className={styles.approvalStack}>
                {contentChangedAfterApproval ? (
                  <InlineAlert tone="warning">
                    内容已修改，旧审批的 target_hash 将不再匹配，请提交新审批
                  </InlineAlert>
                ) : null}
                {approval ? (
                  <div className={styles.approvalBox}>
                    <div className={styles.approvalHead}>
                      <Chip tone={approval.level === 'A' ? 'success' : approval.level === 'B' ? 'warning' : 'danger'}>
                        {approval.level} 级
                      </Chip>
                      <span>提交内容发布 · {approval.level} 级</span>
                    </div>
                    <p className={m3.muted}>
                      target_hash <span className={m3.mono}>{approval.target_hash}</span>
                    </p>
                    {previousHash && previousHash !== approval.target_hash ? (
                      <p className={m3.muted}>
                        上一审批 target_hash <span className={m3.mono}>{previousHash}</span>（不再对应当前内容）
                      </p>
                    ) : null}
                    <p className={m3.muted}>
                      有效期至 {approval.expires_at.replace('T', ' ').slice(0, 16)}
                      {approval.sla_due_at
                        ? ` · SLA ${approval.sla_due_at.replace('T', ' ').slice(0, 16)}`
                        : ''}
                    </p>
                    <Link className="buttonSecondary" href={`/approvals/${approval.id}`}>
                      去审批中心
                    </Link>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="buttonPrimary"
                  onClick={() => void submitApproval()}
                  disabled={!canWrite || submitting || !submitGuard.ok}
                  title={submitGuard.reason ?? undefined}
                >
                  {submitting ? <Spinner label="提交中" /> : '提交审批'}
                </button>
                {!submitGuard.ok && submitGuard.reason ? (
                  <p className={m3.muted}>{submitGuard.reason}</p>
                ) : null}
                <p className={styles.safetyNote}>
                  四眼原则：申请人不能审批自己的申请。审批通过后仍需按写入门执行（M4）。
                </p>
              </div>
            )}
          </SectionCard>
        </div>
      </div>

      <Drawer
        open={evidence !== null}
        title="证据原文"
        description="引用来自本次判定提供的证据集；可复制 ID 追溯。"
        onClose={() => setEvidence(null)}
        width={520}
      >
        {evidence ? (
          <div className={styles.evidenceDetail}>
            <p className={styles.quote}>{evidence.quote}</p>
            <dl className={m3.infoGrid}>
              <div className={m3.infoItem}>
                <dt>doc_id</dt>
                <dd className={m3.mono}>{evidence.doc_id}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>chunk_id</dt>
                <dd className={m3.mono}>{evidence.chunk_id}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>doc_version</dt>
                <dd>v{evidence.doc_version}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>生效日期</dt>
                <dd>{evidence.effective_from ?? '—'}</dd>
              </div>
            </dl>
            <div className={m3.inlineActions}>
              <button
                type="button"
                className="buttonSecondary"
                onClick={() => void navigator.clipboard.writeText(`${evidence.doc_id}/${evidence.chunk_id}@v${evidence.doc_version}`)}
              >
                复制证据 ID
              </button>
              <Link className="buttonQuiet" href={`/kb?doc=${encodeURIComponent(evidence.doc_id)}`}>
                去知识库（M7 接入）
              </Link>
            </div>
          </div>
        ) : null}
      </Drawer>

      <Drawer
        open={historyOpen}
        title="历史草稿"
        description="列表接口的 verdict/cost 当前恒为 null/0（G17）；打开后可按正文重新判定。"
        onClose={() => setHistoryOpen(false)}
        width={520}
      >
        {historyLoading ? <Spinner label="加载中" /> : null}
        {historyError ? <InlineAlert tone="error">{historyError.message}</InlineAlert> : null}
        {!historyLoading && !historyError && history.length === 0 ? (
          <EmptyState title="还没有草稿" description="生成第一份文案后会出现在这里。" />
        ) : null}
        <div className={styles.historyList}>
          {history.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.historyItem}
              onClick={() => void loadHistoryDraft(item)}
            >
              <span className={styles.historyTitle}>
                {contentTypeLabel(item.content_type)} · {item.platform === 'pdd' ? '拼多多' : '1688'}
              </span>
              <span className={styles.historyMeta}>
                {item.status} · verdict {item.verdict ?? '—'} · {item.updated_at.replace('T', ' ').slice(0, 16)}
              </span>
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
