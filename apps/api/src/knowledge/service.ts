/**
 * 知识库服务（M7）：入库（解析→切片→嵌入→pgvector）+ 混合召回 + 引用。
 *
 * 依据 docs/09（解析/切片/嵌入/混合召回/引用/降级）、docs/12 §3.10、docs/06 §4.9。
 * 设计约束：
 * - **不改 schema**：`source_ref` 存 `kb_document.uri`，并派生稳定 `source_id = uuidv5(source_ref)`，
 *   复用现有 `uq_kb_doc_active` 做版本/幂等（schema 没有 source_ref 列，见验收记录 D1）。
 * - **DSH 无 embedding 能力**：嵌入只走模型网关 `purpose=embed`（mock provider 可跑）；
 *   不可用时入库继续（index_status='stale'），查询降级纯关键词并显式 `degraded:true`。
 * - **无引用不返回**：每条 hit 必带 CitationV1（doc/chunk/version/quote/effective_from），
 *   quote 是 content 的连续子串；advisory（copy/manual）不进入 evidence_refs。
 */
import { Prisma, type PrismaClient } from '@dssaas/db';
import { z } from 'zod';
import type { ModelGateway } from '@dssaas/registry';
import { ApiError } from '../lib/errors.js';
import { decodeCursor, encodeCursor, parseLimit } from '../lib/cursor.js';
import { uuidv7 } from '../lib/ids.js';
import type { AuditService } from '../services/audit.js';
import type { MetricsRegistry } from '../services/metrics.js';
import { chunkDocument, CHUNK_CONFIG, ChunkError, type RawChunk } from './chunk.js';
import { pickQuote, toCitation, type Citation } from './citations.js';
import { KnowledgeEmbedder, EmbeddingUnavailableError, EMBEDDING_DIM } from './embedding.js';
import { l2Normalize, pgTextArray, uuidv5, vectorLiteral } from './ids.js';
import { parseDocument, ParseError, type ParsedDocument } from './parse.js';
import { buildTsQuery, keywordTokens, likePattern, tsvectorInput } from './tokenize.js';

export const KB_DOMAINS = ['product', 'size', 'fabric', 'policy', 'platform', 'copy', 'service'] as const;
export const KB_SOURCE_TYPES = [
  'product',
  'size_chart',
  'fabric',
  'policy',
  'faq',
  'platform_rule',
  'copy_sample',
  'care',
  'manual',
] as const;
export const KB_DOC_TYPES = ['spec', 'table', 'policy', 'faq', 'rule', 'sample', 'guide'] as const;

export type KbDomain = (typeof KB_DOMAINS)[number];
export type KbRole = 'viewer' | 'operator' | 'admin';
export type KbSearchMode = 'hybrid' | 'keyword';

const DOMAIN_TO_SOURCE: Record<KbDomain, string> = {
  product: 'product',
  size: 'size_chart',
  fabric: 'fabric',
  policy: 'policy',
  platform: 'platform_rule',
  copy: 'copy_sample',
  service: 'faq',
};

const SOURCE_TO_DOC_TYPE: Record<string, string> = {
  product: 'spec',
  size_chart: 'table',
  fabric: 'spec',
  policy: 'policy',
  platform_rule: 'rule',
  copy_sample: 'sample',
  faq: 'faq',
  care: 'guide',
  manual: 'guide',
};

/** 判断层允许作为证据的域（docs/09 §8.4：copy/manual 禁止）。 */
export const EVIDENCE_DOMAINS: readonly KbDomain[] = ['product', 'size', 'fabric', 'policy', 'platform'];

const RRF = { k: 60, vectorWeight: 1.0, keywordWeight: 0.8 } as const;
const CANDIDATE_LIMIT = 40;
const MAX_EVIDENCE = 8;

export interface KnowledgeContext {
  requestId: string;
  userId: string;
  role: KbRole;
  ip?: string | null;
  userAgent?: string | null;
}

export interface IngestInput {
  title: string;
  domain: KbDomain;
  fileName: string;
  mime: string | null;
  buffer: Buffer;
  sourceRef?: string | null;
  sourceType?: string | null;
  docType?: string | null;
  effectiveAt?: Date | null;
  effectiveTo?: Date | null;
}

export interface IngestResult {
  document_id: string;
  chunks: number;
  version: number;
  deduplicated: boolean;
  index_status: string;
  embedded: boolean;
  embedding_degraded: boolean;
  cost_cents: number;
}

export interface SearchFilters {
  domains?: readonly KbDomain[];
  sourceTypes?: readonly string[];
  platform?: string | null;
  skuCode?: string | null;
  asOf?: Date | null;
  excludeAdvisory?: boolean;
  documentId?: string | null;
}

export interface SearchInput {
  query: string;
  k?: number;
  role: KbRole;
  filters?: SearchFilters;
  purpose?: 'retrieval' | 'judge_evidence';
}

export interface SearchHit {
  chunk_id: string;
  document_id: string;
  title: string;
  snippet: string;
  content: string;
  score: number;
  vector_score: number | null;
  keyword_score: number | null;
  vector_rank: number | null;
  keyword_rank: number | null;
  version: number;
  effective_at: string | null;
  effective_to: string | null;
  source_ref: string | null;
  source_type: string;
  domain: string;
  section_path: string[];
  advisory: boolean;
  uri: string | null;
  quote: string;
  citation: Citation;
}

export interface SearchResult {
  hits: SearchHit[];
  evidence_refs: Citation[];
  degraded: boolean;
  degrade_reason: string | null;
  mode: KbSearchMode;
  took_ms: number;
}

export interface EvidenceFilters {
  role?: KbRole;
  k?: number;
  domains?: readonly KbDomain[];
  sourceTypes?: readonly string[];
  platform?: string | null;
  asOf?: Date | null;
  requestId?: string;
  actorId?: string | null;
}

export interface EvidenceResult {
  evidence_refs: Citation[];
  hits: SearchHit[];
  degraded: boolean;
  degrade_reason: string | null;
  took_ms: number;
}

export interface DocumentListItem {
  id: string;
  title: string;
  domain: string;
  source_type: string;
  version: number;
  chunks: number;
  effective_at: string | null;
  effective_to: string | null;
  status: string;
  index_status: string;
  updated_at: string;
  source_ref: string | null;
}

export interface DocumentListResult {
  items: DocumentListItem[];
  next_cursor: string | null;
}

export interface KnowledgeDeps {
  prisma: PrismaClient;
  gateway: ModelGateway;
  audit: AuditService;
  metrics?: MetricsRegistry;
  now?: () => Date;
}

interface ChunkRow {
  chunk_id: string;
  document_id: string;
  version_no: number;
  seq: number;
  section_path: string[];
  chunk_type: string;
  content: string;
  content_hash: string;
  metadata: Record<string, unknown>;
  effective_from: Date;
  effective_to: Date | null;
  title: string;
  source_type: string;
  domain: string;
  uri: string | null;
  score: number | null;
  kw_score: number | null;
}

interface FusedRow {
  row: ChunkRow;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
  vectorScore: number | null;
  keywordScore: number | null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function deriveSourceType(domain: KbDomain, override: string | null | undefined): string {
  if (override) {
    if (!(KB_SOURCE_TYPES as readonly string[]).includes(override)) {
      throw new ApiError('validation_failed', `source_type 非法：${override}`, {
        detail: { field: 'source_type', allowed: KB_SOURCE_TYPES },
      });
    }
    return override;
  }
  return DOMAIN_TO_SOURCE[domain];
}

function aclRolesFor(domain: KbDomain): string[] {
  return domain === 'copy' ? ['operator', 'admin'] : ['viewer', 'operator', 'admin'];
}

function mapParseError(error: ParseError): ApiError {
  if (error.code === 'unsupported_type') {
    return new ApiError('unsupported_media_type', error.message, { detail: { reason: error.code } });
  }
  return new ApiError('validation_failed', error.message, { detail: { reason: error.code } });
}

export class KnowledgeService {
  private readonly embedder: KnowledgeEmbedder;
  private readonly now: () => Date;

  constructor(private readonly deps: KnowledgeDeps) {
    this.embedder = new KnowledgeEmbedder({ prisma: deps.prisma, gateway: deps.gateway });
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // 入库
  // -------------------------------------------------------------------------

  async ingest(input: IngestInput, context: KnowledgeContext): Promise<IngestResult> {
    if (!(KB_DOMAINS as readonly string[]).includes(input.domain)) {
      throw new ApiError('validation_failed', 'domain 非法', { detail: { field: 'domain' } });
    }
    const title = input.title.trim();
    if (title.length === 0 || [...title].length > 200) {
      throw new ApiError('validation_failed', 'title 长度必须为 1–200', { detail: { field: 'title' } });
    }
    const sourceType = deriveSourceType(input.domain, input.sourceType);
    const sourceRef = (input.sourceRef?.trim() || `upload:${sourceType}:${title}`).slice(0, 500);
    const sourceId = uuidv5(`kb:${sourceType}:${sourceRef}`);
    const effectiveFrom = input.effectiveAt ?? this.now();
    const effectiveTo = input.effectiveTo ?? null;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new ApiError('validation_failed', 'effective_to 必须晚于 effective_at', {
        detail: { field: 'effective_to' },
      });
    }

    let parsed: ParsedDocument;
    try {
      parsed = parseDocument({
        title,
        fileName: input.fileName,
        mime: input.mime,
        buffer: input.buffer,
      });
    } catch (error) {
      if (error instanceof ParseError) throw mapParseError(error);
      throw error;
    }

    const existing = await this.deps.prisma.kbDocument.findFirst({
      where: { orgId: 1n, sourceType, sourceId, archivedAt: null },
      orderBy: { versionNo: 'desc' },
    });
    if (existing && existing.checksum === parsed.checksum && existing.archivedAt === null) {
      return {
        document_id: existing.id,
        chunks: existing.chunkCount,
        version: existing.versionNo,
        deduplicated: true,
        index_status: existing.indexStatus,
        embedded: existing.indexStatus === 'indexed',
        embedding_degraded: existing.indexStatus !== 'indexed',
        cost_cents: 0,
      };
    }

    let chunks: RawChunk[];
    try {
      chunks = chunkDocument(parsed, {
        title,
        versionNo: (existing?.versionNo ?? 0) + 1,
        sourceType,
        domain: input.domain,
        sourceRef,
        effectiveFrom,
        effectiveTo,
        advisory: input.domain === 'copy',
        parserVersion: parsed.parserVersion,
      });
    } catch (error) {
      if (error instanceof ChunkError) throw new ApiError('validation_failed', error.message);
      throw error;
    }
    if (chunks.length === 0) throw new ApiError('validation_failed', '文档没有可索引的切片');

    // 嵌入在事务外完成（失败不阻塞入库；docs/09 E6 → stale + 关键词可用）。
    let embedding: { vectors: number[][]; modelId: string; costCents: number } | null = null;
    let embeddingError: string | null = null;
    try {
      const result = await this.embedder.embed(
        chunks.map((chunk) => chunk.embeddingInput),
        { requestId: context.requestId, userId: context.userId, orgId: 1 },
      );
      embedding = { vectors: result.vectors, modelId: result.modelId, costCents: result.costCents };
    } catch (error) {
      embeddingError =
        error instanceof EmbeddingUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
    }

    const docId = uuidv7();
    const aclRoles = aclRolesFor(input.domain);
    const docType = input.docType ?? SOURCE_TO_DOC_TYPE[sourceType] ?? 'guide';
    const versionNo = (existing?.versionNo ?? 0) + 1;
    const lockKey = `kb:${sourceType}:${sourceId}`;

    const outcome = await this.deps.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)::text AS locked",
        lockKey,
      );
      const latest = await tx.kbDocument.findFirst({
        where: { orgId: 1n, sourceType, sourceId, archivedAt: null },
        orderBy: { versionNo: 'desc' },
      });
      if (latest && latest.checksum === parsed.checksum) {
        return { documentId: latest.id, version: latest.versionNo, deduplicated: true, chunks: latest.chunkCount };
      }
      const nextVersion = (latest?.versionNo ?? 0) + 1;
      if (latest) {
        await tx.kbDocument.update({
          where: { id: latest.id },
          data: { status: 'superseded' },
        });
        await tx.kbChunk.updateMany({
          where: { documentId: latest.id },
          data: { status: 'superseded' },
        });
      }
      await tx.kbDocument.create({
        data: {
          id: docId,
          orgId: 1n,
          sourceType,
          sourceId,
          title,
          docType,
          domain: input.domain,
          ownerRoleCode: 'operator',
          ownerUserId: context.userId,
          aclRoles,
          versionNo: nextVersion,
          status: 'draft',
          effectiveFrom,
          effectiveTo,
          reviewDueAt: new Date(effectiveFrom.getTime() + 180 * 24 * 3600 * 1000),
          checksum: parsed.checksum,
          uri: sourceRef,
          mime: parsed.mime,
          bytes: BigInt(input.buffer.length),
          lang: 'zh-CN',
          parserVersion: parsed.parserVersion,
          indexStatus: 'pending',
          chunkCount: chunks.length,
          supersedesId: latest?.id ?? null,
          createdBy: context.userId,
        },
      });

      for (const chunk of chunks) {
        const vector = embedding?.vectors[chunk.seq] ?? null;
        await tx.$executeRawUnsafe(
          `INSERT INTO kb_chunk (
             id, org_id, document_id, version_no, seq, section_path, chunk_type, content, content_hash,
             content_tokens, embedding, embedding_model_id, embedding_dim, tsv, metadata, acl_roles,
             effective_from, effective_to, status, created_at
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4, $5, $6::text[], $7, $8, $9, $10,
             $11::vector, $12::uuid, $13, to_tsvector('simple', $14), $15::jsonb, $16::text[],
             $17::timestamptz, $18::timestamptz, 'active', now()
           )`,
          uuidv7(),
          1n,
          docId,
          nextVersion,
          chunk.seq,
          pgTextArray(chunk.sectionPath),
          chunk.chunkType,
          chunk.content,
          chunk.contentHash,
          chunk.contentTokens,
          vector ? vectorLiteral(vector) : null,
          vector ? embedding!.modelId : null,
          vector ? EMBEDDING_DIM : null,
          tsvectorInput(chunk.content),
          JSON.stringify(chunk.metadata),
          pgTextArray(aclRoles),
          effectiveFrom,
          effectiveTo,
        );
      }

      await tx.kbDocument.update({
        where: { id: docId },
        data: {
          status: 'active',
          indexStatus: embedding ? 'indexed' : 'stale',
          indexedAt: embedding ? this.now() : null,
          embedModelId: embedding?.modelId ?? null,
          chunkCount: chunks.length,
        },
      });
      return { documentId: docId, version: nextVersion, deduplicated: false, chunks: chunks.length };
    });

    await this.deps.audit.record({
      action: 'kb.document_ingest',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'kb_document',
      resourceId: outcome.documentId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      after: {
        title,
        domain: input.domain,
        source_type: sourceType,
        version: outcome.version,
        chunks: outcome.chunks,
        checksum: parsed.checksum,
        embedded: Boolean(embedding),
        deduplicated: outcome.deduplicated,
      },
      meta: {
        actor_role: context.role,
        source_ref: sourceRef,
        parser_version: parsed.parserVersion,
        embedding_model_id: embedding?.modelId ?? null,
        embedding_error: embeddingError,
      },
    });
    this.deps.metrics?.inc('kb_ingest_total', '知识库入库次数', {
      domain: input.domain,
      status: outcome.deduplicated ? 'deduplicated' : embedding ? 'indexed' : 'stale',
    });

    return {
      document_id: outcome.documentId,
      chunks: outcome.chunks,
      version: outcome.version,
      deduplicated: outcome.deduplicated,
      index_status: outcome.deduplicated ? existing?.indexStatus ?? 'indexed' : embedding ? 'indexed' : 'stale',
      embedded: Boolean(embedding),
      embedding_degraded: !embedding,
      cost_cents: embedding?.costCents ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // 列表 / 软删
  // -------------------------------------------------------------------------

  async listDocuments(
    query: { domain?: string; status?: string; q?: string; cursor?: string; limit?: string },
  ): Promise<DocumentListResult> {
    const limit = parseLimit(query.limit, 20, 100);
    const cursorSchema = z.object({ updated_at: z.string(), id: z.string().uuid() });
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor, cursorSchema);
    const where: Prisma.KbDocumentWhereInput = { orgId: 1n, archivedAt: null };
    if (query.domain) {
      if (!(KB_DOMAINS as readonly string[]).includes(query.domain)) {
        throw new ApiError('validation_failed', 'domain 非法', { detail: { field: 'domain' } });
      }
      where.domain = query.domain;
    }
    if (query.status) where.status = query.status;
    if (query.q) where.title = { contains: query.q, mode: 'insensitive' };
    if (cursor) {
      where.AND = [
        {
          OR: [
            { updatedAt: { lt: new Date(cursor.updated_at) } },
            { updatedAt: new Date(cursor.updated_at), id: { lt: cursor.id } },
          ],
        },
      ];
    }
    const rows = await this.deps.prisma.kbDocument.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      id: row.id,
      title: row.title,
      domain: row.domain,
      source_type: row.sourceType,
      version: row.versionNo,
      chunks: row.chunkCount,
      effective_at: row.effectiveFrom.toISOString(),
      effective_to: row.effectiveTo?.toISOString() ?? null,
      status: row.status,
      index_status: row.indexStatus,
      updated_at: row.updatedAt.toISOString(),
      source_ref: row.uri,
    }));
    const last = rows[limit - 1];
    return {
      items,
      next_cursor:
        hasMore && last
          ? encodeCursor({ updated_at: last.updatedAt.toISOString(), id: last.id })
          : null,
    };
  }

  async archiveDocument(documentId: string, reason: string, context: KnowledgeContext): Promise<{ id: string; status: string; archived_at: string }> {
    const doc = await this.deps.prisma.kbDocument.findFirst({
      where: { id: documentId, orgId: 1n, archivedAt: null },
    });
    if (!doc) throw new ApiError('not_found', '知识文档不存在或已归档');
    const archivedAt = this.now();
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.kbDocument.update({
        where: { id: documentId },
        data: { status: 'archived', archivedAt, indexStatus: 'stale' },
      });
      // 软删 + 退出索引：chunk 保留以追溯历史引用，但不再参与召回。
      await tx.kbChunk.updateMany({
        where: { documentId, archivedAt: null },
        data: { status: 'disabled', archivedAt },
      });
    });
    await this.deps.audit.record({
      action: 'kb.document_delete',
      actorType: 'user',
      actorId: context.userId,
      requestId: context.requestId,
      resourceType: 'kb_document',
      resourceId: documentId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      before: { status: doc.status },
      after: { status: 'archived', archived_at: archivedAt.toISOString() },
      meta: { reason, actor_role: context.role, title: doc.title },
    });
    return { id: documentId, status: 'archived', archived_at: archivedAt.toISOString() };
  }

  // -------------------------------------------------------------------------
  // 检索
  // -------------------------------------------------------------------------

  async search(input: SearchInput): Promise<SearchResult> {
    const started = this.now().getTime();
    const query = input.query.trim();
    if (query.length === 0) throw new ApiError('validation_failed', 'q 不能为空', { detail: { field: 'q' } });
    const k = Math.min(Math.max(input.k ?? 10, 1), 50);
    const filters = input.filters ?? {};
    const asOf = filters.asOf ?? this.now();
    const role = input.role;

    let queryVector: number[] | null = null;
    let vectorFailure: string | null = null;
    try {
      const embedded = await this.embedder.embed([query], {
        requestId: `kb-search-${started}`,
        userId: '00000000-0000-7000-8000-000000000000',
        orgId: 1,
      });
      queryVector = l2Normalize(embedded.vectors[0]!);
      if (!queryVector) vectorFailure = 'zero_vector';
    } catch (error) {
      vectorFailure =
        error instanceof EmbeddingUnavailableError
          ? 'no_vector'
          : error instanceof Error
            ? error.message
            : 'no_vector';
    }

    let vectorRows: ChunkRow[] = [];
    let vectorUsed = queryVector !== null;
    if (queryVector) {
      try {
        vectorRows = await this.vectorSearch(queryVector, role, filters, asOf);
      } catch (error) {
        vectorUsed = false;
        vectorFailure = error instanceof Error ? error.message : 'vector_search_failed';
      }
    }

    const keywordRows = await this.keywordSearch(query, role, filters, asOf);

    let degraded = false;
    let degradeReason: string | null = null;
    if (!vectorUsed) {
      degraded = true;
      degradeReason = vectorFailure === 'no_vector' ? 'no_vector' : vectorFailure ?? 'no_vector';
    } else if (vectorRows.length === 0) {
      const embeddedCount = await this.countEmbeddings(role, filters, asOf);
      if (embeddedCount === 0) {
        degraded = true;
        degradeReason = 'no_vector';
      }
    }

    // RRF：score = w_vec/(60+rank_vec) + w_kw/(60+rank_kw)。
    const fused = new Map<string, FusedRow>();
    const add = (row: ChunkRow, rank: number, weight: number, kind: 'vector' | 'keyword'): void => {
      const key = row.chunk_id;
      const increment = weight / (RRF.k + rank);
      const previous = fused.get(key);
      if (previous) {
        previous.score += increment;
        if (kind === 'vector') {
          previous.vectorRank ??= rank;
          previous.vectorScore ??= row.score;
        } else {
          previous.keywordRank ??= rank;
          previous.keywordScore ??= row.kw_score;
        }
        return;
      }
      fused.set(key, {
        row,
        score: increment,
        vectorRank: kind === 'vector' ? rank : null,
        keywordRank: kind === 'keyword' ? rank : null,
        vectorScore: kind === 'vector' ? row.score : null,
        keywordScore: kind === 'keyword' ? row.kw_score : null,
      });
    };
    vectorRows.forEach((row, index) => add(row, index + 1, RRF.vectorWeight, 'vector'));
    keywordRows.forEach((row, index) => add(row, index + 1, RRF.keywordWeight, 'keyword'));

    const ranked = [...fused.values()].sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return (left.keywordRank ?? 999) - (right.keywordRank ?? 999);
    });

    const deduped: FusedRow[] = [];
    const seenContent = new Set<string>();
    for (const item of ranked) {
      if (seenContent.has(item.row.content_hash)) continue;
      seenContent.add(item.row.content_hash);
      deduped.push(item);
    }

    const hits: SearchHit[] = deduped.slice(0, k).map((item) => {
      const row = item.row;
      let quote = pickQuote(row.content, query);
      if (!row.content.includes(quote)) quote = row.content.slice(0, 200);
      const hit: SearchHit = {
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        title: row.title,
        snippet: quote,
        content: row.content,
        score: round4(item.score),
        vector_score: item.vectorScore === null ? null : round4(item.vectorScore),
        keyword_score: item.keywordScore === null ? null : round4(item.keywordScore),
        vector_rank: item.vectorRank,
        keyword_rank: item.keywordRank,
        version: row.version_no,
        effective_at: row.effective_from.toISOString(),
        effective_to: row.effective_to?.toISOString() ?? null,
        source_ref: row.uri ?? (row.metadata.source_ref as string | undefined) ?? null,
        source_type: row.source_type,
        domain: row.domain,
        section_path: row.section_path,
        advisory: row.metadata.advisory === true,
        uri: row.uri,
        quote,
        citation: null as unknown as Citation,
      };
      hit.citation = toCitation(hit);
      return hit;
    });

    const evidenceRefs = hits.filter((hit) => !hit.advisory).map((hit) => hit.citation);
    if (!degraded && hits.length === 0) {
      degraded = true;
      degradeReason = 'no_citation';
    }
    const tookMs = Math.max(0, this.now().getTime() - started);
    const mode: KbSearchMode = vectorUsed ? 'hybrid' : 'keyword';
    await this.logQuery({
      query,
      role,
      k,
      filters,
      hits,
      evidenceRefs,
      degraded,
      degradeReason,
      mode,
      tookMs,
      purpose: input.purpose ?? 'retrieval',
    });
    this.deps.metrics?.inc('kb_search_total', '知识库检索次数', {
      mode,
      degraded: String(degraded),
    });
    this.deps.metrics?.observe('kb_search_latency_ms', '知识库检索耗时（毫秒）', { mode }, tookMs);

    return {
      hits,
      evidence_refs: evidenceRefs,
      degraded,
      degrade_reason: degradeReason,
      mode,
      took_ms: tookMs,
    };
  }

  /** 供 L2 判断层使用：受限域 + 排除 advisory + top-k 引用。 */
  async resolveEvidence(query: string, filters: EvidenceFilters = {}): Promise<EvidenceResult> {
    const domains = filters.domains ?? EVIDENCE_DOMAINS;
    const result = await this.search({
      query,
      k: filters.k ?? MAX_EVIDENCE,
      role: filters.role ?? 'operator',
      purpose: 'judge_evidence',
      filters: {
        domains,
        sourceTypes: filters.sourceTypes,
        platform: filters.platform,
        asOf: filters.asOf,
        excludeAdvisory: true,
      },
    });
    return {
      evidence_refs: result.evidence_refs.slice(0, MAX_EVIDENCE),
      hits: result.hits.filter((hit) => !hit.advisory),
      degraded: result.degraded,
      degrade_reason: result.degrade_reason,
      took_ms: result.took_ms,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：SQL
  // -------------------------------------------------------------------------

  private push(params: unknown[], value: unknown): string {
    params.push(value);
    return `$${params.length}`;
  }

  private buildWhere(
    role: KbRole,
    filters: SearchFilters,
    asOf: Date,
    params: unknown[],
  ): string {
    const clauses: string[] = [
      "c.status = 'active'",
      'c.archived_at IS NULL',
      "d.status = 'active'",
      'd.archived_at IS NULL',
      `c.effective_from <= ${this.push(params, asOf)}::timestamptz`,
      `(c.effective_to IS NULL OR ${this.push(params, asOf)}::timestamptz < c.effective_to)`,
      `COALESCE(c.acl_roles, '{}'::text[]) && ARRAY[${this.push(params, role)}]::text[]`,
    ];
    const domains = filters.domains && filters.domains.length > 0 ? filters.domains : null;
    if (domains) {
      clauses.push(`d.domain IN (${domains.map((domain) => `${this.push(params, domain)}`).join(', ')})`);
    }
    const sourceTypes = filters.sourceTypes && filters.sourceTypes.length > 0 ? filters.sourceTypes : null;
    if (sourceTypes) {
      clauses.push(
        `d.source_type IN (${sourceTypes.map((sourceType) => `${this.push(params, sourceType)}`).join(', ')})`,
      );
    }
    if (filters.platform) {
      clauses.push(`c.metadata->>'platform' = ${this.push(params, filters.platform)}`);
    }
    if (filters.skuCode) {
      clauses.push(`c.metadata->>'sku_code' = ${this.push(params, filters.skuCode)}`);
    }
    if (filters.documentId) {
      clauses.push(`c.document_id = ${this.push(params, filters.documentId)}::uuid`);
    }
    if (filters.excludeAdvisory) {
      clauses.push("COALESCE((c.metadata->>'advisory')::boolean, false) = false");
    }
    return clauses.join('\n  AND ');
  }

  private baseSelect(): string {
    return `c.id AS chunk_id, c.document_id, c.version_no, c.seq, c.section_path, c.chunk_type,
       c.content, c.content_hash, c.metadata, c.effective_from, c.effective_to,
       d.title, d.source_type, d.domain, d.uri`;
  }

  private async vectorSearch(
    vector: number[],
    role: KbRole,
    filters: SearchFilters,
    asOf: Date,
  ): Promise<ChunkRow[]> {
    const params: unknown[] = [];
    const where = this.buildWhere(role, filters, asOf, params);
    const vectorParam = this.push(params, vectorLiteral(vector));
    const sql = `SELECT ${this.baseSelect()},
       (1 - (c.embedding <=> ${vectorParam}::vector))::float8 AS score,
       NULL::float8 AS kw_score
     FROM kb_chunk c
     JOIN kb_document d ON d.id = c.document_id
     WHERE ${where} AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> ${vectorParam}::vector
     LIMIT ${CANDIDATE_LIMIT}`;
    return this.deps.prisma.$transaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe('SET LOCAL hnsw.ef_search = 100');
      } catch {
        // 旧 pgvector 不支持该参数时忽略
      }
      return tx.$queryRawUnsafe<ChunkRow[]>(sql, ...params);
    });
  }

  private async keywordSearch(
    query: string,
    role: KbRole,
    filters: SearchFilters,
    asOf: Date,
  ): Promise<ChunkRow[]> {
    const params: unknown[] = [];
    const where = this.buildWhere(role, filters, asOf, params);
    const tokens = keywordTokens(query);
    const tsquery = buildTsQuery(tokens);
    const rawLike = this.push(params, likePattern(query));
    const tokenLikes = tokens
      .slice(0, 12)
      .map((token) => `c.content ILIKE ${this.push(params, likePattern(token))}`);

    if (tsquery) {
      const tsParam = this.push(params, tsquery);
      const sql = `SELECT ${this.baseSelect()},
         NULL::float8 AS score,
         ts_rank_cd(c.tsv, q)::float8 AS kw_score
       FROM kb_chunk c
       JOIN kb_document d ON d.id = c.document_id
       CROSS JOIN to_tsquery('simple', ${tsParam}) q
       WHERE ${where}
         AND (c.tsv @@ q OR c.content ILIKE ${rawLike}${tokenLikes.length ? ` OR ${tokenLikes.join(' OR ')}` : ''})
       ORDER BY kw_score DESC, char_length(c.content) ASC
       LIMIT ${CANDIDATE_LIMIT}`;
      return this.deps.prisma.$queryRawUnsafe<ChunkRow[]>(sql, ...params);
    }

    const sql = `SELECT ${this.baseSelect()},
       NULL::float8 AS score,
       0.01::float8 AS kw_score
     FROM kb_chunk c
     JOIN kb_document d ON d.id = c.document_id
     WHERE ${where} AND c.content ILIKE ${rawLike}
     ORDER BY char_length(c.content) ASC
     LIMIT ${CANDIDATE_LIMIT}`;
    return this.deps.prisma.$queryRawUnsafe<ChunkRow[]>(sql, ...params);
  }

  private async countEmbeddings(role: KbRole, filters: SearchFilters, asOf: Date): Promise<number> {
    const params: unknown[] = [];
    const where = this.buildWhere(role, filters, asOf, params);
    const rows = await this.deps.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT count(*)::int AS count
       FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id
       WHERE ${where} AND c.embedding IS NOT NULL`,
      ...params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async logQuery(input: {
    query: string;
    role: KbRole;
    k: number;
    filters: SearchFilters;
    hits: SearchHit[];
    evidenceRefs: Citation[];
    degraded: boolean;
    degradeReason: string | null;
    mode: KbSearchMode;
    tookMs: number;
    purpose: 'retrieval' | 'judge_evidence';
  }): Promise<void> {
    try {
      await this.deps.prisma.kbQueryLog.create({
        data: {
          orgId: 1n,
          requestId: `kb-${uuidv7()}`,
          roleCode: input.role,
          purpose: input.purpose,
          query: input.query.slice(0, 1000),
          mode: input.mode,
          topK: input.k,
          filters: {
            domains: input.filters.domains ?? null,
            source_types: input.filters.sourceTypes ?? null,
            platform: input.filters.platform ?? null,
            as_of: input.filters.asOf?.toISOString() ?? null,
            exclude_advisory: input.filters.excludeAdvisory ?? false,
          } as Prisma.InputJsonValue,
          hitCount: input.hits.length,
          hits: input.hits.map((hit) => ({
            chunk_id: hit.chunk_id,
            document_id: hit.document_id,
            score: hit.score,
            vector_rank: hit.vector_rank,
            keyword_rank: hit.keyword_rank,
          })) as Prisma.InputJsonValue,
          citations: input.evidenceRefs as unknown as Prisma.InputJsonValue,
          degraded: input.degraded,
          degradeReason: input.degradeReason,
          latencyMs: input.tookMs,
        },
      });
    } catch {
      // 检索留痕失败不影响检索（但会缺监控数据；M9 接告警）
    }
  }
}
