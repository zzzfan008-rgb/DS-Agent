# 契约回放（L3 骨架）

本目录实现 docs/15 §4 的「录制回放」轨道：**PR 期零外网**，用本地 HTTP 回放录制，
断言请求可构造、响应可解析、错误码可映射、Schema 漂移可发现。

> 当前目录中的 fixture 标记 `synthetic: true`：docs/01、docs/02 均确认平台接口文档未取得
> （登录墙），因此**不伪造真实字段名**；示例只验证回放链路本身。
> t4/t5 拿到沙箱后，按同格式替换为真实录制，即可把 `synthetic` 去掉。

## 目录

```text
tests/contract/
├─ fixtures/<platform>/<endpoint>/<recorded_at>.json   # 录制（当前为 synthetic 示例）
├─ schemas/<platform>/<endpoint>.schema.json           # 响应 JSON Schema 子集
├─ error-map.json                                      # 平台错误 → internal → docs/12 code
├─ lib/schema.mjs                                      # 零依赖 JSON Schema 校验器
├─ lib/fixtures.mjs                                    # 加载/结构/脱敏/哈希
├─ lib/replay.mjs                                      # 本地回放服务器
├─ lib/error-map.mjs                                   # 错误映射解析
├─ lib/doc-codes.mjs                                   # 解析 docs/12 §4 错误码词表
└─ replay.test.mjs                                     # 回放 + 漂移 + 错误映射测试
```

## fixture 格式

```json
{
  "meta": {
    "platform": "pdd | 1688",
    "endpoint": "item.add",
    "recorded_at": "2026-10-20T02:00:00.000Z",
    "doc_version": "平台文档版本/公告号，或 synthetic 说明",
    "recorder": "qa",
    "synthetic": true,
    "schema": "schemas/pdd/item.add.schema.json"
  },
  "request": { "method": "POST", "path": "/openapi/router", "query": {}, "headers": {}, "body": {} },
  "response": { "status": 200, "headers": {}, "body": {} },
  "expected_error": { "internal": "quota", "external": "quota" }
}
```

脱敏硬规则（`validateFixture` 强制）：`app_key`、`sign`、`access_token`、`timestamp`、`nonce`、
手机号、收货地址、买家昵称、店铺名出现时必须为 `<redacted:...>` 占位符；`request.path` 不得含明文 `access_token`。
同一请求的多条录制（成功 / 429 / 业务驳回）按加载顺序依次回放。

## 断言

`node --test tests/contract/replay.test.mjs` 覆盖：

1. fixture 结构合法、敏感字段已脱敏；
2. 哈希稳定、可复算；
3. 全部 fixture 可在 `127.0.0.1` 回放服务器上回放（未匹配路由返回 501，不会触达真实平台）；
4. 成功响应通过 Schema；缺字段/类型变化会被 Schema 捕获（对应 FI-10/FI-11）；
5. 错误 fixture 经 `error-map.json` 映射后的 **external code 必须在 docs/12 §4 词表内**；
6. `error-map.json` 自身不得出现 docs/12 之外的对外 code。

## 与 docs/12 的关系

- 对外错误码以 docs/12 §4 为唯一词表；`doc-codes.mjs` 直接解析该 Markdown 表，文档删改会导致测试失败；
- 内部失败分类沿用 docs/15 §5.2（retryable / upstream_unknown / platform_reject / signature_invalid / contract_drift …）；
- docs/12 的 86 个端点的内部 API 契约测试，待 `docs/openapi.yaml` 生成后在 `tests/contract/api/` 下补（docs/12 明确 Contract-Tests 以 OpenAPI 为准）。

## 已知限制（后续补齐）

- 签名可复算：fixture 目前只带 `<redacted:sign>` 占位符；真实签名算法在 adapter 落地后，
  在 `lib/replay.mjs` 增加 `verifySignature(fixture, signer)` 钩子（t4/t5）。
- 未引入 undici MockAgent：为保持 CI 零额外依赖，使用本地 `node:http` 回放；语义等价
  （禁用真实网络、按请求匹配响应），后续若需要 undici 的拦截能力可平滑替换。
- 沙箱/生产影子轨道不在 PR 内运行（docs/15 §4.1），由 nightly 任务接入。
