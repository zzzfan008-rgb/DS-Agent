# QA 验收记录（t10 · CI 门禁 / 契约测试 / 故障注入 / 黄金集）

| 项 | 内容 |
|---|---|
| 编号 | QA-ACCEPT-001 |
| 关联任务 | t10 质量：CI 门禁、契约测试、故障注入骨架（deps: t2） |
| 状态 | **已完成（t10 attempt 1）**；并行任务 t3/t4/t5/t6/t7 的未完成代码会让“全仓 typecheck/test”阶段性变红，见 §3.1 |
| 日期 | 2026-10-20 14:50（Asia/Shanghai） |
| 依据 | docs/15 §2.1/§4/§5.2/§7/§9/§10、docs/21 §11.3、docs/12 v2 §4、docs/00 §19.1、captain 2026-10-20 指令 |
| 修改人 | qa |

## 0. 结论先行

1. **CI 门禁已建成并全部接入**：lint（契约 + 边界）、typecheck、单测/集成、契约回放、故障注入、黄金集、prisma validate、迁移可重复；GitHub Actions 两个 job 均带 pgvector 空库。
2. **静态门禁**按 docs/21 §11.3 五条 + docs/15 §10 实现，当前仓库 **0 违规**（243 个契约文件 / 119 个业务文件 / 8 个 SQL）。
3. **契约回放骨架**：5 条 fixture（PDD/1688 各 2 条 + 1 条业务驳回）、JSON Schema 校验、错误映射表、docs/12 §4 词表自动同步；10/10 测试通过。fixture 标记 `synthetic:true`，因 docs/01/02 明确平台接口文档未取得。
4. **故障注入矩阵**：docs/15 §5.2 的 14 行全部登记，**10 行已实现**（超时 ×2 / 5xx / 429 / 部分成功 / 重复回调 / 契约漂移 ×2 / HTML 错误页 / 签名失败），11/11 测试通过；每行断言错误码、队列状态、审计记录、用户提示四件事。
5. **黄金集**：10 个样例 SKU × 2 平台 → 50 个预期文件 + 4 条负例 + 版本锁；校验器 + 篡改自测 4/4 通过。
6. **迁移可重复**：4 个迁移在空库连续两次 `migrate deploy` + `migrate status` 全通过；`migrate diff` 噪声基线已更新（见 §3.2）。
7. **诚实记录**：全仓 `pnpm typecheck` / `pnpm test` 在 14:50 仍被并行任务 WIP 阻断（t3 agent 路由已修复、t4/t5 adapter 测试与类型仍在写入）；这是并行开发态而非 t10 缺陷，`pnpm lint`、QA 单测、契约、故障、黄金集、API 19 用例、prisma validate、迁移均可独立通过。最终合入由 CI 统一把关。

## 1. 交付物

| 文件/目录 | 说明 |
|---|---|
| `scripts/qa/lib/static-rules.mjs` | 静态规则引擎：CT-01/02/03/05 + BD-01~06 |
| `scripts/qa/static-check.mjs` | `pnpm lint` 入口（`--contracts` / `--boundaries` / `--json`） |
| `scripts/qa/check-migrations.mjs` | 空库连续两次 migrate + status；自动建/删临时库 |
| `scripts/qa/golden-check.mjs` | 黄金集校验器（版本锁 / 硬事实 / 负例） |
| `scripts/qa/ci.mjs` | 本地 `pnpm verify` 编排（fail fast） |
| `scripts/qa/workspace-task.mjs` | 工作区任务运行器（不依赖嵌套 pnpm） |
| `scripts/qa/prisma-cli.mjs` | Prisma CLI 包装器（固定 cwd `packages/db`） |
| `scripts/qa/__tests__/static-rules.test.mjs` | 静态规则单测 24 条 |
| `tests/contract/**` | fixture / Schema / 回放器 / 错误映射 / 10 条测试 / README |
| `tests/fault/**` | 14 行矩阵 / mock 平台 / 参考重试客户端 / 11 条测试 / README |
| `tests/golden/**` | 10 SKU / 50 预期 / 4 负例 / 版本锁 / 校验器自测 / README |
| `.github/workflows/ci.yml` | quality-gate（含 pgvector service）+ migration-repeatable |
| `package.json` | 新增 `test:contract`、`test:fault`、`test:golden`、`check:contracts`、`check:boundaries`、`check:migrations`、`verify` |

## 2. 静态规则口径（不变）

| captain 要求 | 规则 | 说明 |
|---|---|---|
| `_micro_cny` | CT-01 | 覆盖 `price_micro_cny`（下划线属于 `\w`，不能用 `\bmicro_cny`） |
| `scope_value` | CT-02 | 同时拦截 `model_route` 的 `scope` / `scope_ref` 换名规避；Prisma + SQL |
| judgment 的 `revise` / `block` | CT-03 | 枚举块 / `verdict:` 对象 / 邻近上下文；`blocker`、`display:block`、`rollback` 不误报 |
| 业务代码读 DSH `.jsonl` / 存储根 | BD-01/02/03 | 扫描 apps + 业务 packages；剥离注释；另拦 `@prisma/client` 越界、业务 SQL、浏览器自动化依赖 |
| `workflow_run` 旧状态字段 / `listing` 旧字段 | CT-05 | Prisma + migration 双查；`workflow_run.state` 默认值必须在 docs/21 §2 词表内（t11 已修复 `queued`） |

保留 captain 确认的两条设计：① 换名规避同样失败；② judgment 上下文限定，避免规则噪音。

## 3. 验证记录（真实命令输出）

| # | 命令 | 结果 | 证据摘要 |
|---|---|---|---|
| 1 | `pnpm lint` | **通过 exit 0** | 243 契约文件 / 119 业务文件 / 8 SQL / 11 package.json；`✔ 通过：0 处违规` |
| 2 | `pnpm test:qa` | 通过 | 24 tests / 24 pass |
| 3 | `pnpm test:contract` | 通过 | 10 tests / 10 pass（回放、Schema 漂移、错误映射、脱敏） |
| 4 | `pnpm test:fault` | 通过 | 11 tests / 11 pass（FI-01/02/03/04/06/07/10/11/12/13 + 矩阵一致性） |
| 5 | `pnpm test:golden` | 通过 | 4 tests / 4 pass；校验器：10 SKU / 50 预期 / 4 负例，`dataset_sha256=329fdd4c…` |
| 6 | `pnpm db:validate` | 通过 exit 0 | `The schema at prisma/schema.prisma is valid` |
| 7 | `pnpm check:migrations` | 通过 exit 0 | 4 个迁移：第一次 deploy / 第二次 `No pending migrations` / status 一致 |
| 8 | API 集成测试（`pnpm test` 中的 `@dssaas/api`） | 通过 | 19/19 pass（登录/越权/审计/幂等/健康检查） |
| 9 | 全仓 `pnpm typecheck` | **阶段性红** | 14:50 报错集中在并行任务 t4/t5 WIP：`@dssaas/adapters-1688` 的 `src/domain/moq.ts` / `src/mapping/attributes.ts` 类型未收敛；t3 的 agent 路由错误已在 14:40 后修复 |
| 10 | 全仓 `pnpm test` | **阶段性红** | `@dssaas/adapters-pdd` 的 test 脚本引用的 7 个 test 文件尚未创建（t4 正在写）；API 19 用例本身通过 |

> 说明：并行任务 t3/t4/t5/t6/t7 在 14:33–14:50 期间持续写文件；全仓门禁的“最后 1 公里”由 CI 在合入时执行。
> t10 的验收范围（CI/静态/契约/故障/黄金集/迁移）均独立通过；未放宽任何规则来掩盖并行 WIP。

### 3.1 并行开发态的处理

- `pnpm verify` 会 fail fast，当前会在 typecheck 处停下；这是**正确行为**，不应绕过。
- 建议 captain 在 t3/t4/t5/t6/t7 全部 completed 后触发一次 CI/全仓验证；t10 的 gate 已就位。
- t16（API 测试自包含并接入 CI）与本次 CI 集成有重叠：本次已在 CI 中加 pgvector service 并跑通 API 19 用例，t16 可聚焦“测试数据/端口自包含、无需外部容器”。

### 3.2 迁移 diff 已知噪声登记（docs/06 §0.9）

`prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` 固定返回 2（有差异），2026-10-20 实测基线：

| 时点 | 总行数 | 表数 | Removed FK | Removed index | Removed unique | Altered column |
|---|---:|---:|---:|---:|---:|---:|
| t1 初始（31 表，1 迁移） | 200 | 31 | 91 | 42 | 4 | 1（`approval.expires_at` 等价默认值） |
| **当前（t12/t13 后，39 表，4 迁移）** | **248** | **39** | **109** | **55** | **5** | **1** |

- 差异全部是迁移中手工创建的 CHECK / 部分唯一索引 / 外键 / 触发器与默认值等价表达式，**不是数据库漂移**；
- 按 docs/06 §0.9、`docs/验收记录-M1-骨架.md §5.4` 与 captain 指示进入白名单；
- **告警口径**：以当前 248 行为基线；总行数或任一类别显著变化（如翻倍）或出现新差异类别 → schema 漂移信号，CI 告警并人工核对，**不得自动扩充白名单**；
- t10 的漂移门禁实现时按此基线白名单过滤（本次先登记基线，未把 `migrate diff` 加入阻断门禁，避免噪声误伤）。

## 4. t1/t11/t12/t13 schema 核对（docs/21）

- t11 已修复 `workflow_run.state` 默认值 `queued → pending`（schema + migration），`CT-05` 转绿；
- t12/t13 增补 8 张支撑表与 `listing.main_image_id` / `platform_category_id` 等列后：
  - `pnpm lint` 仍 **0 违规**（旧状态名/`_micro_cny`/`scope_value` 均未回潮）；
  - `pnpm db:validate` 通过，迁移可重复通过（4 个迁移）；
  - docs/21 的金额 `_cents`、`workflow_run.state + stage`、`listing.status + platform_state`、`model_route` 拆列、`content_type`、尺码表 `version_no/effective_from`、配额列均保持对齐；
- 未修改 schema/migration（t10 范围外，由 db-infra 负责）。

## 5. CI 门禁编排

`.github/workflows/ci.yml`：

1. `quality-gate`（pgvector service，库 `dssaas_test`）：
   checkout → pnpm 11.19.0 → Node 22 → `pnpm install --frozen-lockfile` → `pnpm db:deploy` →
   `pnpm lint` → `pnpm typecheck` → `pnpm test`（QA + 各包，含 API 19 用例）→
   `pnpm test:contract` → `pnpm test:fault` → `pnpm test:golden` → `pnpm db:validate`；
2. `migration-repeatable`（pgvector service，库 `dssaas_ci`）：`pnpm check:migrations`。

任一 job 红即禁止合并（docs/15 §9.1）。

## 6. 契约回放（骨架）

- fixture：PDD `item.add` 成功/429/业务驳回、1688 `product.get` 成功/签名失败；全部带 `meta`（平台/端点/录制时间/文档版本/录制人/`synthetic`）与脱敏占位符；
- 回放：本地 `node:http` 服务器（127.0.0.1 随机端口，未匹配返回 501），零外网；重复请求按录制顺序回放；
- Schema：零依赖 JSON Schema 子集校验器；缺字段/类型变化会失败（对应 FI-10/FI-11）；
- 错误映射：`error-map.json` 的 external code 由 `docs/12 §4` 实时解析校验，文档删改会导致测试失败；
- 限制：平台接口文档未取得（docs/01/02 结论），fixture 为 synthetic；t4/t5 拿到沙箱后替换真实录制，并补签名可复算钩子。

## 7. 故障注入（矩阵）

- 矩阵：`tests/fault/matrix.json`，14 行全部登记；**10 行 implemented**、4 行 todo（FI-05 token 刷新 / FI-08 回调乱序 / FI-09 新增字段 / FI-14 大响应），todo 均写原因；
- 已实现行覆盖：连接超时、读超时（结果未知）、5xx 退避、429 Retry-After、部分成功、重复回调、契约漂移（缺字段/类型变化）、HTML 错误页、签名失败；
- 四维断言：错误码（internal + external）、队列/重试状态、审计记录、用户提示；
- 对外 code 全部落在 docs/12 §4（如 `signature_invalid` 对外 `unauthorized`、`contract_drift` 对外 `upstream_5xx(detail.sub=contract_drift)`）；
- `support/retry-client.mjs` 是测试基准，t4/t5 adapter 必须复用同一分类口径。

## 8. 黄金集

- 规模：10 个样例 SKU（7 品类、含 2XL–4XL 与数字码）× 2 平台 → 50 个预期文件（copy/size/quote）+ 4 条负例；
- 版本锁：`golden.lock.json` 记录 dataset_sha256、规则版本、提示词版本、模型路由快照；校验器自测证明篡改预期、篡改后同步刷新哈希、负例规则失效都能被发现；
- 硬事实断言：价格/库存/成分/尺码/类目逐字一致；1688 起批量/阶梯价一致；
- 负例：成分 99%、缺必测部位、价格 0、绝对化禁词，期望 code 在 docs/12 §4；
- 限制：当前是结构化样例而非 50 个真实脱敏 SKU；图片类预期待 M4；L2 语义评分待模型网关。
- **与 t15 重叠**：本次已交付“黄金集种子 + 自校验器”；t15 可聚焦扩充到 50 真实 SKU 与图片/语义评分，或由 captain 裁撤合并。

## 9. 风险与后续

1. **并行 WIP**：t3/t4/t5/t6/t7 完成后需再跑一次全仓 CI；当前红灯来自未完成代码，不是门禁缺陷。
2. **契约 fixture 为 synthetic**：真实平台字段/签名待 t4/t5 沙箱录制替换；在替换前，契约测试只证明“回放链路可用”，不证明平台兼容性。
3. **故障矩阵 4 行 todo**：依赖 token 刷新器（t4/t5）、订单状态机（t9）、响应体上限（t4/t5）。
4. **黄金集规模**：10 条为起步，M8 前扩到 50 真实 SKU；数据集变更必须更新 lock 并走 PR 评审。
5. **t16 重叠**：API 测试的 DB service 已接入 CI；t16 可继续做“测试数据/端口自包含”，避免本地需手工容器。

## 10. 复跑命令（本地）

```bash
# 全部门禁（需本地 pgvector；TEST_DATABASE_URL 指向 *_test 库）
TEST_DATABASE_URL='postgresql://dssaas:***@<host>:55434/dssaas_test?schema=public' \
DATABASE_URL="$TEST_DATABASE_URL" \
MIGRATE_CHECK_DATABASE_URL='postgresql://dssaas:***@<host>:55434/dssaas_migrate_check?schema=public' \
MIGRATE_CHECK_ALLOW_REMOTE=1 \
pnpm verify

# 分项
pnpm lint && pnpm typecheck && pnpm test
pnpm test:contract && pnpm test:fault && pnpm test:golden
pnpm db:validate && pnpm check:migrations
```

## 11. 黄金集骨架（t15）

日期：2026-10-20 14:43（Asia/Shanghai）

- **目录** `data/golden/`：
  - `products.csv`：12 条商品（上衣 3 / 裤装 3 / 连衣裙 3 / 外套 3），列含 `spu_code,title,category_code,fabric_json,size_chart_json,qualification_json,platform_pdd_category,platform_1688_category`（另含 `price_cents,stock_qty` 供硬事实断言）；
  - `size-charts.jsonl`：12 条 `SizeChartV1`（docs/06 §6.1，`sku_size_code` 行）；
  - `fabrics.jsonl`：12 条成分（整数百分比、合计 100）；
  - `expected/`：12 条商品期望结论 + `expected/negative/` 4 条负例（成分 99 / 缺资质 / 缺必测部位 / 码集不覆盖）；
  - `README.md`：字段、新增样例流程、评分口径、接入计划。
- **数据虚构自洽**：平台类目用 `FICT-*` 占位符；无真实品牌/店铺/人名/检测报告号；价格与库存自拟。
- **校验器** `node scripts/qa/golden-validate.mjs`：
  - 真实通过输出：`✔ 黄金集校验通过：12 商品（上衣 3 / 裤装 3 / 连衣裙 3 / 外套 3）+ 12 尺码表 + 12 成分 + 12 期望 + 4 负例`（exit 0）；
  - 故意改坏验证（`--root` 副本中把 GOLD-SPU-001 成分 100→98）：exit 1，输出 2 个问题——`成分合计 98% ≠ 100%`、`与 products.csv fabric_json 不一致`；
  - 校验项：CSV 列数/表头/行数、JSON 可解析、成分合计 100、尺码表码集覆盖 SKU、品类必测部位、资质非空、期望与硬事实一致、负例变异确实违规。
- **接入计划**：按 t15 要求**暂未接** `pnpm check:contracts`；后续在 CI quality-gate 增加 `node scripts/qa/golden-validate.mjs`，或并入 `pnpm check:contracts`，与 `tests/golden` 的机器评分器一起跑。
- **差距说明**：目标 50 条，当前 12 条（24%）；缺真实脱敏商品、图片类预期（尺寸/比例/AIGC/EXIF）与 L2 语义评分。与 `tests/golden/`（t10 交付的 10 SKU 机器评分基线 + 版本锁）互补，M8 前合并去重。
- **版本控制**：`.gitignore` 将 `data/` 调整为 `data/*` + `!data/golden/`，其余 `data/` 内容仍忽略；黄金集纳入版本控制以便后续 CI 校验。

## 12. 测试自包含（t16）

日期：2026-10-20 14:52（Asia/Shanghai）

- **背景**：t2 的 `apps/api/test/run.ts` 硬编码 `localhost:55434` 一次性容器地址，干净机器不可复现；CI 未显式跑 API 测试。
- **修改**：
  - `apps/api/test/run.ts`：只读 `TEST_DATABASE_URL`；缺失时打印可执行提示并 **exit 2**（不再静默回落）；`_test` 库名守卫保留。
  - `scripts/qa/with-db.mjs`：docker 起一次性 `pgvector/pgvector:pg16`（随机端口/随机库名/随机口令/`--rm`）→ 就绪等待（60s）→ `prisma migrate deploy` → 注入 `TEST_DATABASE_URL`/`DATABASE_URL` 执行传入命令 → **无论成败** `docker rm -f` 并打印清理结果。docker 不可用 exit 3；端口冲突重试一次；启动/超时/migrate/清理失败 exit 4；其余透传命令退出码。支持 `DSSAAS_DOCKER_BIN`、`DSSAAS_DB_HOST`、`DSSAAS_TEST_IMAGE`。
  - `package.json`：`test:api`（with-db + API 测试）与 `test:api:local`（自备库，只读 `TEST_DATABASE_URL`）。
  - CI：`migration-repeatable` job 增加“API tests”步骤，复用 `dssaas_ci` service，先 `pnpm db:deploy` 再 `pnpm --filter @dssaas/api test`；原迁移可重复步骤保持不动。
- **两次真实运行**（本机 Windows 无 Docker CLI，用 `DSSAAS_DOCKER_BIN="wsl docker"` + `DSSAAS_DB_HOST=<wsl-ip>` 验证）：
  - run 1：`container=dssaas-qa-cbe4cae2 port=56340 db=dssaas_78faac8f_test` → `tests 46 / pass 46 / fail 0`，`清理完成：容器 dssaas-qa-cbe4cae2 已销毁`，exit 0；
  - run 2：`container=dssaas-qa-73854bc4 port=58922 db=dssaas_87fc2276_test` → `tests 46 / pass 46 / fail 0`，`清理完成：容器 dssaas-qa-73854bc4 已销毁`，exit 0；
  - 两次端口不同均成功；46 条为当前全量（t2 的 19 条 + t3/t7 新增用例），t2 原 19 条全部通过。
- **边界验证**：
  - 清空 `TEST_DATABASE_URL` 运行 `test:api:local` → `[test] 缺少 TEST_DATABASE_URL；拒绝回落到硬编码端口。` + exit 2；
  - `DSSAAS_DOCKER_BIN=__no_such_docker__` → `[with-db] Docker 不可用：spawnSync ... ENOENT` + 安装/CI service 提示 + exit 3；
  - 失败路径同样打印容器清理结果（首轮调试运行时已验证 `清理完成`）。
- **已知限制**：
  - 需要 docker（CI 用 GitHub Actions service，不需要 docker-in-docker）；
  - 远程/WSL docker 需设置 `DSSAAS_DB_HOST`；镜像需可拉取；就绪超时 60s；端口冲突仅重试一次；
  - 测试运行会 `DROP/CREATE SCHEMA public`（run.ts 以 `_test` 库名守卫），只能指向一次性/测试库。
- **并行 WIP 备注**：本机 `pnpm lint` 在 14:52 被并行任务新文件 `packages/core/src/schema/garment.ts:4` 的说明性注释命中 `micro_cny`（非 t16 引入，且不是字段使用）；已报告 captain 协调，未放宽规则。
