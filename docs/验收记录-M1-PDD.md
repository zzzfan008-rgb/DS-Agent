# 验收记录 · M1 · 拼多多适配骨架（t4）

| 项 | 内容 |
|---|---|
| 任务 | t4 拼多多适配骨架 |
| 执行人 | adapter-pdd |
| 日期 | 2026-10-20 |
| 源码基线 | t1（monorepo/schema）+ t2（API 骨架）已完成；t10 的契约测试库（`tests/contract/lib`）已在工作区 |
| 依据 | `docs/01-平台接入侦察-拼多多.md`（含逐接口「待填」核验表）、`docs/12` §4/§6、`docs/21`、`docs/11` §5/§6、`docs/19` §2/§3、`docs/00` §8/§9、ADR-0006 |
| 结论 | **通过**。dry-run 上架包样例已生成；54/54 单测通过（含回放、签名、限流、重试、留档、transport）；28 条接口全部建桩且无一条被编造为已核验。 |

---

## 0. 结论先行

1. `packages/adapters-pdd` 已从空壳成为可运行的适配骨架：接口注册表、HTTP client（占位签名 + 时间戳/nonce 防重放 + 令牌桶 + 退避重试 + JSON 留档）、录制回放、CSV/XLSX 上架包导出器、两个 CLI。
2. **28 条接口全部 `unverified`**：`platform_method/platform_version/path_template` 一律 `null`，TODO 原文回指 `docs/01 §2.x 第 N 行`；`requireCallable()` 在 live 模式下硬拒绝未核验接口，不静默降级。
3. **缺省即 dry-run**：没有 `PDD_APP_KEY/PDD_APP_SECRET/PDD_ACCESS_TOKEN/PDD_API_BASE_URL` 时不发网络请求；半配置（只有 key 没有 secret）直接 `config_error`。
4. dry-run 样例：`artifacts/pdd-listing-package-sample/`（CSV×5 + XLSX + manifest + 导入说明），`payload_hash=b3f95c7d…`，行数 1/8/4/3/3；XLSX 已用 openpyxl 打开验证（6 个 sheet、中文正常）。
5. 回放夹具格式对齐 `tests/contract/lib/fixtures.mjs`，包内夹具全部 `synthetic:true`；真实录制需等 docs/01 附录 A10–A12。

---

## 1. 任务与边界

### 1.1 本任务交付

- `src/http/`：签名、时间戳防重放、令牌桶限流、重试分类与退避、请求/响应留档、fetch/replay/recording 三种 transport、`PddClient`。
- `src/registry/`：docs/01 §2.1–§2.6 的 28 条能力逐条建桩；未核验项全部 TODO；生成「未自动化接口清单」。
- `src/listing-package/`：硬事实校验 + CSV + 最小 OOXML XLSX + manifest（`payload_hash`）+ 人工导入/回填说明。
- `src/cli/`：`sample:listing`（dry-run 生成样例）、`registry:report`（注册表与未自动化清单）。
- 测试：54 条（config/registry/signer/rate-limiter/transport/client/replay/listing-package）+ 3 个 synthetic 回放夹具。

### 1.2 明确不做（留给后续任务）

- 不写任何真实平台密钥；不调用真实平台（无凭据，且 28 条接口未核验）。
- 不编造 method/版本/限流/沙箱/字段名；不猜测平台导入模板列名。
- 不做浏览器自动化；不做写平台（写路径由 M4 写入门调用本包）。
- 不做 edge-proxy；不在本任务接 MinIO（留档暂落本地 `data/`）。

---

## 2. 交付物清单

| 文件 | 作用 | 规模 |
|---|---|---|
| `packages/adapters-pdd/src/config.ts` | 缺省 dry-run、凭据/域名/数值校验、安全摘要 | 235 行 |
| `.../src/errors.ts` | `PddError`、错误分类、`next_action` | 108 行 |
| `.../src/http/client.ts` | 调用门禁、签名、限流、重试、留档编排 | 524 行 |
| `.../src/http/signer.ts` | 占位 HMAC 签名、时间戳/nonce Guard | 181 行 |
| `.../src/http/classification.ts` | HTTP/包络/网络错误分类、`Retry-After` | 238 行 |
| `.../src/http/rate-limiter.ts` | 令牌桶（可注入 clock/sleep） | 129 行 |
| `.../src/http/retry.ts` | 指数退避 + 全抖动 | 64 行 |
| `.../src/http/archive.ts` | JSON 留档、脱敏、sha256 | 142 行 |
| `.../src/http/replay.ts` | fixture 校验/加载、严格回放、录制、落盘 | 346 行 |
| `.../src/http/transport.ts` | Transport 接口、FetchTransport、URL 安全校验 | 150 行 |
| `.../src/registry/pdd-interfaces.ts` | 28 条接口桩（逐条 TODO） | 610 行 |
| `.../src/registry/index.ts` | 查询/统计/未自动化清单/`requireCallable` | 161 行 |
| `.../src/listing-package/validation.ts` | 尺码/成分/价格/库存硬校验 | 372 行 |
| `.../src/listing-package/exporter.ts` | 包结构、manifest、payload_hash、导入说明 | 344 行 |
| `.../src/listing-package/xlsx.ts` + `zip.ts` + `csv.ts` | 零依赖 XLSX/CSV | 310 行 |
| `packages/adapters-pdd/test/*.test.ts` | 54 条单测 | 1,275 行 |
| `packages/adapters-pdd/test/fixtures/replay/pdd/` | 3 个 synthetic 回放夹具 | — |
| `packages/adapters-pdd/examples/sample-product.json` | 8 SKU / 4 尺码 / 3 成分合成样例 | — |
| `artifacts/pdd-listing-package-sample/` | dry-run 样例产物（可重复生成） | 8 文件 |
| `packages/adapters-pdd/README.md` | 使用/回填/边界说明 | 135 行 |

> 变更说明：`packages/adapters-pdd/package.json` 增加 `tsx` devDependency 与 `test/sample:listing/registry:report` 脚本；`pnpm-lock.yaml` 同步一个 importer 条目（tsx 已在仓库其他包中使用，无新增外部依赖版本）。

---

## 3. 接口注册表（28 条，全部未核验）

### 3.1 统计（`registry:report` 实测）

```
统计：total=28 verified=0 unverified=28 write=14 read=14
分节：2.1=6 2.2=3 2.3=3 2.4=6 2.5=5 2.6=5
```

| 结论（目标态） | 条数 | 兜底通道分布 | 条数 |
|---|---|---|---|
| automation | 14 | none | 9 |
| conditional_automation | 7 | listing_package | 7 |
| degraded | 2 | manual_workbench | 12 |
| manual | 3 | — | — |
| pending_review | 2 | — | — |

> 「结论」是 docs/01 回填后的目标态，不代表现在可用；当前 `verified=0`，所有真实调用被 `requireCallable()` 拒绝。

### 3.2 安全门与不编造约束

- 每条记录含 `doc_ref`（`docs/01 §2.x 第 N 行`）、5 类 TODO（method/permission/rate_limit/sandbox/fields）、`conclusion_raw`（原文）。
- `platform_method/platform_version/path_template` 全部 `null`；测试 `registry.test.ts` 对 28 条逐条断言，防止后续误填。
- `unverifiedReport()` 生成「未自动化接口清单」：reason、fallback、fallback 说明、owner、review_date（null）——ADR-0006 要求的一等交付物。
- 动作级别取自 docs/11 §6.2：`price.sku_update=C`、`stock.update=A`、`product.publish=B`；无动作码的能力（发货/换 SKU/资质）保留 `operation_level` 但 `action_code=null`，不臆造。

### 3.3 回填流程

1. docs/01 附录 A3/A10–A12 取得 method/版本/域名/权限/限流/沙箱/字段；
2. 修改 `src/registry/pdd-interfaces.ts`：`verification='verified'` + method/version/path + TODO 替换 + `last_verified_at/verified_by`；
3. 同步 docs/01 与 docs/03；
4. 加一条真实脱敏 fixture（`meta.synthetic:false`）再跑回放。

---

## 4. HTTP client 机制

### 4.1 调用顺序（任何一步失败都不发请求）

```
注册表查找 → 未核验则 dry-run/拒绝 → 配置非 dry-run → 令牌桶 → 时间戳+nonce → 签名
→ transport → 分类 → 留档 → 可重试则退避重试
```

### 4.2 dry-run 判定

| 条件 | 结果 |
|---|---|
| 无 `PDD_APP_KEY/PDD_APP_SECRET` | `dry_run / missing_credentials` |
| 只有 key 或只有 secret | `config_error`（fail fast） |
| 无 `PDD_ACCESS_TOKEN` | `dry_run / missing_access_token` |
| 无 `PDD_API_BASE_URL` | `dry_run / missing_base_url` |
| `PDD_DRY_RUN=1` | `dry_run / forced_by_env` |
| 全齐 | `live`，但未核验接口仍被拒绝 |

### 4.3 签名与防重放（占位，已标注待核验）

- 方案 `placeholder-hmac-sha256-v0`：`HMAC-SHA256(appSecret, METHOD\npath\ntimestamp\nnonce\nsha256(body))`。
- 时间戳窗口默认 5 分钟（`PDD_CLOCK_SKEW_WINDOW_MS`），nonce 窗口内唯一；入站回调可复用 `TimestampReplayGuard`。
- **不是平台契约**：docs/01 §3 #6 的签名算法/时间戳字段仍待填；核验后实现新的 `RequestSigner` 替换即可。
- 测试用独立 `createHmac` 复算签名，防止实现漂移。

### 4.4 限流与重试

- 每接口一个令牌桶；`PDD_INTERNAL_QPS` 默认 0.5，是**内部保守节流值**，不是平台限流事实。
- 分类：429/408/5xx/超时/网络错误 → `retryable`；4xx/业务拒绝 → `manual`；配置/未注册/未核验 → `permanent`。
- 退避：`min(maxDelay, baseDelay×2^(n-1))` × 全抖动；`Retry-After` 优先；受 `maxAttempts` 与 `maxElapsedMs` 限制。
- 业务拒绝（HTTP 200 + `success:false` / `error_code`）不重试。包络识别是保守启发式，核验后按官方错误码表替换。

### 4.5 请求/响应留档

- 一次尝试一个 JSON：`<repo>/data/pdd-http-archive/<YYYY-MM-DD>/<request_id>-a<attempt>.json`（`data/` 已在 .gitignore；不使用 jsonl）。
- 脱敏：app key/secret、access token、签名、timestamp/nonce、收件人 PII → `[REDACTED]`；保留请求/响应体 sha256、`truncated` 标记。
- 测试断言落盘文件不含 `test-app-secret/test-access-token/test-app-key`，且 `body_sha256` 为 64 hex。

---

## 5. 录制回放

- fixture 结构与 `tests/contract/lib/fixtures.mjs` 完全一致：
  `{ meta:{platform,endpoint,recorded_at,doc_version,recorder,synthetic,schema?}, request:{method,path,query?,headers?,body?}, response:{status,headers?,body?,delay_ms?}, expected_error? }`。
- 包内夹具（3 个）：`test.echo` 成功、`test.reject` 业务拒绝、`test.rate_limited` 429；全部 `synthetic:true`，只验证链路，不冒充真实录制。
- `ReplayTransport` 严格匹配 `endpoint + method + path + query + body`；不匹配抛 `replay_mismatch`，**绝不 fallback 到真实网络**。
- `RecordingTransport` 录制时脱敏并落盘，`synthetic` 必须显式传入（真实录制写 false）。
- 回放测试 6 条：fixture 校验、成功回放、严格匹配失败、错误映射、录制→回放闭环、非法结构拒绝。

---

## 6. 上架包（兜底路径）

### 6.1 产物与样例

`artifacts/pdd-listing-package-sample/`（`pnpm --filter @dssaas/adapters-pdd sample:listing` 生成）：

| 文件 | 字节 | sha256（前 12 位） |
|---|---|---|
| `product.csv` | 491 | `1ce050f9564d…` |
| `skus.csv` | 2169 | `a001da4dc143…` |
| `size-chart.csv` | 371 | `43e11f6bb4e6…` |
| `fabric.csv` | 103 | `a0c2762a144d…` |
| `platform-attributes.csv` | 137 | `adbe3e13ae1d…` |
| `listing.xlsx` | 7502 | `548795fd8530…` |
| `import-notes.md` | 1598 | `d5313851cdf7…` |
| `manifest.json` | 2872 | —（索引文件） |

manifest 关键字段：

```json
{
  "schema_version": "pdd-listing-package-v1",
  "template_profile": { "id": "pdd-backend-import-unverified-v0", "version": "v0", "verified": false },
  "dry_run": true,
  "data_origin": "synthetic_sample",
  "payload_hash": "b3f95c7d9679640e8735adf9a7e58996f3ecd00256263be091d46080f0d28674",
  "row_counts": { "product": 1, "sku": 8, "size_chart": 4, "fabric": 3, "attributes": 3 }
}
```

`payload_hash` 只覆盖 `schema_version + template_profile.id + 规范化商品数据`，不含 `generated_at`；同输入两次生成 hash 与全部文件字节一致（测试断言）。

### 6.2 XLSX 验证（openpyxl 3.1.5）

```
sheets: ['说明', '商品', 'SKU', '尺码表', '面料成分', '平台属性']
说明 rows= 17 cols= 1
商品 rows= 2 cols= 11
SKU rows= 9 cols= 18
尺码表 rows= 5 cols= 18
面料成分 rows= 4 cols= 4
平台属性 rows= 4 cols= 3
```

### 6.3 硬校验与警告

| 级别 | 规则 |
|---|---|
| error（阻断） | 尺码词表/别名（`2XL→XXL`、`3XL→XXXL`、`均码→ONE`）；`6XL/FREE/均码加大` 拒绝；成分合计 100；价格/库存整数；重复 SKU；SKU 缺尺码行；0.5cm 步进；`sale_price > price` |
| warning（不阻断） | 资质未知（docs/01 G1）、缺主图、尺码行无 SKU、平台属性未映射 |

### 6.4 模板未核验的显式处理

- `template_profile.verified=false` + `source_todo`（后台导入模板列名/必填列/行数上限/失败回执待核验）；
- `import-notes.md` 与 manifest 均写入「必须回填批次号、成功/失败条数、驳回原因、包 sha256」（ADR-0006）；
- 导入包是人工路径，本包不产生平台写操作。

---

## 7. 验收对照

| # | 验收要求 | 方法 | 证据 | 结果 |
|---|---|---|---|---|
| 1 | 实现 `packages/adapters-pdd` HTTP client（签名、时间戳防重放、限流与退避、重试分类、请求/响应留档） | 代码 + 单测 | `src/http/*`；`client.test.ts`/`signer.test.ts`/`rate-limiter.test.ts` | 通过 |
| 2 | 接口注册表按 docs/01 逐条建桩，未核实接口标 TODO 而非编造 | 代码 + 断言 | 28 条、`verified=0`、method 全 null；`registry.test.ts` | 通过 |
| 3 | 录制回放测试夹具 | 夹具 + 严格回放 + 录制闭环 | `test/fixtures/replay/pdd/`；`replay.test.ts` 6 条 | 通过 |
| 4 | 上架包（CSV/Excel）导出器作为兜底 | 导出器 + 样例 | `artifacts/pdd-listing-package-sample/`；openpyxl 验证 | 通过 |
| 5 | 不写任何真实平台密钥，缺省即 dry-run | 配置单测 + 样例输出 | `config.test.ts`；样例 `mode=dry_run, reason=missing_credentials` | 通过 |
| 6 | dry-run 模式下生成一份上架包样例 | 运行 CLI | 样例 8 文件 + manifest `dry_run:true` | 通过 |
| 7 | 回放测试通过 | 运行测试 | `tests 54 / pass 54 / fail 0` | 通过 |
| 8 | 输出写进 `docs/验收记录-M1-PDD.md` | 本文件 | — | 通过 |

---

## 8. 命令与真实输出

### 8.1 包类型检查

```
$ pnpm --filter @dssaas/adapters-pdd typecheck
$ tsc -p tsconfig.json
EXIT=0
```

### 8.2 单测（54/54）

```
$ pnpm --filter @dssaas/adapters-pdd test
✔ 缺省配置下调用未核验接口：返回 dry-run 预览，不构造网络请求
...
✔ 回放成功：PddClient 走 ReplayTransport 得到 200
✔ 录制 transport：脱敏落盘为 fixture，且能被 ReplayTransport 回放
✔ dry-run 上架包样例：CSV/XLSX/manifest/说明齐全，行数与哈希可核对
✔ FetchTransport 发送方法/头/体并解析 JSON 响应
...
ℹ tests 54
ℹ suites 0
ℹ pass 54
ℹ fail 0
ℹ duration_ms 342.5332
EXIT=0
```

### 8.3 dry-run 生成上架包样例

```
$ pnpm --filter @dssaas/adapters-pdd sample:listing
{
  "mode": "dry_run",
  "dry_run_reason": "missing_credentials",
  "out_dir": "D:\\DSSAAS\\artifacts\\pdd-listing-package-sample",
  "template_profile": "pdd-backend-import-unverified-v0",
  "template_profile_verified": false,
  "payload_hash": "b3f95c7d9679640e8735adf9a7e58996f3ecd00256263be091d46080f0d28674",
  "row_counts": { "product": 1, "sku": 8, "size_chart": 4, "fabric": 3, "attributes": 3 },
  "files": ["fabric.csv", "import-notes.md", "listing.xlsx", "platform-attributes.csv", "product.csv", "size-chart.csv", "skus.csv"],
  "warnings": []
}
EXIT=0
```

### 8.4 注册表报告

```
$ pnpm --filter @dssaas/adapters-pdd registry:report
拼多多接口注册表（M1）
来源：docs/01-平台接入侦察-拼多多.md v0.1（2026-10-20）
模式：dry_run（missing_credentials）
统计：total=28 verified=0 unverified=28 write=14 read=14
分节：2.1=6 2.2=3 2.3=3 2.4=6 2.5=5 2.6=5
```

### 8.5 静态门禁

```
$ pnpm lint
QA 静态门禁 · docs/21 §11.3 + docs/15 §10
扫描范围：contracts 300 文件 · business 135 文件 · sql 8 文件 · package.json 11 个
启用规则：BD-01 BD-02 BD-03 BD-04 BD-05 BD-06 CT-01 CT-02 CT-03 CT-05
✔ 通过：0 处违规
EXIT=0
```

### 8.6 workspace typecheck（环境观察）

```
$ pnpm typecheck
✔ @dssaas/api / worker / adapters-1688 / adapters-pdd / core ...
✖ @dssaas/db  typecheck 失败（exit=1）
Error: EPERM: operation not permitted, rename '...query_engine-windows.dll.node.tmpXXXX'
  -> '...query_engine-windows.dll.node'
```

**判定**：`@dssaas/db` 的失败发生在 Prisma 生成引擎文件重命名（另一进程/并发 `prisma generate` 占用 DLL），与本任务代码无关；`@dssaas/adapters-pdd` 自身 `typecheck` 与全部单测通过。该现象已在交付时记录，未做绕过或删除 node_modules 的操作。

---

## 9. 假设、偏差与风险

| # | 项 | 说明 | 处理 |
|---|---|---|---|
| A1 | 签名算法未知 | docs/01 §3 #6 待填；`placeholder-hmac-sha256-v0` 与 `x-pdd-*` 头是内部占位协议，不是平台契约 | 核验后替换 `RequestSigner`，头部与材料随之替换 |
| A2 | 调用域名未知 | 无默认 baseUrl；缺 `PDD_API_BASE_URL` 即 dry-run | 核验后写 env；生产/沙箱分环境配置 |
| A3 | 平台限流未知 | `PDD_INTERNAL_QPS=0.5` 是内部节流占位值，不是平台事实 | 核验后按「平台限流 50%」配置 |
| A4 | 业务错误包络未知 | 只识别 `success:false` / `error_code` / `error_response` 三种形态 | 核验后替换 `classifyHttpResponse` 的错误码表 |
| A5 | 回放夹具为 synthetic | 未取得沙箱，不能冒充真实录制；`meta.synthetic:true` + `doc_version` 明示 | 账号到位后按 A10–A12 录真实脱敏 fixture |
| A6 | 上架包模板未核验 | `pdd-backend-import-unverified-v0` 是内部规范列；不得当官方模板 | 后台核验后改 profile + 列名，升 version |
| A7 | 留档目录本地 | 默认 `data/pdd-http-archive`（已忽略入库）；生产应进 MinIO `dssaas-export` 并纳入保留/清理策略 | M4/M6 接 MinIO；本任务只保证接口与格式 |
| A8 | nonce 去重单进程 | `TimestampReplayGuard` 内存 Map；多实例/重启后失效 | M4 写入门换 Redis（docs/11 单飞/锁） |
| A9 | 上架包 `price_yuan` | 仅人工核对列；主数据口径始终 `price_cents`（整数分） | 平台模板若只收元，导入时将元列映射过去，包内保留分 |
| A10 | 8 张支撑表未建 | t1 遗留，不影响本包（本包不碰 DB） | 见 `docs/验收记录-M1-骨架.md` |

---

## 10. 遗留与下一步

1. **阻塞 M4**：docs/01 附录 A3/A10–A12 的账号与接口核验（P1/P2）。
2. 替换占位签名/调用域名/错误码表；把 28 条逐条回填并升 `verified`。
3. 真实脱敏录制 → `tests/contract/fixtures/pdd/`；接 t10 的契约回归。
4. 与 M4 写入门对接：`approval_id`、`target_hash`、写前快照、审计、kill switch。
5. 留档迁移 MinIO + 保留策略；nonce 去重迁移 Redis。
6. 上架包：后台模板核验后更新 profile；导入批次/回执回填落表（ADR-0006）。

---

## 附录 A：28 条接口桩（全部 unverified）

| § | key | 能力 | 写 | 级别 | 兜底 | 目标结论 |
|---|---|---|---|---|---|---|
| 2.1 | `product.publish` | 商品发布（新增） | 是 | B | listing_package | conditional_automation |
| 2.1 | `product.update` | 商品编辑（更新） | 是 | B | listing_package | conditional_automation |
| 2.1 | `product.listing_status` | 商品上下架 | 是 | B | listing_package | automation |
| 2.1 | `product.query` | 商品详情/列表查询 | 否 | — | none | automation |
| 2.1 | `category.attribute_query` | 类目与属性查询 | 否 | — | none | automation |
| 2.1 | `product.qualification_bind` | 商品资质绑定/上传 | 是 | — | manual_workbench | conditional_automation |
| 2.2 | `price.sku_update` | SKU 价格修改 | 是 | C | listing_package | conditional_automation |
| 2.2 | `price.promotion` | 促销价/活动价 | 是 | C | listing_package | degraded |
| 2.2 | `price.query` | 价格查询（只读） | 否 | — | none | automation |
| 2.3 | `stock.update` | 库存更新 | 是 | A | listing_package | automation |
| 2.3 | `stock.query` | 库存查询 | 否 | — | none | automation |
| 2.3 | `stock.alert_rule` | 库存预警/售罄 | 否 | — | none | pending_review |
| 2.4 | `order.list` | 订单列表 | 否 | — | none | automation |
| 2.4 | `order.detail` | 订单详情 | 否 | — | manual_workbench | automation |
| 2.4 | `order.ship` | 订单发货 | 是 | B | manual_workbench | conditional_automation |
| 2.4 | `order.change_sku` | 订单换 SKU | 是 | B | manual_workbench | manual |
| 2.4 | `aftersale.manage` | 售后/退款 | 是 | — | manual_workbench | degraded |
| 2.4 | `logistics.track` | 物流轨迹 | 否 | — | none | automation |
| 2.5 | `message.pull` | 会话/消息拉取 | 否 | — | manual_workbench | automation |
| 2.5 | `message.send` | 消息发送 | 是 | B | manual_workbench | conditional_automation |
| 2.5 | `message.callback_subscribe` | 消息推送/回调订阅 | 否 | — | manual_workbench | conditional_automation |
| 2.5 | `service_account.manage` | 客服账号/分流 | 否 | — | manual_workbench | manual |
| 2.5 | `auto_reply.manage` | 自动回复/机器人 | 否 | — | manual_workbench | pending_review |
| 2.6 | `media.image_upload` | 图片上传 | 是 | B | listing_package | automation |
| 2.6 | `media.video_multipart_upload` | 视频分片上传 | 是 | B | manual_workbench | automation |
| 2.6 | `media.video_transcode_status` | 视频转码/审核状态 | 否 | — | none | automation |
| 2.6 | `storage.quota_query` | 云存储容量查询 | 否 | — | none | automation |
| 2.6 | `media.delete` | 素材删除 | 是 | — | manual_workbench | manual |

> 「目标结论」= docs/01 回填后的目标态；当前全部 `verified=false`，实际可用数 0。
