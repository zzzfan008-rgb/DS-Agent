/**
 * 知识库路由（docs/12 §3.10）：
 *   POST   /api/kb/documents        multipart（md/txt/pdf）或 JSON 兜底；operator+
 *   GET    /api/kb/documents        列表；viewer+
 *   DELETE /api/kb/documents/:id    软删 + 退出索引；admin
 *   GET    /api/kb/search           混合召回；viewer+
 *
 * 引用与降级由 KnowledgeService 负责；路由只做鉴权/参数校验/上传解析。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import { serviceContext } from '../lib/service-context.js';
import {
  KB_DOC_TYPES,
  KB_DOMAINS,
  KB_SOURCE_TYPES,
  type KbDomain,
  type KbRole,
} from '../knowledge/service.js';

const DomainSchema = z.enum(KB_DOMAINS);
const SourceTypeSchema = z.enum(KB_SOURCE_TYPES);
const DocTypeSchema = z.enum(KB_DOC_TYPES);

const SearchQuery = z
  .object({
    q: z.string().min(1).max(500),
    k: z.coerce.number().int().min(1).max(50).optional(),
    domain: z.string().optional(),
    source_type: z.string().optional(),
    platform: z.enum(['pdd', '1688']).optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
    filters: z.string().max(2000).optional(),
  })
  .strict();

const DocumentListQuery = z
  .object({
    domain: z.string().optional(),
    status: z.string().optional(),
    q: z.string().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.string().optional(),
  })
  .strict();

const ArchiveBody = z.object({ reason: z.string().min(1).max(500) }).strict();

const JsonIngest = z
  .object({
    title: z.string().min(1).max(200),
    domain: DomainSchema,
    file_name: z.string().min(1).max(200),
    mime: z.string().max(120).optional(),
    content: z.string().max(5 * 1024 * 1024).optional(),
    content_base64: z.string().max(8 * 1024 * 1024).optional(),
    source_ref: z.string().min(1).max(500).optional(),
    source_type: SourceTypeSchema.optional(),
    doc_type: DocTypeSchema.optional(),
    effective_at: z.string().datetime({ offset: true }).optional(),
    effective_to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((value) => value.content !== undefined || value.content_base64 !== undefined, {
    message: 'content 或 content_base64 必须提供一个',
  });

const MultipartFields = z.object({
  title: z.string().min(1).max(200),
  domain: DomainSchema,
  source_ref: z.string().min(1).max(500).optional(),
  source_type: SourceTypeSchema.optional(),
  doc_type: DocTypeSchema.optional(),
  effective_at: z.string().datetime({ offset: true }).optional(),
  effective_to: z.string().datetime({ offset: true }).optional(),
});

function contextOf(request: FastifyRequest) {
  const context = serviceContext(request);
  return {
    requestId: context.requestId,
    userId: context.userId,
    role: context.role as KbRole,
    ip: context.ip,
    userAgent: context.userAgent,
  };
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseDomains(raw: unknown): readonly KbDomain[] | undefined {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? splitList(raw) : undefined;
  if (!items) return undefined;
  const parsed = items.map((item) => DomainSchema.parse(item));
  return parsed;
}

function parseSourceTypes(raw: unknown): readonly string[] | undefined {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? splitList(raw) : undefined;
  if (!items) return undefined;
  return items.map((item) => SourceTypeSchema.parse(item));
}

async function readMultipart(request: FastifyRequest): Promise<{
  fields: Record<string, string>;
  file: { buffer: Buffer; fileName: string; mime: string | null } | null;
}> {
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; fileName: string; mime: string | null } | null = null;
  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (file) throw new ApiError('validation_failed', '一次只能上传一个文件');
        file = { buffer, fileName: part.filename, mime: part.mimetype ?? null };
      } else {
        fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
      throw new ApiError('payload_too_large', '文件超过 5MB 上限', { detail: { limit_bytes: 5 * 1024 * 1024 } });
    }
    throw error;
  }
  return { fields, file };
}

export function registerKnowledgeRoutes(app: FastifyInstance): void {
  app.post('/api/kb/documents', { config: { minRole: 'operator' } }, async (request, reply) => {
    const context = contextOf(request);
    const contentType = String(request.headers['content-type'] ?? '');
    let input: Parameters<FastifyInstance['knowledge']['ingest']>[0];

    if (contentType.includes('multipart/form-data')) {
      const { fields, file } = await readMultipart(request);
      if (!file) throw new ApiError('validation_failed', '缺少 file 字段');
      const parsedFields = MultipartFields.parse(fields);
      input = {
        title: parsedFields.title,
        domain: parsedFields.domain,
        fileName: file.fileName,
        mime: file.mime,
        buffer: file.buffer,
        sourceRef: parsedFields.source_ref ?? null,
        sourceType: parsedFields.source_type ?? null,
        docType: parsedFields.doc_type ?? null,
        effectiveAt: parsedFields.effective_at ? new Date(parsedFields.effective_at) : null,
        effectiveTo: parsedFields.effective_to ? new Date(parsedFields.effective_to) : null,
      };
    } else if (contentType.includes('application/json')) {
      const body = JsonIngest.parse(request.body ?? {});
      const buffer = body.content_base64
        ? Buffer.from(body.content_base64, 'base64')
        : Buffer.from(body.content ?? '', 'utf8');
      if (buffer.length === 0) throw new ApiError('validation_failed', '文件内容为空');
      if (buffer.length > 5 * 1024 * 1024) {
        throw new ApiError('payload_too_large', '文件超过 5MB 上限', {
          detail: { limit_bytes: 5 * 1024 * 1024 },
        });
      }
      input = {
        title: body.title,
        domain: body.domain,
        fileName: body.file_name,
        mime: body.mime ?? null,
        buffer,
        sourceRef: body.source_ref ?? null,
        sourceType: body.source_type ?? null,
        docType: body.doc_type ?? null,
        effectiveAt: body.effective_at ? new Date(body.effective_at) : null,
        effectiveTo: body.effective_to ? new Date(body.effective_to) : null,
      };
    } else {
      throw new ApiError('unsupported_media_type', '请使用 multipart/form-data 上传文件，或 application/json + content');
    }

    const result = await app.knowledge.ingest(input, context);
    request.auditLogged = true;
    reply.code(result.deduplicated ? 200 : 201);
    return ok(request, result);
  });

  app.get(
    '/api/kb/documents',
    { config: { minRole: 'viewer', audit: false } },
    async (request) => {
      const query = DocumentListQuery.parse(request.query ?? {});
      const result = await app.knowledge.listDocuments(query);
      return ok(request, result);
    },
  );

  app.delete(
    '/api/kb/documents/:id',
    { config: { minRole: 'admin' } },
    async (request) => {
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = ArchiveBody.parse(request.body ?? {});
      const result = await app.knowledge.archiveDocument(params.id, body.reason, contextOf(request));
      request.auditLogged = true;
      return ok(request, result);
    },
  );

  app.get(
    '/api/kb/search',
    { config: { minRole: 'viewer', audit: false } },
    async (request) => {
      const query = SearchQuery.parse(request.query ?? {});
      let filtersFromJson: Record<string, unknown> = {};
      if (query.filters) {
        try {
          const parsed = JSON.parse(query.filters) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('filters must be object');
          }
          filtersFromJson = parsed as Record<string, unknown>;
        } catch {
          throw new ApiError('validation_failed', 'filters 必须是 JSON 对象', {
            detail: { field: 'filters' },
          });
        }
      }
      const domains = parseDomains(filtersFromJson.domain ?? query.domain);
      const sourceTypes = parseSourceTypes(filtersFromJson.source_type ?? query.source_type);
      const platformRaw = filtersFromJson.platform ?? query.platform;
      const asOfRaw = filtersFromJson.as_of ?? query.as_of;
      const context = contextOf(request);
      const result = await app.knowledge.search({
        query: query.q,
        k: query.k ?? 10,
        role: context.role,
        filters: {
          domains,
          sourceTypes,
          platform: typeof platformRaw === 'string' ? platformRaw : null,
          asOf: typeof asOfRaw === 'string' ? new Date(asOfRaw) : null,
          excludeAdvisory: filtersFromJson.exclude_advisory === true,
        },
      });
      return ok(request, result);
    },
  );
}

/** 参数辅助：供测试/调用方复用。 */
export { DomainSchema, SourceTypeSchema, DocTypeSchema };
