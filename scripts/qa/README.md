# QA 静态门禁与 CI 质量门（t10 基建）

本目录实现 `docs/21-接口契约裁决.md` §11.3 与 `docs/15-测试与质量门策略.md` §9/§10 要求的
静态检查与 PR 门禁。**零运行时依赖**：只用 Node 内置模块，`pnpm install` 后即可执行。

> 状态：t10 依赖 t2，尚未正式 claim；本目录为先行落地的 CI 基建。完成后由 `docs/验收记录-QA.md` 归档。

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
