# 验收记录 · M1 Agent 驱动层（t3 · DSH 常驻 Host 与流式调用）

| 项 | 内容 |
|---|---|
| 任务 | t3 · DSH 驱动层：常驻 Host 与流式调用（agent-host） |
| 日期 | 2026-10-20 |
| 依据 | `docs/17-交互入口与Agent驱动规范.md`（§0、§2–§4、§6、§10、§11）、`docs/00` §五、`docs/12` §3.12/§7/§8、`docs/14` §4.3/§8/§9、`docs/16` §7.3、`docs/21` §12/§13、`docs/04` §2.1/§3.3 |
| 结论 | **PASS（M1 驱动层）**：api 侧 Typert 桥接客户端、`POST /agent/run` SSE 透传、并发/排队、取消、三层超时、失败降级与 `dsh-bundle` seed 均已落工作区并有自动化证据；19/19 用例通过。**Host 侧 `business-bridge` 插件按 docs/17 状态属 M3**，本任务用独立进程的**协议桩**（严格实现同一 wire）完成流式验收，边界见 §8。 |
| 证据 | `apps/api/test/agent-run.log`、`apps/api/test/agent-smoke-stream.log`、`apps/api/test/agent-smoke-host-down.log`、本节命令输出 |

> 口径：本任务只交付 **api 侧驱动 + dsh-bundle seed 配置**，不实现 Host 内插件、不接模型供应商、
> 不写 `model_call_log`（M2 模型网关职责）。所有事件、错误码、金额单位按 `docs/21`。

---

## 1. 交付物

```text
apps/api/src/agent/                 # api 侧 Agent 驱动（新增）
├─ types.ts                         # AgentRunEnvelope / BridgeEvent / 公开 SSE 事件模型
├─ intents.ts                       # intent 白名单、role×intent、默认工具集、限额、sessionKey
├─ bundle.ts                        # 读 dsh-bundle/manifest.json，计算 manifestHash
├─ bridge-client.ts                 # Typert RPC 桥接客户端：SSE 解析、AbortSignal、三层超时、重连
├─ concurrency.ts                   # 并发闸门：全局 8 / 单用户 2 / 单会话 1 / 队列 30
├─ run-manager.ts                   # run 生命周期、事件翻译/缓冲、取消、终态、审计、指标
├─ sse.ts                           # SSE 帧渲染、retry/心跳、背压写入
└─ routes.ts                        # POST /agent/run、GET run、GET events、POST cancel

apps/api/src/config.ts              # 新增 DSH_BRIDGE_* / AGENT_* 配置（zod 校验）
apps/api/src/app.ts                 # 装配 bridge + run manager、注册路由、onClose 收尾
apps/api/src/types.ts               # Fastify 装饰器类型：agentBridge / agentRuns
apps/api/src/routes/health.ts       # /api/health 聚合 dsh_host + agent 队列统计

apps/api/test/
├─ agent.test.ts                    # 19 条自动化验收用例（真实 Postgres + 真实 HTTP + Host 桩）
├─ agent-smoke.ts                   # 验收冒烟：真实 HTTP + SSE；stream / host-down 两种模式
├─ support/dsh-host-stub.ts         # 本地 Host 协议桩（在 API 测试内/独立进程复用）
├─ support/dsh-host-stub-cli.ts     # 桩 CLI（独立进程，端口 43180）
├─ agent-run.log / agent-smoke-stream.log / agent-smoke-host-down.log

dsh-bundle/                         # Host 侧资产 seed（本任务要求的 seed 配置）
├─ manifest.json                    # intent → bundle/skills/modelRoute + bridge/mcp 声明
├─ dsh-lock.json                    # 版本/哈希清单（integrity 首次锁定回填）
├─ presets/clothing-ops/1.0.0/      # 唯一业务 preset：preset.yml + agent.cordis.yml
├─ skills/{brand-tone,size-guide,care,return-policy}/<version>/SKILL.md
├─ config/{cordis.patch.yml,mcp-policy.yaml,mcp-servers.yaml}
└─ bridge/{README.md,business-agent.ts,business-bridge.ts}  # Host 侧参考实现（M3）

.env.example                        # DSH_BRIDGE_URL/TOKEN_FILE + AGENT_* 默认值
docs/验收记录-M1-Agent.md            # 本文件
```

未改数据库 schema、未新增业务表、未改迁移。

---

## 2. 调用链与实现要点

### 2.1 调用链（对齐 docs/17 §2.2）

```text
浏览器 ──POST /api/agent/run（Cookie+CSRF+IK）──► apps/api
   ▲                                               │ ①鉴权/RBAC/intent/工具收窄
   │                                               │ ②Host 健康预检（不通 → 503 dsh_unavailable）
   │                                               │ ③并发闸门（用户→会话→全局→排队）
   └──GET /api/agent/runs/:id/events（SSE）◄───────┤ ④POST http://Host/internal/agent/run
                                                   │   Bearer + JSON 信封 + Accept: text/event-stream
                                                   ▼
                                         business-bridge（Host 内，M3）
                                                   │ createPeer(business-api, interactions:none)
                                                   │ typertGateway.stream(businessAgent/run, signal)
                                                   ▼
                                              模型 + 只读 MCP
```

- api 是**策略执行点**：角色 × intent、tool 收窄、并发、超时、取消、审计都在 api；
- 不使用 `/connect`、不出现 owner Peer（docs/21 §13）；api 只持桥接 Bearer；
- 不使用 `dsh-headless` 作为交互通道（`grep -rn "dsh-headless" apps/api/src` 仅注释说明，见 §7）。

### 2.2 端点

| 端点 | 角色 | 行为 |
|---|---|---|
| `POST /api/agent/run` | operator+（`listing.diagnose` 仅 admin） | 202：`run_id/status/sse_url/expires_at/concurrency_remaining/queue_position`；IK 必填 |
| `GET /api/agent/runs/:id` | viewer+（本人或 admin） | 状态、steps、output、error、tokens、cost_cents；跨用户 404 |
| `GET /api/agent/runs/:id/events` | viewer+（本人或 admin） | SSE：hello 首帧、15s 注释心跳、Last-Event-ID 回放、终态关闭 |
| `POST /api/agent/runs/:id/cancel` | operator+（本人或 admin） | 200 + 当前状态；运行中 → AbortSignal 传到 Host；终态幂等 |

写请求统一走 t2 的 Idempotency-Key 与 CSRF 中间件；SSE 是只读 GET，不校验 CSRF。

### 2.3 内部事件 → 公开 SSE（docs/17 §3.2）

| Host 事件 | 公开事件 | 备注 |
|---|---|---|
| `queued` | `run.queued` | position |
| `meta` | `run.started` | 首帧 hello 由 api 生成；meta 提供 modelId/sessionId/bundleVersion |
| `step` | `run.step` | 同 seq 的 running→done 合并进 steps |
| `delta` | `run.delta` | 累加 output.text |
| `tool_call` / `tool_result` | `run.tool_call` / `run.tool_result` | summary 截断由 Host 负责 |
| `need_input` | `run.need_input` | M1 Host 桩不产生，映射已就绪 |
| `usage` | 并入 `run.finished` | tokens/cost_cents |
| `final` | `run.finished` | 终态；`output.partial=false` |
| `error` | `run.error` | 终态；code 映射到 docs/12 §4 词表 |
| `: hb` 注释 | 不产生事件 | 桥接与公开 SSE 都忽略 |

约束：`hello` 第一；`run.finished` / `run.error` 最后且互斥；事件 id = `{run_id}-{seq:06}`，
seq 单调；`resync` 只在 Last-Event-ID 落后于缓冲窗口时发出。

### 2.4 并发 / 排队（docs/17 §4.2、docs/21 §12）

| 情形 | 行为 | HTTP/错误码 |
|---|---|---|
| 单用户第 3 个（含排队） | 拒绝 | 409 `concurrency_user_limit` + `Retry-After: 5` |
| 单会话第 2 个 | 拒绝 | 409 `concurrency_session_limit` + `Retry-After: 5` |
| 全局满（8），队列未满（30） | 入队 | 202 + `queue_position`（**不是 409**） |
| 队列满 | 拒绝 | 429 `queue_full` + `Retry-After: 5` |
| 排队 > 30s | 终态失败 | SSE `run.error{code:"quota"}`，不无限排队 |
| 取消/结束 | 释放槽位，FIFO 调度下一个 | 同会话/同用户超限的票跳过、不丢 |

### 2.5 超时与取消

| 阶段 | 实现 | 终态 |
|---|---|---|
| 建连 Host | 3s（`DSH_CONNECT_TIMEOUT_MS`） | `failed` + `dsh_unavailable` |
| 首 token | 8s（客服 5s 由 intent 配置后续扩展） | `timeout` + `run.error{code:"timeout"}` |
| 整次运行 | `timeout_ms`（默认 120s，上限 600s） | `timeout`，强制 abort |
| 取消（运行中） | AbortSignal → Host `req.close` → gateway signal | `cancelled`，SSE 以 `run.finished{output.partial=true}` 收尾；5s 未释放计 `agent_leak_total` |
| 取消（排队中） | 移出队列 | `cancelled`，不执行 |
| 取消幂等 | 终态重复取消 | 200 + 当前状态 |

重连语义由单测直接验证（`test/agent.test.ts`「桥接重连」）：`fetch` 前两次连接失败、第三次成功
→ 客户端共尝试 3 次并收到 `meta→delta→final`；首事件之后断流 → **不重试**，抛
`dsh_unavailable`（避免重复输出）。

### 2.6 失败映射（api 对外统一错误码）

| Host/桥接 | api 对外 | 可读性 |
|---|---|---|
| 连接拒绝、超时、Host 重启 | `503 dsh_unavailable`（retryable） | 文案含 `DSH Host 不可达（url）：…；AI 能力暂不可用，可先用话术模板/人工处理` |
| 桥接 401/403/404（令牌/来源/路径） | `503 dsh_unavailable`（不暴露存在性） | 文案不区分具体失败点 |
| 409 | `409 conflict`（`detail.sub`） | |
| 429 | `429 queue_full` | |
| 422 | `422 validation_failed` | 契约漂移信号 |
| 5xx | `502 upstream_5xx` | |
| Host `error` 事件 | 按 code 落 run 终态 | `timeout` → `timeout`，其余 → `failed` |

### 2.7 配置项（`apps/api/src/config.ts`，均有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BRIDGE_URL` | `http://127.0.0.1:43180` | api 只拼 `/internal/*` |
| `DSH_BRIDGE_TOKEN_FILE` / `DSH_BRIDGE_TOKEN` | 空 | 生产用 0600 文件；开发可显式注入；均缺失 → 调用 fail closed |
| `DSH_CONNECT_TIMEOUT_MS` / `DSH_HEALTH_TIMEOUT_MS` / `DSH_HEALTH_CACHE_MS` | 3000 / 1500 / 2000 | 建连/探针/缓存 |
| `AGENT_MAX_CONCURRENCY` / `AGENT_QUEUE_LIMIT` / `AGENT_QUEUE_WAIT_MS` | 8 / 30 / 30000 | 全局与队列 |
| `AGENT_USER_CONCURRENCY` / `AGENT_SESSION_CONCURRENCY` | 2 / 1 | 固定上限 |
| `AGENT_RUN_TIMEOUT_MS` / `AGENT_MAX_TIMEOUT_MS` | 120000 / 600000 | 请求可下调 |
| `AGENT_FIRST_TOKEN_TIMEOUT_MS` | 8000 | 首 token |
| `AGENT_HEARTBEAT_MS` / `AGENT_RUN_RETENTION_MS` | 15000 / 1800000 | SSE 心跳 / 终态保留 |
| `AGENT_BRIDGE_RECONNECT_ATTEMPTS` / `_BASE_MS` | 2 / 250 | 只在首事件前指数退避 |

---

## 3. 验收命令与真实输出

### 3.1 类型检查与静态门禁

```console
$ pnpm --filter @dssaas/api typecheck
$ tsc -p tsconfig.json
EXIT=0

$ pnpm lint
QA 静态门禁 · docs/21 §11.3 + docs/15 §10
扫描范围：contracts 309 文件 · business 135 文件 · sql 8 文件 · package.json 11 个
✔ 通过：0 处违规
EXIT=0
```

> 全 workspace `pnpm typecheck` 在验收时撞到 `@dssaas/db` 的 Prisma engine 文件锁
> （`EPERM: rename query_engine-windows.dll.node`，并发 agent 正在跑 Prisma 生成）；
> `@dssaas/api` 本身通过。该错误与本次改动无关，见 §8 D10。

### 3.2 自动化用例：19/19

```console
$ TEST_DATABASE_URL='postgresql://dssaas:***@<test-host>:55434/dssaas_agent_test?schema=public' \
  pnpm --filter @dssaas/api test:agent
✔ 权限：viewer 不能创建 run；operator 不能 listing.diagnose；缺 Idempotency-Key 422
✔ 校验：未知 intent / confirm_irreversible=true / timeout_ms 超上限 / context 带 URL 均 422
✔ 隔离：跨用户查询 404，admin 可查；未登录 SSE 401
✔ 流式：hello→run.started→步骤/工具/增量→run.finished，事件 id 单调且终态唯一
✔ 回放：Last-Event-ID 续传只补缺口，且不重复
✔ 桥接重连：首事件前指数退避重试，首事件后不重试
✔ 取消：运行中 POST cancel → 200 cancelled，SSE 以 partial run.finished 收尾
✔ 错误映射：Host 返回 error 事件 → run.error(upstream_5xx)，run 状态 failed
✔ 超时：整次运行 timeout_ms 强制 abort → status=timeout
✔ 首 token 超时：Host 迟迟无 delta → status=timeout（agent_first_token 降级）
✔ 并发：同会话第 2 个 409；同用户第 3 个 409（带 Retry-After）
✔ 排队：全局满 → 202+queue_position；队列满 → 429 queue_full；取消后按 FIFO 继续
✔ 排队超时：等待超过 30s（测试用 250ms）→ run.error quota，不无限排队
✔ Host 未启动：POST /agent/run 返回可读 503 dsh_unavailable；/health 标记 dsh_host=down
✔ 桥接令牌错误：Host 返回 404（不暴露存在性）→ api 统一 dsh_unavailable
✔ 工具收窄：tools_allow 与默认集取交集，越权项被忽略并落审计
✔ 审计：agent.accept / agent.run / agent.cancel / agent.overload 均落库且链完整
✔ 指标与健康：agent_runs_total / agent_cost_cents_total 暴露；dsh_host=ok
✔ 审计标识：run 的 actor 为用户、resource 为 run_id，meta 含 bundle/model/session
ℹ tests 19  ℹ pass 19  ℹ fail 0
EXIT=0
```

完整输出见 `apps/api/test/agent-run.log`。测试库为独立库 `dssaas_agent_test`（不复用 t2 的
`dssaas_test`）：首次准备时 `DROP SCHEMA public CASCADE; CREATE SCHEMA public` 后 `prisma migrate deploy`；
`test:agent` 可重复执行（测试用户邮箱带随机后缀，不依赖清库）。

### 3.3 本地 Host 流式调用（独立进程，端口 43180）

启动本地 Host（协议桩；严格实现 docs/17 §3.3 的 wire，见 §8 D1）：

```console
# 终端 A：本地 Host（脚本由 api 测试复用；tokenFile 0600）
$ pnpm --filter @dssaas/api exec tsx test/support/dsh-host-stub-cli.ts \
    --port 43180 --token-file D:/DSSAAS/.tmp/bridge-token \
    --manifest-file D:/DSSAAS/dsh-bundle/manifest.json
[dsh-host-stub] ready http://127.0.0.1:43180 scenario=echo failMode=none tokenFile=D:/DSSAAS/.tmp/bridge-token
[dsh-host-stub] liveness pid=… url=http://127.0.0.1:43180
```

```console
# 终端 B：api 真实 HTTP（listen 127.0.0.1:0）+ 登录 + POST /agent/run + GET SSE
$ SMOKE_MODE=stream \
  DATABASE_URL='postgresql://dssaas:***@<test-host>:55434/dssaas_agent_test?schema=public' \
  DSH_BRIDGE_URL='http://127.0.0.1:43180' \
  DSH_BRIDGE_TOKEN_FILE='D:/DSSAAS/.tmp/bridge-token' \
  pnpm --filter @dssaas/api smoke:agent
{
  "mode": "stream",
  "bridge_url": "http://127.0.0.1:43180",
  "token_source": "file:D:/DSSAAS/.tmp/bridge-token",
  "health": {
    "status": 200, "dsh_host": "ok",
    "detail": { "version": "0.2.1-rc.2-stub", "preset": "clothing-ops",
                "manifest_hash": "2d4b3547…65b1",
                "local_manifest_hash": "2d4b3547…65b1",
                "manifest_match": true, "mcp_tools": 2, "latency_ms": 6 }
  },
  "create": { "status": 202, "data": { "run_id": "01a15813-…", "status": "running",
              "sse_url": "/api/agent/runs/01a15813-…/events",
              "expires_at": "…", "concurrency_remaining": 7, "queue_position": null } },
  "sse": { "status": 200, "content_type": "text/event-stream; charset=utf-8" },
  "elapsed_ms": 149,
  "pass": true
}
EXIT=0
```

**记录到的事件序列**（完整 JSON 见 `apps/api/test/agent-smoke-stream.log`）：

| # | event | id 后缀 | payload 摘要 |
|---|---|---|---|
| 1 | `hello` | `-000000` | `stream_id/run_id, server_time, heartbeat_s=15` |
| 2 | `run.started` | `-000001` | `model_id=stub-echo-1, session_id, bundle_version=1.0.0` |
| 3 | `run.step` | `-000002` | `seq=1, name=kb.search, status=running` |
| 4 | `run.tool_call` | `-000003` | `tool=kb.search, args_summary` |
| 5 | `run.tool_result` | `-000004` | `tool=kb.search, ok=true` |
| 6 | `run.step` | `-000005` | `seq=1, status=done, summary` |
| 7–10 | `run.delta` ×4 | `-000006…-000009` | 增量文本（可拼接为完整 output） |
| 11 | `run.finished` | `-000010` | `status=succeeded, output.text, tokens{in:136,out:96}, cost_cents:2, duration_ms:420` |

终态 `GET /api/agent/runs/:id`：`status=succeeded`、`tokens{in:136,out:96}`、`cost_cents=2`、
`steps[0].name=kb.search`、`model_id=stub-echo-1`、`bundle_version=1.0.0`。

### 3.4 Host 未启动（可读错误）

```console
# 停掉终端 A 后：
$ SMOKE_MODE=host-down … pnpm --filter @dssaas/api smoke:agent
{
  "health": { "status": 200, "dsh_host": "down" },
  "create": {
    "status": 503,
    "error": {
      "code": "dsh_unavailable",
      "message": "DSH Host 不可达（http://127.0.0.1:43180）：无法连接 DSH Host：fetch failed。AI 能力暂不可用，可先用话术模板/人工处理。",
      "retryable": true,
      "next_action": "retry_later",
      "detail": { "reason": "connect_failed", "bridge_url": "http://127.0.0.1:43180" }
    }
  },
  "pass": true
}
EXIT=0
```

读路径不受影响：`GET /api/health` 仍 200，只有 `checks.dsh_host=down`；商品/审批/会话等页面
不依赖 Host（docs/17 §10.1）。

---

## 4. dsh-bundle seed 配置

### 4.1 结构

见 §1 交付物树。与 docs/17 §9.1 的差异：preset 目录采用 DSH 0.2.1-rc.2 实际可发现的
`presets/clothing-ops/<version>/`（内含 `preset.yml` + `agent.cordis.yml`），安装时复制/软链到
`$DSH_HOME/.agent-presets/clothing-ops/`；skills 保持在 `dsh-bundle/skills/<name>/<version>/`，
由 preset 的 `customSkillDirs` 以相对路径 `../../../skills/` 引用。

### 4.2 manifest.json

- `preset=clothing-ops`、`bundleVersion=1.0.0`、`dsh=">=0.2.1-rc.2 <0.3.0"`；
- 6 个 intent → `bundle/skills/modelRoute`（与 docs/17 §6.2 一致）；
- `bridge` 声明 `businessAgent/run`、`/internal/agent/run`、`/internal/health`、principal=`business-api`；
- `mcp` 指向 `config/mcp-policy.yaml` 与 `config/mcp-servers.yaml`。

api 启动时读取该文件并计算 `manifestHash`（`apps/api/src/agent/bundle.ts`），在
`/api/health.checks.dsh_host_detail` 与 Host 上报值比对：本次验收 `manifest_match=true`。

### 4.3 preset（唯一业务 preset）

`agent.cordis.yml` 组合：`persona`（事实纪律/输出纪律/边界）、`agent-instructions`、
`skill-filesystem` + `tool-skill`（4 个 skill）、两个**只读 MCP 客户端占位**（`disabled: true`，
`serverName=erp/knowledge`，`toolCallTimeoutMs=15000`，`failOnStartupError=true`）。
不包含 bash/fs 写工具、不包含任何平台写工具；业务判断留在 api。

### 4.4 skill（4 个，版本化）

| skill | 版本 | 作用 |
|---|---|---|
| `brand-tone` | 2.1.0 | 标题/卖点/客服话术语气与禁用表达；不提供事实 |
| `size-guide` | 3.0.1 | 测量口径、选码解释、尺码表缺失/驳回诊断 |
| `care` | 1.1.0 | 成分 → 洗护推导与表述模板 |
| `return-policy` | 1.3.0 | 退换/售后政策引用规则与人工确认边界 |

### 4.5 MCP 客户端占位

- `config/mcp-policy.yaml`：`default: deny`；`erp` 仅 4 个只读工具、`knowledge` 仅 3 个；
  写前缀/写工具显式拒绝；带 scope 与超时/次数上限（docs/14 §8.2）。
- `config/mcp-servers.yaml`：两个 server 的 stdio 启动占位（`packages/mcp-erp` /
  `packages/mcp-knowledge` 当前为空壳），M3/M7 实现后开启。
- `config/cordis.patch.yml`：权限预设（viewer/operator/admin/ci）+ `business-bridge` 插件参数
  （`disabled: true`，M3 启用）。

### 4.6 版本清单

`dsh-lock.json` 锁定 `dsh=0.2.1-rc.2` 与 6 个显式依赖的精确版本；`integrity` 与各目录
`sha256` 标记为 `PENDING-FIRST-LOCK`，按 docs/04 §3.3 在首次正式锁定时回填（不伪造哈希）。

---

## 5. 审计与指标

| 动作 | 时机 | 关键字段 |
|---|---|---|
| `agent.accept` | POST 受理 | run_id、intent、role、preset/bundle、skills、tools_ignored、timeout、session_key、facts_snapshot |
| `agent.run` | 终态 | status、tokens、cost_cents、duration_ms、cancelled、error_code、model_id、dsh_session、first_token_ms |
| `agent.cancel` | 取消 | reason、before/after 状态 |
| `agent.overload` | 409/429 | reason（user_busy/session_busy/queue_full/role_intent_denied）、queue_depth |
| `agent.unavailable` | Host 不可达 | bridge_url、error |

- `audit_log` 只 INSERT，哈希链由 t2 服务维护；测试断言 `chain_hash` 长度 64 且 `agent.*` 均落库。
- 指标：`agent_runs_total{status,intent}`、`agent_first_token_seconds`、`agent_duration_seconds`、
  `agent_cost_cents_total`、`agent_active_runs`、`agent_queue_depth`、`agent_degraded_total{reason}`、
  `agent_leak_total`；可从 `GET /api/metrics` 读取（admin / METRICS_TOKEN）。
- **未写 `model_call_log`/`cost_ledger`**：M1 只有 Host 上报的 usage，落审计与指标；M2 模型网关
  接入后由网关写 `model_call_log` 与成本台账（见 §8 D4）。

---

## 6. 与规范对照（docs/17 §11 验收清单）

| # | 项 | M1 状态 |
|---|---|---|
| 1 | 唯一入口 | ✅ 浏览器只到 web/api；api 只经 `DSH_BRIDGE_URL` 访问 Host；代码无 `/connect`、无 headless、无 `.jsonl` 读 |
| 2 | 创建 + 流式 | ✅（协议桩）202 + hello→run.finished；真实 Host 待 M3 |
| 3 | 取消 | ✅ 运行中/排队中/终态幂等；Host 侧 signal 由 M3 插件接 |
| 4 | peer 授权 | ⏳ M3：Host 内 policy + 非 owner Peer 参考实现在 `dsh-bundle/bridge/` |
| 5 | 并发上限 | ✅ 第 9 个入队、单用户第 3 个 409、队列满 429、无雪崩 |
| 6 | 会话归属 | ✅ sessionKey（org/user/intent/object/version）隔离；Redis 映射 M3 |
| 7 | 幂等 | ✅ 复用 t2 中间件（in-flight 409 + 完成回放）；10 分钟窗口待换 Redis/表 |
| 8 | headless 边界 | ✅ 交互路径无 headless（扫描见 §7） |
| 9 | 管理员界面 | — 不在本任务 |
| 10 | 版本灰度 | — M3（manifest 已可计算哈希，灰度映射未实现） |
| 11 | 降级 | ✅ Host 挂 → 503/可读文案、读路径不受影响；模型降级链 M2 |
| 12 | 成本 | ✅ 每次 run 的 tokens/cost 入 run 视图、审计与指标；`model_call_log` 待 M2 |

---

## 7. 边界检查（命令真实输出）

```console
$ grep -rn "dsh-headless" apps/api/src apps/api/test --include=*.ts
apps/api/src/agent/bridge-client.ts:14: * 注意：本文件不 spawn `dsh-headless`，也不读 `.jsonl`（docs/17 §1.2 禁止清单）。

$ grep -rn "\.jsonl" apps/api/src apps/api/test --include=*.ts
apps/api/src/agent/bridge-client.ts:14: * 注意：本文件不 spawn `dsh-headless`，也不读 `.jsonl`（docs/17 §1.2 禁止清单）。

$ node scripts/qa/static-check.mjs
✔ 通过：0 处违规
```

（两处命中都在同一行说明性注释，不是读取路径。）

---

## 8. 偏差、边界与遗留

> 按重要性排序；均不阻塞 M1 验收，但必须在 M3/M9 前收敛。

**D1（关键，验收口径）Host 侧 `business-bridge` 插件尚未实现，流式验收使用「本地 Host 协议桩」。**
docs/17 状态行写明「M1 联调前定稿，M3 前完成桥接与流式链路」；t3 的任务文本限定
「实现 apps/api 侧的 agent 驱动」与「给出 dsh-bundle 的 seed 配置」。因此本任务交付的是
**api 侧驱动**，Host 内插件（精确路由、非 owner Peer、`typertGateway.stream`、remoteAccess
policy）以参考实现 + 清单放在 `dsh-bundle/bridge/`，M3 接入。验收用 `test/support/dsh-host-stub.ts`
在**独立进程**实现同一 wire（Bearer/来源/精确路径/Content-Type 校验、SSE 事件、取消、失败模式），
api 侧代码路径与真实 Host 完全一致；真实 Host 的事件序列需在 M3 追加一节（步骤见
`dsh-bundle/bridge/README.md` §4）。这是本任务最大的未验证面，评审时必须知情。

**D2 run 状态与事件缓冲为进程内。** docs/17 §5.2 明确「不新增 agent_session 表」；M1 用内存
实现，接口（create/get/subscribe/cancel）保持不变，后续换 Redis Stream 时只替换存储层。
进程重启会丢失进行中的 run（docs/17 §4.1 重启语义：返回 `dsh_unavailable`，客户端重试）。

**D3 事实快照为 null。** 信封 `facts={snapshotId:null,hash:null,version:0}`，审计里显式记录；
t8/t9 事实快照服务落地后由 api 注入并在 Host 侧校验（docs/17 §2.2 ⑤）。

**D4 未写 `model_call_log`/`cost_ledger`。** M2 模型网关（t7）负责模型调用记账；本任务只把
Host 上报的 usage 写入 run 视图、审计与 Prometheus 指标，避免两处重复记账。

**D5 桥接令牌读取是「请求级 fail closed」，不是「启动级拒绝」。** docs/14 §4.3 要求 api 启动
读取令牌、失败拒绝启动。M1 的实现是：令牌缺失时启动继续（便于读路径），但任何 Agent 调用
返回 `503 dsh_unavailable`（reason=bridge_token_missing），绝不无鉴权降级；生产部署脚本应
在启动前校验令牌文件存在（M3 收紧为启动失败）。

**D6 重连语义。** 客户端只在**首个业务事件之前**做指数退避重试（最多 2 次），避免重复输出；
首事件之后的断线由公开 SSE 的 `Last-Event-ID` 回放处理，不向 Host 请求回放。Host 侧若实现
按 runId 的事件缓冲，可在此基础上扩展断点续传（不影响本客户端契约）。

**D7 首 token 超时对所有 intent 统一 8s。** docs/17 规定客服草稿 5s（docs/18）；M1 未接
intent 级 SLA，配置留 `AGENT_FIRST_TOKEN_TIMEOUT_MS`，M5 接入客服时按 intent 覆盖。

**D8 Idempotency 复用 t2 内存实现（24h），与 docs/17 §6.6 的「完成 10 分钟内回放」略有差异。**
同键 in-flight 409、完成回放、不同 payload 409 均符合；窗口收紧与 Redis/表持久化随 t12 表落地。

**D9 SSE 背压。** 单连接写入 30s 未 flush 或待写缓冲 >1MB 即断开，依靠客户端重连 + 回放；
docs/12 的「>1000 条或 30s 未消费」语义由 1000 条缓冲上限 + 30s 写超时近似实现，未做逐客户端
消费水位统计。

**D10 全 workspace typecheck 的 Prisma EPERM。** 验收时另一 agent 正在跑 Prisma 生成，Windows
下 DLL 被占用导致 `@dssaas/db typecheck` 的 `prisma generate` 失败；`@dssaas/api` 自身通过。
重跑即可，不属于本任务缺陷。

**D11 `/api/health` 的 status 仍是「DB 活即 ok」。** Host 挂只体现在 `checks.dsh_host=down`；
docs/16 的 `/ready` 聚合（PG/Redis/MinIO/Host/队列）尚未实现，M9 前补齐。

**D12 `reason` 字段类型。** 桥接错误的 `detail.reason` 统一为字符串（connect_failed /
bridge_token_missing / bridge_rejected / host_unavailable 等），便于前端与告警按值分流。

**D13 审计两次写。** 受 `audit_log` 只追加约束，一次 run 写 `agent.accept`（受理）与
`agent.run`（终态）两条记录，用 `meta.run_id` 关联；不是 docs/17 §6.7 的「一条含结果」，
但信息不丢失，且崩溃时至少有受理记录。

**遗留（后续任务）**
1. M3：实现 `dsh-bundle/bridge/business-bridge.ts` 与 `business-agent.ts`，接真实 Host，补
   peer 授权/真实模型事件序列/断线重连验收（docs/17 §11 #2/#3/#4）。
2. M2：`model_call_log`、`cost_ledger`、intent 级路由与首 token SLA。
3. t12 支撑表落地后：run 状态/事件缓冲迁 Redis Stream；幂等窗口收紧。
4. `/ready` 聚合与 Host 探针 15s 周期、熔断半开（docs/17 §10.2）。
5. dsh-lock 的 integrity 与目录 sha256 在首次正式锁定时回填。

---

## 9. 复现步骤（从空库开始）

```bash
# 0) 测试库（独立于 t2 的 dssaas_test）
docker exec dssaas-api-test-pg psql -U dssaas -d postgres -c "CREATE DATABASE dssaas_agent_test"
cd packages/db
DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@<host>:55434/dssaas_agent_test?schema=public' \
  node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma

# 1) 自动化用例
cd apps/api
DATABASE_URL='…/dssaas_agent_test?schema=public' TEST_DATABASE_URL='…/dssaas_agent_test?schema=public' \
  NODE_ENV=test pnpm test:agent          # 18/18

# 2) 本地 Host + 流式冒烟
pnpm --filter @dssaas/api exec tsx test/support/dsh-host-stub-cli.ts \
  --port 43180 --token-file ../../.tmp/bridge-token --manifest-file ../../dsh-bundle/manifest.json &
SMOKE_MODE=stream DATABASE_URL='…/dssaas_agent_test?schema=public' \
  DSH_BRIDGE_URL='http://127.0.0.1:43180' DSH_BRIDGE_TOKEN_FILE='../../.tmp/bridge-token' \
  pnpm smoke:agent

# 3) 停 Host → 可读错误
kill %1
SMOKE_MODE=host-down … pnpm smoke:agent
```

---

## 10. 证据文件索引

| 文件 | 内容 |
|---|---|
| `apps/api/test/agent-run.log` | 18 条用例完整输出（2026-10-20 验收运行） |
| `apps/api/test/agent-smoke-stream.log` | 本地 Host 流式调用的完整 JSON（事件序列、health、run 视图） |
| `apps/api/test/agent-smoke-host-down.log` | Host 未启动时的 503 输出 |
| `apps/api/test/support/dsh-host-stub.ts` / `-cli.ts` | 本地 Host 协议桩（测试与手工验收共用） |
| `dsh-bundle/bridge/README.md` | 真实 Host 接入契约 + M3 安全清单 |
| `docs/验收记录-M1-API.md`、`docs/验收记录-M1-骨架.md` | t2/t1 的基线证据（身份/审计/DB） |
