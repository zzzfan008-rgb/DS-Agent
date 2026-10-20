# QA 验收记录（t10 · CI 门禁 / 契约测试 / 故障注入）

| 项 | 内容 |
|---|---|
| 编号 | QA-ACCEPT-001 |
| 关联任务 | t10 质量：CI 门禁、契约测试、故障注入骨架（deps: t2） |
| 状态 | **预置（t10 未 claim：依赖 t2 尚未完成）；CI 基建与静态门禁已先行落地并验证** |
| 日期 | 2026-10-20 14:19（Asia/Shanghai） |
| 依据 | docs/15《测试与质量门策略》§2.1/§9/§10、docs/21《接口契约裁决》§11.3、docs/00 §19.1、captain 2026-10-20 指令 |
| 修改人 | qa |

## 0. 结论先行

1. **静态门禁已按 docs/21 §11.3 的五条口径实现**，命中即退出码 1；`pnpm lint` 已接入根脚本与 GitHub Actions。
2. **CI 所需命令均可执行**：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm db:validate`、`pnpm check:migrations`。
   - 其中 `typecheck`（11 个包）、`test`（24 条 QA 单测）、`db:validate`、`check:migrations` 已实测通过；
   - `pnpm lint` 当前**按设计失败**，唯一命中项为 t1 的 `workflow_run.state` 默认值 `queued`（见 §4）；t11 修复并附 `pnpm lint` 转绿输出前，红灯属预期，**不得为变绿放宽规则或加白名单**。
3. **未改任何 schema**（遵守 captain 指令）。t1 契约偏差已定位到行号，报 captain 与 db-infra。
4. t10 的契约录制回放、故障注入骨架、黄金集目录、验收口径核对，待依赖 t2 解锁后继续；本记录届时补全。

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `scripts/qa/lib/static-rules.mjs` | 静态规则引擎：CT-01/02/03/05 + BD-01~06，含 Prisma model/enum 与 SQL CREATE TABLE/TYPE 结构解析 |
| `scripts/qa/static-check.mjs` | `pnpm lint` 入口；支持 `--contracts` / `--boundaries` / `--json` / `--root` |
| `scripts/qa/check-migrations.mjs` | 迁移可重复门禁：空库连续两次 `migrate deploy` + `migrate status`，自动建/删临时库 |
| `scripts/qa/ci.mjs` | 本地门禁编排（fail fast），与 CI 同序 |
| `scripts/qa/workspace-task.mjs` | 工作区任务运行器（替代嵌套 `pnpm -r`，避免并发 install 的 pnpm 路径问题） |
| `scripts/qa/prisma-cli.mjs` | Prisma CLI 包装器（固定 cwd `packages/db`，不经过嵌套 pnpm） |
| `scripts/qa/__tests__/static-rules.test.mjs` | 规则单测 24 条（命中/不误报/行号/CLI 退出码） |
| `scripts/qa/README.md` | 规则口径、命令、豁免、迁移检查与 CI 说明 |
| `.github/workflows/ci.yml` | PR 门禁：quality-gate + migration-repeatable 两个 job |
| `package.json` | 新增 `lint`、`test`、`test:qa`、`check:contracts`、`check:boundaries`、`check:migrations`、`verify`、`db:migrate:check` |

## 2. 静态规则口径（与 docs/21 §11.3 一一对应）

| captain 要求 | 实现规则 | 说明 |
|---|---|---|
| 1) 出现 `_micro_cny` | `CT-01` | 覆盖 `price_micro_cny` 这类字段名（下划线属于 `\w`，不能用 `\bmicro_cny`） |
| 2) 出现 `scope_value` | `CT-02` | 同时拦截 `model_route` 上换名规避的 `scope` / `scope_ref`；Prisma 与 SQL 都查 |
| 3) judgment 上下文出现 `revise` / `block` | `CT-03` | 查 `JudgmentVerdict` 枚举块、`verdict:` 对象字面量、judgment 邻近上下文；`blocker`/`display:block`/`rollback` 不误报 |
| 4) 业务代码读 DSH `.jsonl` 或存储根 | `BD-01/02/03` | 扫描 `apps/**` 与业务 packages；注释剥离，说明性注释不误报；同时拦 `@prisma/client` 越界（BD-04）、业务 SQL（BD-05）、浏览器自动化（BD-06） |
| 5) `workflow_run` 用 `status`/`phase`；`listing` 用 `state`/`level` | `CT-05` | Prisma model + SQL migration 双查；额外校验 `workflow_run.state` 默认值必须在 docs/21 §2 唯一词表内 |

豁免：`docs/**`（裁决原文含废止词）、`scripts/qa/**`（规则实现/样本）、`packages/db/**`（允许 SQL，但仍扫描 schema/migration 的契约命名）。

> 规则设计保留（captain 2026-10-20 确认）：
> ① `scope_value` 之外同时拦截 `model_route` 的 `scope`/`scope_ref` 换名规避；后续所有门禁按“改个名绕过同样失败”的标准实现；
> ② `revise|block` 只在 judgment/verdict 上下文命中，不把 `blocker`/`display:block`/`rollback` 做成噪音。

## 3. 验证记录

| 命令 | 结果 | 证据摘要 |
|---|---|---|
| `node --test "scripts/qa/__tests__/*.test.mjs"` | 通过 | 24 tests / 24 pass / 0 fail；覆盖五类命中 + 三类不误报 + CLI 退出码 |
| `pnpm test` | 通过（exit 0） | QA 24 条单测通过；工作区暂无包级 `test`，runner 正常跳过 |
| `pnpm typecheck` | 通过（exit 0） | 11 个包全部通过（`@dssaas/api/core/db/worker/adapters-*/edge-proxy/judge-rules/mcp-*/registry`） |
| `pnpm db:validate` | 通过（exit 0） | `The schema at prisma/schema.prisma is valid` |
| `pnpm check:migrations -- --url <临时 pgvector 空库> --allow-remote` | 通过（exit 0） | 第一次 deploy 成功；第二次返回 `No pending migrations`；`migrate status` 退出 0；1 个迁移 |
| `pnpm lint` | **失败（exit 1，预期）** | 命中 2 处 `workflow_run.state` 默认值 `queued`，见 §4 |

迁移检查使用的临时库：`pgvector/pgvector:pg16` 容器，库名 `dssaas_migrate_check`（与业务库隔离，检查后清理/保留由 `--keep` 控制）。

### 3.1 迁移 diff 已知噪声登记（docs/06 §0.9）

`prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <空库> --exit-code` 当前固定返回 2，输出 **200 行**。经 2026-10-20 实测，构成如下：

| 类别 | 行数 | 性质 |
|---|---|---|
| `Removed foreign key` | 91 | 迁移中手工创建的外键，Prisma 不感知 |
| `Removed index` | 42 | 手工部分唯一/普通索引，Prisma 不感知 |
| `Removed unique` 约束 | 4 | 手工唯一约束，Prisma 不感知 |
| `Altered column approval.expires_at` 默认值 | 1 | DB 存 `(now() + '72:00:00'::interval)`，Prisma 输出 `now() + interval '72 hours'`，等价表达 |
| 表头/空行等 | 62 | 31 张受影响表的 `[*] Changed the ... table` 及其空行 |

**结论**：这些差异全部是迁移中手工创建的 CHECK / 部分唯一索引 / 外键 / 触发器与默认值等价表达式，**不是数据库漂移**；按 `docs/06 §0.9`、`docs/验收记录-M1-骨架.md §5.4` 与 captain 2026-10-20 指示进入白名单。

**告警口径**：
- 基线固定为 200 行；类别计数以本表为准；
- 若总行数或任一类别计数**显著变化（例如翻倍）**，或出现新的差异类别（表/列增删、类型变化、手工约束批量消失），视为 **schema 漂移信号**：CI 告警并人工核对，**不得自动扩充白名单**；
- t10 正式实现漂移门禁时，按此基线做白名单过滤，只对 Prisma 生成的表/列做严格 diff。

## 4. t1 契约核对结果（schema vs docs/21）

t1 已完成，schema（986 行）与迁移（1771 行）已按 docs/21 重写，以下项已对齐：

| docs/21 条款 | 状态 | 证据 |
|---|---|---|
| §1 金额整数分 `*_cents` | 对齐 | `product_sku.price_cents/list_price_cents/sale_price_cents/cost_cents`、`model_call_log.cost_cents`、`media_job.*_cents` |
| §2 `workflow_run.state` + `stage` | 对齐 | schema `state`/`stage`；migration `ck_workflow_state` 词表为 docs/21 唯一词表 |
| §2 `listing.status` + `platform_state` | 对齐 | schema `status`/`platformState`；migration `ck_listing_status` 为 5 态 |
| §3 `judgment.verdict` 词表 | 对齐 | migration `ck_verdict` = `pass/needs_revision/reject/escalate` |
| §5 `model_route` 作用域拆列 | 对齐 | `scope_type/scope_role_id/scope_user_id` + `ck_route_scope` CHECK |
| §6 商品价格/尺码表 | 对齐 | `price_cents`、`version_no`、`sku_size_code`、`effective_from timestamptz` |
| §7 `content_draft.content_type` | 对齐 | `content_type` + `ck_content_type` 词表 |
| §8 配额键 | 对齐 | `rpm/tpm/concurrency/daily_calls/daily_cost_cents/monthly_cost_cents` |

**唯一未对齐项（blocker，需 db-infra 修复）**：

| 位置 | 问题 | 影响 | 建议修法 |
|---|---|---|---|
| `packages/db/prisma/schema.prisma:776` | `WorkflowRun.state String @default("queued")`，`queued` 不在 docs/21 §2 唯一词表 | 省略 state 的 INSERT 会取默认值 `queued` | 改为 `@default("pending")` |
| `packages/db/prisma/migrations/20261020142000_init/migration.sql:721` | `"state" TEXT NOT NULL DEFAULT 'queued'`，同时 `ck_workflow_state` 只允许 `pending/running/waiting_human/succeeded/failed_retryable/failed_permanent/cancelled` | **默认值与 CHECK 冲突**：省略 state 的 INSERT 必然失败 | 迁移未合并则直接改默认值为 `pending`；已合并则新增迁移 `ALTER TABLE workflow_run ALTER COLUMN state SET DEFAULT 'pending'` |

> 处置：captain 已建 t11（db-infra，依赖 t1）修复默认值，并要求顺带核对其余列 DEFAULT 是否都在各自词表内（`listing.status` / `approval.status` / `media_job.status` / `media_asset.status` / `judgment.verdict`），完成后附 `pnpm lint` 转绿的真实输出。t11 完成前本项保持打开。
> QA 未修改 schema/migration；`pnpm lint` 的 2 处命中即上述两行。修复后 `pnpm lint` 应转绿。

## 5. CI 门禁编排

`.github/workflows/ci.yml`：

- `quality-gate`：checkout → pnpm 11.19.0 → Node 22 → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm db:validate`；
- `migration-repeatable`：`pgvector/pgvector:pg16` service（`dssaas_ci` 空库）→ `pnpm check:migrations`；
- 任一 job 红即禁止合并（docs/15 §9.1）。

## 6. 后续（t10 正式 claim 后）

1. 契约测试夹具与录制回放骨架：**等 docs/12 定稿后再做**（captain 2026-10-20 指示：docs/12 正在重写，将补 28 个端点与 22 个错误码；按旧版建夹具会全部作废）。t10 保持 t2 依赖，不提前开工；
2. 故障注入骨架：超时 / 5xx / 限流（429）/ 部分成功 / 重复回调，断言确定性错误码与重试分类；
3. 黄金集目录与 `golden.lock.json` 骨架（docs/15 §7）；
4. 验收口径核对：逐条对照 docs/00 §18 验收清单与 docs/15 §9 门禁项；
5. 将本记录更新为 t10 最终验收状态，并附 CI 运行证据。

## 7. 风险与待决策

1. **t1 blocker（已建 t11）**：`workflow_run.state` 默认值 `queued` 与 CHECK 冲突。在 t11 修复前，任何省略 state 的写入都会失败；t2/t9 若开始写 workflow_run 会踩到。`pnpm lint` 红灯在 t11 完成前属预期，不得放宽规则或加白名单。
2. **迁移“只增不改”**：docs/15 §9.4 规定已合并迁移禁止编辑。当前初始迁移尚未合并进主分支（git 仅有一个 docs 提交），可直接修正；若 db-infra 已将其视为已合并，则必须新增迁移修正默认值。
3. t10 依赖 t2：本记录在 t10 正式解锁后继续补契约测试/故障注入/黄金集与最终验收。
