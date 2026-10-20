# business-bridge · api ↔ 中心 DSH Host 桥接契约

| 项 | 内容 |
|---|---|
| 适用 | `apps/api` 的 agent 驱动（已实现）与 Host 内 `business-bridge` 插件之间 |
| 依据 | docs/17 §2.2/§3.3/§3.4/§3.2、docs/21 §13、docs/14 §4.3、docs/16 §7.3 |
| 状态 | api 侧 **已实现**；Host 侧 **真实 Host 联调通过（t18，DSH 0.2.1-rc.2）**。运行时实现：`business-agent.mjs` + `business-bridge.mjs`；`business-agent.ts`/`business-bridge.ts` 为早期参考稿。验收证据：`docs/验收记录-M2-DSH真实联调.md` |

## 1. 拓扑与信任边界

```text
浏览器 → apps/web → apps/api（策略执行点）
                     │ POST /internal/agent/run
                     │ Authorization: Bearer <bridge-token>
                     │ Accept: text/event-stream
                     ▼
              business-bridge（Host 内精确路由）
                     │ createPeer({ principal:{kind:'business-api'}, interactions:'none' })
                     │ typertGateway.stream({ namespace:'businessAgent', method:'run', args:{ env }, peer, signal })
                     ▼
                业务 Agent（模型 + 只读 MCP）
```

- **禁止** `/connect`：该入口的 API Peer principal 恒为 `owner`，owner 调用跳过 `remoteAccess`
  判定（docs/21 §13）。业务侧必须走本桥接 + 非 owner Peer。
- 每请求一个 Peer，结束/断开即 `peer.dispose()`；不跨请求复用。
- `interactions:'none'`：业务 Peer 不接收 forwarded events，防越权订阅。

## 2. Wire 契约

### 2.1 `GET /internal/health`

```http
Authorization: Bearer <token>
```

```json
{
  "status": "ok",
  "version": "0.2.1-rc.2",
  "preset": "clothing-ops",
  "manifest_hash": "<sha256 of dsh-bundle/manifest.json>",
  "mcp_tools": 2,
  "uptime_s": 1234
}
```

- Host 未就绪 → `503`；preset 目录不可读/MCP 未连接按 `failOnStartupError` 处理。
- api 用它做 POST 前置检查（Host 挂时直接 `503 dsh_unavailable`，不是 202）与 `/api/health` 聚合。

### 2.2 `POST /internal/agent/run`

请求头必须同时满足（任一不满足返回 **404**，不暴露存在性）：

- `Authorization: Bearer <bridge-token>`（32 字节随机，常量时间比较）
- `Content-Type: application/json`
- 方法 POST、路径精确匹配
- 来源 IP 在 `allowedSourceCidrs`（127.0.0.1 / 10/8 / 172.16/12）
- 可选 `X-Request-Id`、`X-Run-Id`（api 生成，便于幂等与排障）

请求体：`AgentRunEnvelope`（camelCase，docs/17 §3.1；等价 TS 定义见
`apps/api/src/agent/types.ts`）。要点：

- `runId` 由 api 生成（uuid v7），Host 侧作为本次运行的稳定幂等键；
- `role/intent` Host 再校验一次（纵深防御），不一致返回 `remote-access/denied` → api 403；
- `toolsAllow` 只能收窄预设工具集，越权项由 api 忽略并审计；Host 仍需二次校验；
- `facts` 是只读事实快照（M1 为 null，M3 起由 api 注入 snapshotId/hash/version）。

响应：`200 text/event-stream; charset=utf-8`，SSE 帧：

```text
event: queued
data: {"position":0}

event: meta
data: {"runId":"…","sessionId":"…","bundleVersion":"1.0.0","modelId":"deepseek-chat"}

event: step
data: {"seq":1,"name":"kb.search","status":"running"}

event: tool_call
data: {"tool":"kb.search","argsSummary":"q=<facts>"}

event: tool_result
data: {"tool":"kb.search","ok":true,"summary":"3 hits"}

event: delta
data: {"text":"秋季通勤"}

event: usage
data: {"inputTokens":812,"outputTokens":146,"costCents":2}

event: final
data: {"output":{"text":"…","artifacts":[]},"durationMs":4300}
```

- 终态二选一：`final` 或 `error`；**不得**都发，也不得缺失（api 会把「流在终态前结束」判为
  `dsh_unavailable`）。
- `error`：`{"code":"timeout|upstream_5xx|queue_full|conflict|…","message":"…","retryable":true,"nextAction":"retry_later"}`。
- 心跳可用注释行 `: hb <iso>`，忽略即可。
- 客户端断开（`req.on('close')`）→ `controller.abort()` → Gateway 把 `signal` 传给 Agent；
  Agent 在下一次步骤边界停止（≤2s，docs/17 §3.4）。

### 2.3 错误与状态码

| Host 返回 | api 映射 | 说明 |
|---|---|---|
| 401/403/404 | `503 dsh_unavailable`（`detail.reason=bridge_rejected`） | 令牌/来源/路径不匹配，不泄漏细节 |
| 409 | `409 conflict`（`detail.sub`） | 并发/会话冲突 |
| 429 | `429 queue_full` | Host 队列满，带 `Retry-After` |
| 422/400 | `422 validation_failed` | 信封字段非法（api 已先校验，出现即契约漂移） |
| 503 | `503 dsh_unavailable` | Host 重启/未就绪 |
| 其它 5xx | `502 upstream_5xx` | 可重试 |

api 侧连接期指数退避重试最多 2 次（`AGENT_BRIDGE_RECONNECT_ATTEMPTS`），**只在收到任何业务
事件之前**重试；首事件之后不重试，避免重复输出。公开 SSE 的断线续传由 api 的事件缓冲 +
`Last-Event-ID` 完成（`GET /api/agent/runs/:id/events`），不依赖 Host 回放。

## 3. 安全清单（真实 Host 联调结果，t18）

- [x] 令牌文件在工作区 `dsh-bundle/.dev-home/secrets/bridge-token`，每请求 mtime 热读；令牌轮换后旧令牌立即 401。
- [x] 来源（127.0.0.1）、方法、Content-Type、精确路径四项全查，任一失败 404。
- [x] 常量时间比较（`crypto.timingSafeEqual`）。
- [x] `createPeer({ principal:{kind:'business-api'}, interactions:'none' })`，每请求 dispose。
- [x] `remoteAccess.registerPolicy('business-api', …)` 仅放行 `businessAgent/run`，
      `explain` 校验 `intent` 白名单与 `role × intent`；拒绝返回 `remote-access/denied`。
      binding.role 必须是 `{name, resource:'global', actions:['businessAgent/run']}`（t18 实测）。
- [x] 不打印令牌/完整信封/模型原文；Host 日志只到 plugin 级。
- [ ] 生产镜像仍需把监听限制在 compose `127.0.0.1:43180` 与内部网络（M3 部署项）。

## 4. 已验证的真实 Host 接入（t18）

1. 一键启动：`pwsh -File scripts/dev/start-dsh-host.ps1`（独立 profile、junction、令牌、健康等待）。
2. 插件：`business-agent.mjs`（Remote service）+ `business-bridge.mjs`（路由/policy/peer/gateway）。
3. 真实事件：`apps/api/test/agent-real-host-{stream,cancel,auth}.log`，摘要见
   `docs/验收记录-M2-DSH真实联调.md`。
4. 已知问题：F1（真实首 token 10.0s）已在 t23 关闭，见 §4.1；成本为按 token 的估算（F2）；
   每 run 新建 Host session（F3）。

### 4.1 F1 skill 前置注入（t23 已实现）

`business-agent.mjs` 在 `sessionController.prompt` 前读取 `skill-injection.mjs`，把 intent 对应的
`SKILL.md` 正文直接拼入 prompt（不再让模型先调 `tool-skill`）。配置（`dev-host.patch.yml`）：

```yaml
business-agent:
  config:
    skillInjection:
      enabled: true                 # false = 回退工具加载
      enabledIntents: [support.suggest, content.draft, content.rewrite]
      intentSkills:                 # 可选，覆盖 manifest.intents[intent].skills
        support.suggest: [return-policy@1.3.0, brand-tone@2.1.0, size-guide@3.0.1]
      manifestFile: D:/DSSAAS/dsh-bundle/manifest.json
      skillRoot: D:/DSSAAS/dsh-bundle/skills
      maxSkillBytes: 20000
      maxTotalBytes: 30000
      debugFile: D:/DSSAAS/dsh-bundle/.dev-home/logs/f1-injection.jsonl
    reasoningEffort:
      support.suggest: off          # 客服回复关闭 deep reasoning（F1 实测必需）
```

- 注入失败/未命中 → 自动回退 `tool-skill`，`meta.skillInjection.mode=tool`，不阻断 run；
- `support.suggest` 同时注入 `size-guide`，否则客服问尺码时会再触发一次 skill 工具调用；
- 首 token 分档在 api 侧（reply_draft 5000 / copy 8000 / 其他 8000），本插件不判超时；
- 真实 Host 5 次采样与成本结论见 `docs/验收记录-M2-DSH真实联调.md` §8A。

## 5. 生产化（M3）剩余

1. api 的 sessionKey → Host session 映射（Redis）；多轮上下文复用。
2. 真实计价：`model_call_log` + `cost_ledger`（M2/t7），bridge 只上报 token。
3. 生产 `dsh-host` 镜像、卷权限、`/ready` 聚合、MCP 启用与 `ctx.tools.guard`（docs/14 §8.3）。
4. 生产鉴权失败改 404（`authFailureStatus: 404`，docs/14 §4.3）；dev 保持 401（t18 要求）。

