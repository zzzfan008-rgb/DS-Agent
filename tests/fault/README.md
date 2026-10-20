# 故障注入矩阵（骨架）

实现 docs/15 §5.2 的 14 行故障矩阵。每行必须同时断言四件事：
**错误码（internal + external）、队列/重试状态、审计记录、用户可见提示**。

查看矩阵：`tests/fault/matrix.json`。当前 **10/14 行已实现**，4 行为 TODO 并写明原因。

## 运行

```bash
node --test tests/fault/fault-injection.test.mjs
```

## 已实现行

| ID | 注入 | 内部 → 对外 | 断言重点 |
|---|---|---|---|
| FI-01 | 连接超时 | `retryable` → `upstream_5xx` | 重试 1 次后进死信 |
| FI-02 | 读超时（已发出） | `upstream_unknown` → `conflict(sub=unknown)` | 不自动重试，标记结果未知 |
| FI-03 | 5xx | `retryable` → `upstream_5xx` | 指数退避 3 次；持续失败进死信 |
| FI-04 | 429 限流 | `quota` → `quota` | 遵守 `Retry-After` 暂停平台队列；其它平台不受影响 |
| FI-06 | 部分成功 | `partial_success` → 200 + failed[] | 只重试失败项 |
| FI-07 | 重复回调 | `idempotent_hit` | 同 `event_id` 3 次投递只产生 1 次副作用 |
| FI-10 | 删除必填字段 | `contract_drift` → `upstream_5xx(detail.sub=contract_drift)` | 不重试、告警 |
| FI-11 | 类型变化 | 同上 | 不产生错误金额/类型猜测 |
| FI-12 | HTML 错误页 | `upstream_invalid` → `upstream_5xx` | 不重试、告警 |
| FI-13 | 签名失败 | `signature_invalid` → `unauthorized` | 不重试、审计 |

TODO（等依赖）：FI-05 401 token 刷新（t4/t5）、FI-08 回调乱序（t9 状态机）、
FI-09 新增字段（t4/t5 解析器；Schema `additionalProperties=true` 已允许）、
FI-14 大响应（t4/t5 响应体上限）。

## 文件

- `matrix.json`：14 行矩阵，`status=implemented|todo`；TODO 必须有 `reason`；
- `mock-platform.mjs`：按 mode 模拟 5xx / 429 / 读超时 / 部分成功 / 重复回调 / 契约漂移 / HTML 错误页 / 签名失败；
- `support/retry-client.mjs`：参考客户端 —— `httpCall`（区分连接/读超时）、`classifyResult`（按 docs/15 §5.2 + docs/12 §4）、
  `executeWithRetry`（可注入 clock、最大重试、死信、审计账本）、`PlatformQueue`（暂停/死信）、`renderUserHint`。

## 与 adapter 的关系

`support/retry-client.mjs` 是**测试基准**，不是生产实现。t4/t5 实现 adapter 时必须复用同一分类口径：

- 内部失败分类（retryable / upstream_unknown / platform_reject / signature_invalid / contract_drift …）；
- 对外 code 必须落在 docs/12 §4 词表（例如 `signature_invalid` 对外映射 `unauthorized`）；
- 重试策略与 `Retry-After`、死信、审计、用户提示的语义保持一致。

新增/修改矩阵行时，必须同步更新 `matrix.json` 与 `fault-injection.test.mjs` 的四维断言。
