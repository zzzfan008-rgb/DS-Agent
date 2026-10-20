/**
 * 嵌入调用（docs/09 §6）：只走模型网关 `purpose=embed`，不接受降级模型。
 *
 * 关键约束：
 * - 向量维度必须与 `kb_chunk.embedding vector(1024)` 一致；不一致直接失败，不写错向量；
 * - 先 L2 归一化再入库/查询（cosine 与内积等价）；
 * - 失败返回 null（调用方降级为关键词并置 `index_status='stale'`），绝不写零向量；
 * - registry 策略规定 operator 不能用 embed；嵌入是服务端系统能力，这里用 admin 服务主体，
 *   业务上传权限仍由路由层 `minRole=operator` 控制（见验收记录 D3）。
 */
import type { ModelGateway, Principal } from '@dssaas/registry';
import type { PrismaClient } from '@dssaas/db';
import { l2Normalize } from './ids.js';

export const EMBEDDING_DIM = 1024;

export class EmbeddingUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingUnavailableError';
  }
}

export interface EmbeddingRequestContext {
  requestId: string;
  userId: string;
  orgId: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  modelId: string;
  costCents: number;
  inputTokens: number;
}

export class KnowledgeEmbedder {
  private adminRoleId: string | null = null;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      gateway: ModelGateway;
    },
  ) {}

  private async adminPrincipal(context: EmbeddingRequestContext): Promise<Principal> {
    if (this.adminRoleId === null) {
      const role = await this.deps.prisma.role.findFirst({
        where: { code: 'admin', orgId: BigInt(context.orgId), archivedAt: null },
        select: { id: true },
      });
      if (!role) throw new EmbeddingUnavailableError('缺少 admin 角色，无法解析 embed 路由');
      this.adminRoleId = role.id;
    }
    return {
      orgId: context.orgId,
      userId: context.userId,
      roles: ['admin'],
      roleIds: [this.adminRoleId],
    };
  }

  /** 批量嵌入；任何失败都抛 EmbeddingUnavailableError（调用方决定降级）。 */
  async embed(texts: readonly string[], context: EmbeddingRequestContext): Promise<EmbeddingResult> {
    if (texts.length === 0) throw new EmbeddingUnavailableError('没有可嵌入的文本');
    try {
      const principal = await this.adminPrincipal(context);
      const estimateTokensIn = texts.reduce(
        (sum, text) => sum + Math.max(1, Math.ceil([...text].length / 2)),
        0,
      );
      const result = await this.deps.gateway.invoke({
        principal,
        purpose: 'embed',
        requestId: context.requestId,
        actorType: 'system',
        actorId: null,
        // schema 的 ck_mcl_subject_type 不含 kb_document（只有 kb_query/other），用 other；详见验收记录 D2。
        subjectType: 'other',
        params: { inputs: texts, dim: EMBEDDING_DIM },
        estimate: { tokensIn: estimateTokensIn },
      });
      const rawVectors = result.response.vectors;
      if (!Array.isArray(rawVectors) || rawVectors.length !== texts.length) {
        throw new EmbeddingUnavailableError('embed provider 未返回与输入数量一致的向量');
      }
      const vectors: number[][] = [];
      for (const raw of rawVectors) {
        if (!Array.isArray(raw) || raw.length !== EMBEDDING_DIM) {
          throw new EmbeddingUnavailableError(
            `embed 维度不是 ${EMBEDDING_DIM}（实际 ${Array.isArray(raw) ? raw.length : 'n/a'}）`,
          );
        }
        const normalized = l2Normalize(raw.map((value) => Number(value)));
        if (!normalized) throw new EmbeddingUnavailableError('embed 返回零向量，拒绝写入');
        vectors.push(normalized);
      }
      return {
        vectors,
        modelId: result.decision.modelId,
        costCents: result.costCents,
        inputTokens: result.usage.inputTokens ?? estimateTokensIn,
      };
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new EmbeddingUnavailableError(`嵌入服务不可用：${message}`);
    }
  }
}
