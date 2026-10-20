# QA 静态门禁与 CI 质量门（t10 基建）

本目录实现 `docs/21-接口契约裁决.md` §11.3 与 `docs/15-测试与质量门策略.md` §9/§10 要求的
静态检查与 PR 门禁。**零运行时依赖**：只用 Node 内置模块，`pnpm install` 后即可执行。

> 状态：t10/t16/t29 已交付；测试库隔离与运行锁见 §6。

## 1. 命令

| 命令 | 作用 | CI 阻断 |
|---|---|---|
| `pnpm lint` | 契约 + 边界静态检查（全部规则） | 是 |
| `pnpm check:contracts` | 只跑 docs/21 §11.3 契约规则 | 是 |
| `pnpm check:boundaries` | 只跑 docs/15 §10 边界规则 | 是 |
| `pnpm test:qa` | 规则引擎单测（24 条，node:test） | 是 |
| `pnpm test` | QA 单测 + 各包 `test` 脚本 | 是 |
| `pnpm typecheck` | 遍历工作区执行各包 `typecheck` | 是 |
| `pnpm db:validate` | `prisma validate` | 是 |
| `pnpm check:migrations` | 空库连续两次 `migrate deploy` | 是 |
| `pnpm test:api` | 测试库运行器（默认 docker；或 reuse 既有库独立库）+ API 测试 | 本地（CI 直接跑 API 测试） |
| `pnpm test:api:local` | 自备 `TEST_DATABASE_URL` 跑 API 测试（不创建/清理库） | 本地 |
| `pnpm e2e` | 全链路 E2E（商品→文案→判定→审批→上架→客服→媒体→知识库；with-db 独立库） | 可选，非 quality-gate |
| `pnpm verify` | 依次执行以上全部门禁（fail fast；`ci` 与 pnpm 内置命令冲突，故用 `verify`） | 本地/CI |

`pnpm verify -- --skip-migrations` 可在没有本地数据库时跳过迁移项；CI **不应**跳过。

## 2. 规则

### 2.1 契约规则（docs/21 §11.3）

| 规则 | 检查内容 | 裁决依据 |
|---|---|---|
| `CT-01` | 出现 `_micro_cny`（含 `price_micro_cny` 这类字段名） | §1 金额一律整数分 `*_cents` |
| `CT-02` | 出现 `scope_value`；或 `model_route` 仍保留 `scope` / `scope_ref` 通用键 | §5 拆列为 `scope_type` + `scope_role_id` + `scope_user_id` |
| `CT-03` | judgment 上下文出现判定值 `revise` / `block` | §3 唯一词表 `pass`/`needs_revision`/`reject`/`escalate` |
| `CT-05` | `workflow_run` 使用 `status` / `phase`；`listing` 使用 `state` / `level`；`workflow_run.state` 默认值不在唯一词表 | §2 状态命名 |

`CT-03` 只在 judgment/verdict 上下文命中，`blocker`、`display:block`、`rollback` 不误报。
`CT-05` 同时扫描 Prisma schema 与 SQL migration：旧字段名、旧 `WorkflowState` 枚举、非法 state 默认值都会命中。

### 2.2 边界规则（docs/15 §10；同时承担 captain 要求的第 4 条）

| 规则 | 检查内容 | 依据 |
|---|---|---|
| `BD-01` | 业务代码引用 `.jsonl` | docs/00 §19.1、docs/15 §10 S1 |
| `BD-02` | 业务代码访问 `dsh-data` / `DSH_HOME` / `.credentials.yaml` / `dsh-storage` | docs/15 §10 S2 |
| `BD-03` | 业务代码 import `@deepseek-ai/dsh-storage-json` | docs/15 §10 S3 |
| `BD-04` | `packages/db` 之外 import `@prisma/client` | docs/15 §10 S4 |
| `BD-05` | `packages/db` 之外出现 `.sql`（`tests/`、`scripts/qa/` 豁免） | docs/15 §10 S5 |
| `BD-06` | 业务依赖出现 playwright / puppeteer / selenium | docs/15 §10 S6 |

边界规则的扫描范围：`apps/**` 与 `packages/{core,registry,adapters-pdd,adapters-1688,judge-rules,edge-proxy,mcp-erp,mcp-knowledge}/**`，
排除 `tests/`、`__tests__/`、`*.test.*`、`*.spec.*`。注释会先被剥离，说明性注释（如“禁止 .jsonl”）不误报。

### 2.3 豁免

- `docs/**`：裁决原文本身包含废止词，必须豁免；
- `scripts/qa/**`：规则实现与测试样本；
- `packages/db/**`：允许 SQL/迁移；但 `CT-01/02/03/05` 仍会扫描 schema 与 migration；
- `node_modules`、`.git`、`.agent-teams`、`.tmp-*`、构建产物等不扫描。

## 3. “迁移可重复”口径

`check-migrations.mjs` 按 captain 口径实现：**对空库连续跑两次 migrate，不报错**。

1. 第一次 `prisma migrate deploy` 在空库应用全部迁移；
2. 第二次必须退出 0 且输出 `No pending migrations`；
3. `prisma migrate status` 退出 0，证明迁移历史与 schema 一致。

数据库来源：

- CI：service `pgvector/pgvector:pg16`，`MIGRATE_CHECK_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/dssaas_ci`；
- 本地：默认从 `packages/db/.env` 的 `DATABASE_URL` 派生 `<db>_migrate_check` 临时库，自动创建/清理，
  **不会改动原库**。也可显式传 `--url`。

安全护栏：非 localhost 需 `--allow-remote`；显式库名必须含 `check/test/ci`，否则需 `--allow-any-db`。

## 4. CI

`.github/workflows/ci.yml` 两个 job：

1. `quality-gate`：`pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm db:validate`；
2. `migration-repeatable`：pgvector 空库 + `pnpm check:migrations`。

任何一项红即禁止合并（docs/15 §9.1）。

## 5. 已知环境问题

pnpm 脚本内部再调用 `pnpm` 时，会继承 `npm_execpath`；在多 agent 并发 `pnpm install` 的机器上，
该路径可能被临时清理，报 `Cannot find module ...pnpm.mjs`。因此：

- `typecheck` / `test` / `prisma` 命令统一改为 Node 直调（`workspace-task.mjs`、`prisma-cli.mjs`、`static-check.mjs`），
  不再依赖嵌套 pnpm；
- `ci.mjs` 直接 spawn `node`，不经过 shell 的 pnpm。

## 6. 测试数据库运行器（t16/t29）

`scripts/qa/with-db.mjs` 让 API 测试在本地可复现，并解决并行开发互相 `DROP SCHEMA` 的问题。
**每次运行一个独立库**；同一台机器默认串行（运行锁），`--parallel` 才允许并发。

### 6.1 三条路径

| 路径 | 命令 | 库来源 | 适用 |
|---|---|---|---|
| A. docker（默认） | `pnpm test:api` | 一次性 `pgvector/pgvector:pg16` 容器（随机端口/库名/口令、`--rm`） | 干净机器；需要 docker |
| B. reuse 既有库 | `DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL=postgresql://.../dssaas_test?schema=public pnpm test:api` | 既有 Postgres 中创建 `dssaas_test_<6hex>` 独立库，跑完 DROP | 本机已有 PG（如 WSL 容器），避免反复拉镜像 |
| C. 自备库 | `TEST_DATABASE_URL=postgresql://.../dssaas_test_<...>?schema=public pnpm test:api:local` | 调用方自备并自行清理 | 调试/特殊环境；库名守卫仍生效 |

> reuse 模式只创建/删除 `dssaas_test_<6hex>`，**不会动 base URL 指向的库**；需要 base 连接用户具备 CREATEDB 权限。

### 6.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSSAAS_DB_REUSE` | 空 | `1` 启用既有库独立库模式（需 `DSSAAS_PG_BASE_URL`） |
| `DSSAAS_PG_BASE_URL` | 空 | 既有 Postgres URL；建议指向一个测试库作为 base（仅用于建库/连接） |
| `DSSAAS_DOCKER_BIN` | `docker` | docker 命令；Windows 无 Docker CLI 时可用 `"wsl docker"` |
| `DSSAAS_DB_HOST` | `127.0.0.1` | docker 容器连接主机；WSL/远程 docker 引擎时设为可达 IP |
| `DSSAAS_TEST_IMAGE` | `pgvector/pgvector:pg16` | docker 镜像 |
| `DSSAAS_KEEP_DB` | 空 | `1` 成功也保留库/容器并打印连接串；`0` 失败也强制清理；默认失败保留、成功清理 |
| `DSSAAS_EXPECT_DB_PREFIX` | 由运行器设置 | `run.ts` 库名前缀守卫；手动直连时可自行设置 |
| `TEST_DATABASE_URL` | — | 路径 C 必填；路径 A/B 由运行器注入 |

### 6.3 并发与锁

- 运行锁文件：`<os.tmpdir()>/dssaas-with-db-<repo-hash>.lock`，内容含 `pid` / `startedAt` / `command`；
- 已有活跃运行时**默认串行等待**（每 10s 打印一次等待信息）；PID 已死或锁超过 2h 视为僵尸锁自动清理；
  最长等待 30min；
- `--parallel` 显式跳过锁并打印警告；因每次运行库独立，数据层不会互踢，但仍可能争抢 docker/端口资源；
- 退出/失败都会释放锁；`DSSAAS_KEEP_DB=1` 或失败（默认）时保留库并打印**完整连接串**与清理命令。

### 6.4 库名与守卫

- reuse：`dssaas_test_<6 hex>`；
- docker：`dssaas_<8 hex>_test`；
- `apps/api/test/run.ts` 允许：`_test` 结尾、`dssaas_test_<6hex>`、`dssaas_ci`（CI service）；
  若设置 `DSSAAS_EXPECT_DB_PREFIX`，库名还须以该前缀开头，否则 exit 2（防误连共享库）。

### 6.5 CI 说明

GitHub Actions 使用干净的 `pgvector/pgvector:pg16` service（`dssaas_ci`），**不需要**运行锁或复用机制；
CI 的 API 测试步骤直接 `pnpm --filter @dssaas/api test`。本机制只服务本地并行开发。

## 7. 全链路 E2E（t38）

`pnpm e2e` 用 `scripts/e2e/full-chain.mjs` 跑 12 步跨模块链路（含 seed、黄金集导入、文案、L1+L2、审批、上架 dry-run、客服/SSE、回复 dry-run、媒体 mock、KB 检索），输出 `artifacts/e2e/report.json`。它同样用 `with-db` 建独立库，所以不会污染开发库。

**何时跑：**

- 跨模块改动（商品/内容/判断/审批/写入门/客服/媒体/KB 任一接口或状态机变更）合并前；
- 发布候选（RC）或 nightly；可用 CI `workflow_dispatch`/单独 job 跑，不放进 `quality-gate` 的必过项；
- 排查“单模块测试都过、串起来失败”的问题时优先跑它，报告里有每步耗时、断言与 `request_id`。

**环境：**

- 默认 docker 路径：`pnpm e2e`；
- 已有 Postgres：`DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL=postgresql://.../dssaas_test?schema=public pnpm e2e`（跑完 DROP 独立库）；
- 本机无 Docker CLI 时用 `DSSAAS_DOCKER_BIN="wsl docker"` 或直接走 reuse 路径。

**已知缺口（截至 2026-10-20，详见 `docs/验收记录-E2E.md §4`）：** 媒体渲染 `purpose=render` 与 DB CHECK 不一致（blocker）、媒体 HTTP API 只有 cancel、草稿判断无法携带 KB 政策证据。E2E 当前以 expected failure 记录，不掩盖单模块测试结果。
