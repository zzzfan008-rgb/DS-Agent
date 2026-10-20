# DSSAAS · 服装电商双平台运营系统（拼多多 + 1688）

自用内部系统，单租户。把服装电商的**内容生产、客服应答、商品上架、素材制作、经营对账**五件事，从「人工逐条做」变成「系统生成 + 人审批 + 系统执行」。

- 方案总纲：`docs/00-方案总纲.md`
- 数据模型（列名/枚举/金额唯一来源）：`docs/06-领域模型与数据字典.md`
- **冲突裁决（优先级最高）**：`docs/21-接口契约裁决.md` —— 与 06/07/11/12 冲突时以其为准
- M1 验收记录：`docs/验收记录-M1-骨架.md`

当前进度：**M1 骨架**（monorepo + Postgres/pgvector schema + 迁移 + Compose）。业务 API / 前端 / adapter 由后续任务填充。

---

## 目录结构

```
apps/
  api/        Fastify：API / 编排 / 写入门 / 模型网关 / 平台适配 / 身份 / 审计
  worker/     BullMQ：媒体、同步、对账、批处理
  web/        Next.js 业务台（12 页面）
packages/
  core/       领域模型与规则、服装强类型校验（SizeChartV1 / FabricCompositionV1 …）
  db/         Prisma schema、迁移、PrismaClient 单例（业务唯一事实源）
  registry/   Provider / Model / Route 三层
  adapters-pdd/ adapters-1688/   平台适配（中心侧）
  edge-proxy/ 按需机房薄代理（转发 + 签名 + 防重放）
  mcp-erp/ mcp-knowledge/        只读 MCP server
  judge-rules/ 判断层规则集与提示词版本
infra/
  docker-compose.yml             postgres(pgvector) / redis / minio / caddy + dsh-data 卷
  Caddyfile                      唯一对外入口
docs/       总纲、领域模型、接口契约、裁决、ADR、验收记录
```

## 前置要求

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22（实测 24.18.0） | `packages/db` 与 apps 均为 TS/ESM |
| pnpm | 11.x（实测 11.19.0） | workspace + `allowBuilds` 放行 Prisma postinstall |
| Docker + Compose | Docker 29.x / Compose v5（实测） | compose 文件在 `infra/`；本机 Docker CLI 装在 WSL Ubuntu-24.04 中 |

## 快速开始

```bash
# 1) 安装依赖（会执行 Prisma engine postinstall，已在 pnpm-workspace.yaml 放行）
pnpm install

# 2) 环境变量（开发默认值即可；.env 已被 .gitignore 忽略）
cp .env.example .env
cp .env.example packages/db/.env        # Prisma CLI 从 packages/db 读取 DATABASE_URL

# 3) 起基础依赖（postgres/redis/minio/caddy）
docker compose -f infra/docker-compose.yml up -d
#    追加业务进程（镜像由后续里程碑构建）：--profile app up -d

# 4) 建表（唯一允许的迁移命令，见「迁移策略」）
pnpm db:deploy

# 5) 校验
pnpm db:validate
pnpm typecheck
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm install --frozen-lockfile` | 按 lockfile 安装（CI） |
| `pnpm db:validate` | `prisma validate`（schema 语法/关系校验） |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:deploy` | `prisma migrate deploy`（**唯一**迁移执行方式） |
| `pnpm db:status` | 迁移状态 |
| `pnpm typecheck` | 全 workspace `tsc --noEmit`（db 会先 generate） |
| `pnpm infra:config` | `docker compose config` 校验 |
| `pnpm infra:up` / `infra:down` | 起停基础依赖 |
| `pnpm e2e` | 全链路 E2E（独立测试库；商品→文案→判定→审批→上架→客服→媒体→KB） |

> `pnpm e2e` 不进 `quality-gate`，建议在跨模块改动合并前、RC/nightly 或串链排障时运行；报告在 `artifacts/e2e/report.json`，细节见 `docs/验收记录-E2E.md` 与 `scripts/qa/README.md §7`。

## 数据模型要点

- **31 张表** = `docs/06` 的 30 张 + `docs/21 §8` 新增的 `media_quota`。
- **金额**：全部 `*_cents` 整数分（`bigint`/`int` 分），禁止 Decimal/float 金额；模型价格是 jsonb 计价单，调用时快照进 `model_call_log.price_snapshot`。
- **主键**：`id uuid`（v7，Prisma 客户端生成）；`audit_log` 另有单调 `seq` 与 `chain_hash` 哈希链。
- **枚举**：`text + CHECK`（不用 PostgreSQL 原生 ENUM），词表在 `docs/06 §2` + `docs/21`；数据库侧兜底，应用层再用 zod/JSON Schema 校验。
- **软删**：`archived_at`；唯一索引一律部分索引 `WHERE archived_at IS NULL`。
- **乐观锁**：`version` 列 + `trg_bump_version`；写操作 `WHERE id = $1 AND version = $2`。
- **服装强类型**：`size_chart`（一尺码一行，`sku_size_code` + `version_no` + `effective_from`）、`fabric_composition.materials`（合计 100，DB 函数校验）、`platform_attribute_mapping`（`internal_field` 白名单防属性外渗）。
- **事实源单一化**：价格/库存/成分/尺码/政策只来自主数据/平台同步/知识库；`price_source`/`stock_source` 词表不含 `model`，`fact_envelope_valid()` 校验草稿事实信封。
- **向量**：`kb_chunk.embedding vector(1024)` + HNSW(cosine, m=16, ef_construction=64) + `tsv` GIN 索引；Prisma 不支持 vector/tsvector，读写走 `$queryRaw`/`$executeRaw`。

## 迁移策略（必读）

Prisma 只负责「表 + 列 + 类型 + 默认值」这一层；**约束、索引、外键、触发器、扩展、种子**都在迁移 SQL 里由人工维护（`packages/db/prisma/migrations/20261020142000_init/migration.sql`）。

原因：`docs/06` 的唯一性大量是**部分唯一索引**（`WHERE archived_at IS NULL` / `status='effective'`），Prisma schema 无法表达；HNSW/GIN、CHECK、触发器也无法表达。

因此：

1. **只用 `prisma migrate deploy`**（`pnpm db:deploy`）；禁止在共享库上跑 `prisma migrate dev`（它会试图「修复」手工索引/约束）。
2. 新增 schema 变更的流程：
   ```bash
   pnpm --filter @dssaas/db exec prisma migrate diff \
     --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
     --shadow-database-url "$SHADOW_DATABASE_URL" --script > /tmp/next.sql
   # 人工审阅 /tmp/next.sql，补齐 CHECK、部分唯一索引、触发器、FK 命名（fk_<表>_<列>）
   mkdir prisma/migrations/<timestamp>_<name> && cp /tmp/next.sql prisma/migrations/<ts>_<name>/migration.sql
   ```
3. `prisma migrate diff --exit-code` 会固定报告约 200 行「removed」——那些正是手工索引/外键。CI 的漂移门禁需要白名单过滤（见 `docs/06 §0.9`），不要把它当作真漂移。
4. `down.sql` 提供手工回滚脚本；Prisma 不会执行 down migration，回滚按 `docs/20 §6` 走备份/恢复卷。

## 已知限制 / 待对齐

| 项 | 现状 | 归属 |
|---|---|---|
| `users.email` 的 `citext` | Prisma 6.19.3 不支持，落为 `text` + `lower(email)` 唯一索引（语义等价） | db |
| `audit_log.ip` 的 `inet` | Prisma 不支持，落为 `text` + 格式 CHECK | db |
| Prisma Client 无 relation | 外键全在 DB（命名 `fk_*`），Client 侧用显式查询/join；如需 `include` 再评审 | db/backend |
| `docs/12 §9.2` 的 8 张扩展表 | `docs/06` 明确不新增核心表，本迁移未建；待 06 增补（`listing_write_log` 优先级 P0） | captain/06 |
| `docs/06` 尺码正则不含 `2XL/3XL` | 与 06 §13.2 示例「2XL」冲突；迁移正则补 `2XL|3XL` | 06 修订 |
| api/worker 镜像 | compose 已声明 `--profile app` 服务与 `dsh-data` 卷，镜像待 M2 构建 | backend |
| 备份脚本 | 卷与备份矩阵已定（docs/20），脚本在 M1 后续/运维任务落地 | db |

## 约定

- 只用 `D:\DSSAAS` 工作区；业务事实只进 Postgres，字节只进 MinIO，DSH 目录只放黑匣子与凭据引用。
- 任何对平台/对外消息的写操作必须经审批与审计（`approval` + `audit_log`），不可逆动作登记 `compensating_ticket`。
- 密钥/凭据不入库、不入 Git、不入普通备份；数据库只存 `credential_ref` 元数据与 DSH 凭据名。
