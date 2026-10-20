# @dssaas/adapters-pdd · 拼多多适配（M1 骨架）

> 结论先行：**当前 0 个接口已核验，全部 28 条能力只建桩**。没有 `PDD_APP_KEY/PDD_APP_SECRET/PDD_ACCESS_TOKEN/PDD_API_BASE_URL` 时，
> 客户端固定进入 **dry-run**：不发网络请求、不生成签名、不写平台；写路径兜底为**上架包（CSV/Excel）+ 人工后台导入**。

## 1. 本包负责什么

| 能力 | 位置 | 状态 |
|---|---|---|
| 接口注册表（docs/01 §2.1–§2.6，28 条） | `src/registry/` | 全部 `unverified`，method/version/path 为 `null` |
| HTTP client（签名占位、时间戳/nonce 防重放、限流、退避重试、留档） | `src/http/` | 机制可用；真实签名待核验后替换 `RequestSigner` |
| 录制回放（fixture 加载/严格匹配/录制） | `src/http/replay.ts` | 测试夹具全部 `synthetic:true`，格式对齐 `tests/contract/lib/fixtures.mjs` |
| 上架包兜底（CSV + XLSX + manifest + 导入说明） | `src/listing-package/` | 可用；模板 profile 未核验，显式 `verified:false` |
| CLI | `src/cli/` | `sample:listing` / `registry:report` |

**不做**：浏览器自动化、真实平台密钥硬编码、未经核验的 method 名、直接写平台（写路径必须由 `apps/api` 写入门调用，M4）。

## 2. 快速开始

```bash
# 类型检查
pnpm --filter @dssaas/adapters-pdd typecheck

# 54 条单测（含回放、签名、限流、重试、留档、上架包校验）
pnpm --filter @dssaas/adapters-pdd test

# dry-run 生成上架包样例 → artifacts/pdd-listing-package-sample/
pnpm --filter @dssaas/adapters-pdd sample:listing

# 注册表与「未自动化接口清单」
pnpm --filter @dssaas/adapters-pdd registry:report
```

CLI 会依次尝试 `<repo>/.env` 与当前目录 `.env`；缺省即 dry-run。

## 3. dry-run 判定（安全默认）

| 条件 | 结果 |
|---|---|
| 未配置 `PDD_APP_KEY/PDD_APP_SECRET` | `dry_run`，`missing_credentials` |
| 只配置 key 或只配置 secret | **直接报 `config_error`**（半配置 fail fast） |
| 缺 `PDD_ACCESS_TOKEN` | `dry_run`，`missing_access_token` |
| 缺 `PDD_API_BASE_URL` | `dry_run`，`missing_base_url`（调用域名未核验） |
| `PDD_DRY_RUN=1/true` | 强制 `dry_run`，`forced_by_env` |
| 凭据 + token + https baseUrl 全齐 | `live`；但接口仍未核验，调用会被拒绝 |

live 模式下调用未核验接口会抛 `unverified_interface`（`next_action` 与 fallback 见错误详情），**不会静默降级**。

## 4. 签名与防重放（占位，不是平台契约）

- 方案标识：`placeholder-hmac-sha256-v0`，头部 `x-pdd-*`；
- 材料：`METHOD + path + timestamp(ms) + nonce + sha256(body)`，HMAC-SHA256(appSecret)；
- 防重放：时间窗（默认 5 分钟，`PDD_CLOCK_SKEW_WINDOW_MS`）+ nonce 窗口内唯一；
  入站回调可复用 `TimestampReplayGuard`；
- **待填**：docs/01 §3 #6 的官方签名算法/时间戳字段/容忍窗口。核验后实现新的 `RequestSigner`
  并替换 `PlaceholderHmacSha256Signer`，`PddClient` 与留档逻辑无需改动。

## 5. 限流与重试

- 本地令牌桶（每接口一个桶），默认 `PDD_INTERNAL_QPS=0.5`。这是**内部保守节流值，不是平台限流事实**；
  核验到平台限流后按「内部配额 = 平台限流 50%」（docs/01 §4.2）调整。
- 分类：`retryable`（429/408/5xx/超时/网络错误）、`manual`（4xx/业务拒绝/认证失败）、`permanent`（配置/未注册/未核验）。
- 退避：指数 + 全抖动；平台 `Retry-After` 优先；超过 `maxAttempts`/`maxElapsedMs` 停止。
- 重试只发生在传输/限流/5xx；业务拒绝不重试。

## 6. 请求/响应留档

- 默认目录 `<repo>/data/pdd-http-archive/<YYYY-MM-DD>/<request_id>-a<attempt>.json`（`data/` 已在 .gitignore）；
- 一次尝试一个 JSON 文件（不使用 jsonl）；
- 留档前脱敏：app key/secret、access token、签名、timestamp/nonce、收件人 PII → `[REDACTED]`；
- 保留请求/响应体 sha256 与截断标记，便于对账；生产环境应改存 MinIO `dssaas-export`（docs/10）并纳入保留策略。

## 7. 接口注册表：如何回填

1. 按 docs/01 附录 A 的 A3/A10/A11/A12 取得 method/版本/域名/权限/限流/沙箱/字段；
2. 修改 `src/registry/pdd-interfaces.ts` 对应条目：
   - `verification: 'verified'`；
   - `platform_method`、`platform_version`、`path_template`；
   - `todos` 逐项替换为核验结果（或删除 TODO，但必须保留核验日期）；
   - `last_verified_at`、`verified_by`；
3. 同步更新 docs/01 与 docs/03 的逐接口表；
4. 加一条真实录制 fixture（`meta.synthetic:false`，脱敏），再跑契约回放。

`requireCallable()` 是硬门：method/version/path 任一为空或 `verification!=='verified'`，永不发真实调用。

## 8. 录制回放

- fixture 结构：`meta/request/response`，与 `tests/contract/lib/fixtures.mjs` 一致；
- 本包测试夹具在 `test/fixtures/replay/pdd/`，全部 `synthetic:true`（未取得沙箱，不冒充真实录制）；
- `ReplayTransport` 严格匹配 `endpoint + method + path + query + body`，不匹配抛 `replay_mismatch`，绝不 fallback 到真实网络；
- `RecordingTransport` 录制时脱敏并落盘（`synthetic` 必须显式传入）。

## 9. 上架包（兜底路径）

产物（`manifest.json` 为索引）：

```
product.csv
skus.csv                 每 SKU 一行；price_cents（分）+ price_yuan（两位小数）
size-chart.csv           一尺码一行；测量值展开为列
fabric.csv               成分合计必须 100
platform-attributes.csv  平台属性映射
listing.xlsx             以上 sheet + 说明（openpyxl 已验证可打开）
import-notes.md          人工导入与回填清单
manifest.json            template_profile / payload_hash / 行数 / 文件 sha256 / 警告
```

硬校验（阻断导出）：尺码词表（别名归一：`2XL→XXL`、`3XL→XXXL`、`均码→ONE`）、
`6XL/FREE/均码加大` 拒绝、成分合计 100、价格/库存整数、重复 SKU、缺尺码行、0.5cm 步进。
警告（不阻断）：资质未知（`qualification_unknown`）、缺主图、尺码行无 SKU、属性未映射。

**模板未核验**：`template_profile.id = pdd-backend-import-unverified-v0`，`verified:false`。
导入后必须按 ADR-0006 回填批次号、成功/失败条数、驳回原因与包哈希；不得手工改包。

## 10. 目录

```
src/
  config.ts            缺省 dry-run、凭据/域名校验、安全摘要
  errors.ts            错误分类与 next_action
  registry/            28 条接口桩 + 未自动化清单
  http/                client / signer / replay-guard / limiter / retry / archive / transport / replay
  listing-package/     validate / csv / xlsx / zip / exporter
  cli/                 sample:listing / registry:report
examples/sample-product.json   合成样例数据（data_origin=synthetic_sample）
test/                54 条单测 + synthetic 回放夹具
```

## 11. 待办（阻塞 M4 的前提）

1. docs/01 附录 A 的账号与接口核验（P1/P2、A3、A10–A12）；
2. 官方签名算法与调用域名 → 替换 signer/baseUrl；
3. 平台限流/沙箱 → 替换内部节流值并打开写接口；
4. 真实脱敏录制 → `tests/contract/fixtures/pdd/`；
5. 与 `apps/api` 写入门对接（approval_id、快照、审计、kill switch）——M4。
