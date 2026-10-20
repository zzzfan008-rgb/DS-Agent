# 17 · 交互入口与 Agent 驱动规范

| 项 | 内容 |
|---|---|
| 编号 | 17 |
| 用途 | 定义唯一入口原则、网页→api→中心 DSH Host 调用链、Typert 流式 RPC、AbortSignal 取消、peer principal 授权、Host 进程模型与并发、会话归属、`POST /agent/run` 语义、headless 边界、管理员界面、preset/skill 版本与灰度、失败降级 |
| 读者 | 前端、后端、Agent 集成开发者、运维、管理员；评审人 |
| 依赖 | `docs/00-方案总纲.md`（第三、五、十九、二十章）、`docs/04-DSH适配与版本锁.md`、`docs/06-领域模型与数据字典.md`、`docs/11-工作流与写入门规范.md`、`docs/12-接口契约与数据模型.md`、`docs/14-安全与权限设计.md`、`docs/16-运维手册与交接.md`、`docs/18-客服实时性与降级链规范.md`、`docs/21-接口契约裁决.md` |
| 状态 | 待评审；M1 联调前定稿，M3 前完成桥接与流式链路 |

版本 1.0 · 2026-10-20 · 与 `docs/00` v1.0 对齐。本文只回答一件事：**业务人员怎么用到 Agent，以及这条链路上每一跳的契约与失败行为。** 接口字段以 `docs/12` 为准，本文不另立一套 API。

---

## 0. 结论先行

1. **唯一业务入口是 `apps/web`**。员工不安装 DSH、不接触 DSH 界面、不持有 DSH 令牌；DSH 原生界面只给管理员调试。
2. 调用链固定为：`浏览器 → apps/web → apps/api → 中心 DSH Host（唯一 Typert Remote service）→ 模型/只读 MCP`。任何一跳都不能被绕过。
3. `apps/api` 不是转发器，是**策略执行点**：鉴权、intent 白名单、事实快照、配额、幂等、审计、降级都在这里；Host 只做有界任务。
4. 流式用 Typert `@Remote({ mode:'stream' })`；取消用 `AbortSignal`（Host 方法最后一个参数，wire 上不存在），取消要能从浏览器一路传到模型与工具，**在下一次步骤边界 ≤2s 停止**（`docs/12` §8.3）。
5. peer principal 做机器级授权：apps/api 以非 owner principal `business-api` 调用，只授予 `businessAgent/run` 一个动作；业务 RBAC 在 apps/api 完成，Host 再校验一次 `role × intent`（纵深防御）。
6. **实现校准（重要）**：DSH 的 `GET /connect?token=…` 接入的 API Peer，principal **恒为 owner**（包文档明确），owner 调用跳过 `remoteAccess` 判定。因此**不能**用 `/connect` 作为业务 BFF 的接入方式；改用 Host 内 `business-bridge` 精确路由 + 进程内非 owner Peer（第 3.3 节）。
7. Host 单进程，并发硬上限：全局 8、单用户 2、单会话 1、排队 30；全局满则入队（≤30），单用户第 3 个/单会话第 2 个返回 `409 conflict` + `Retry-After: 5`，队列满返回 `429 quota`，不无限排队。
8. 会话按「用户 + intent + 业务对象 + 版本」唯一归属，跨用户/跨对象绝不共享；映射存 Redis（AOF），丢了可重建，正文仍以 Postgres 为事实源。
9. 失败必须**降级到人能干的事**：模板话术、关键词检索、人工审批、只读页面；不允许白屏、无限转圈、静默失败。
10. preset/skill 是**代码资产**：一个 `clothing-ops` preset（`docs/04`）、四个 skill、bundle 版本化、灰度、可回滚；禁止在生产卷手改。

---

## 1. 唯一入口原则

### 1.1 原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | 一个业务入口 | 所有业务操作从 `apps/web` 的 12 个页面发起；没有第二个业务前端 |
| P2 | 一条写入路径 | 平台写只经写入门（`docs/11`）；Agent 不直写平台 |
| P3 | 一个 Agent 出口 | 业务侧只通过 `apps/api` 的 `/api/agent/*` 调用 Agent；不直连 Host、不直连模型供应商 |
| P4 | 一个身份体系 | 业务身份来自 `users/roles/memberships`；DSH 身份只用于机器调用与管理员调试 |
| P5 | 一个事实源 | 页面与 Agent 的事实都来自 Postgres/知识库；`.jsonl` 与 DSH 原生存储不承载业务数据 |
| P6 | 可取消、可审计 | 每次 Agent 调用有 `request_id`、有取消、有成本记录、有审计 |

### 1.2 禁止清单（评审必查）

| 禁止 | 原因 | 检查方式 |
|---|---|---|
| 浏览器直连 DSH Host | 绕过鉴权与审计 | 网络策略 + 代码扫描（`DSH_BRIDGE_URL` 不得出现在 `apps/web`） |
| 浏览器/前端直连模型供应商 | 密钥泄露、成本失控 | 依赖与代码扫描（provider SDK 不得在 `apps/web`） |
| 用 DSH 原生界面承载业务 | 无业务审批、无 RBAC、无审计闭环 | 运维检查：Host 只在内部网络 + 宿主回环，不对局域网/公网暴露 |
| 把 `dsh-headless` 当交互通道 | 每次一任务即退出，无多轮、无取消 | 架构评审 + 代码扫描（`apps/api` 不得 spawn headless 处理网页请求） |
| 浏览器自动化（Playwright/Puppeteer/Selenium）操作平台 | 账号风控与封号风险 | `check:boundaries`（`docs/15` S6） |
| 前端从 `.jsonl` 拼装数据 | 双写漂移、不可审计 | 静态规则 S1/S2 |
| Agent 输出直接落业务表 | 未经判断/审批 | 代码评审：只能写 `content_draft`/`judgment`/`reply_draft` 等中间表 |

---

## 2. 调用链总览

### 2.1 拓扑

```text
┌────────────┐  ①POST /api/agent/run → 202   ┌─────────────┐
│ 浏览器      │ ────────────────────────────► │ apps/web    │
│ (operator) │  ②GET /api/agent/runs/:id/events (SSE)
│            │ ◄──────────────────────────── │ (BFF/SSR)   │
└────────────┘                               └──────┬──────┘
                                                    │ ③同源转发（会话 Cookie）
                                                    ▼
                                             ┌─────────────┐
                                             │ apps/api    │ ④鉴权/RBAC/intent/配额
                                             │ 策略执行点   │ ⑤事实快照/幂等/审计
                                             └──────┬──────┘
                                                    │ ⑥POST /internal/agent/run
                                                    │   Bearer + 信封 + AbortSignal
                                                    ▼
                                       ┌────────────────────────┐
                                       │ dsh-host (单进程常驻)   │
                                       │ ⑦business-bridge 精确路由│
                                       │ ⑧非 owner Peer         │
                                       │ ⑨Typert stream         │
                                       │   businessAgent/run    │
                                       └──────┬─────────┬───────┘
                                              │         │
                                    ┌─────────▼──┐  ┌───▼────────┐
                                    │ 模型供应商  │  │ 只读 MCP    │
                                    │ (经白名单)  │  │ ERP/知识库  │
                                    └────────────┘  └────────────┘
```

### 2.2 每一跳的契约

| 跳 | 协议 | 认证 | 超时 | 失败返回 | 备注 |
|---|---|---|---|---|---|
| ① 浏览器→web | HTTPS + Cookie + CSRF | `__Host-dssaas_sid` | 建连 5s | 401 `unauthorized` / 403 `forbidden` | 只创建 run，不阻塞到生成完 |
| ② web→浏览器 | SSE（GET） | 同上 | 首帧 10s | 401 | 断线用 `Last-Event-ID` 续传 |
| ③ web→api | 内部 HTTP（同源） | 会话 Cookie 透传 | 5s 建连 | 502 `upstream_5xx` | web 不解析业务 |
| ④ api 鉴权 | — | 角色矩阵 + intent 白名单 | — | 403 `forbidden` | `docs/14` 第 2 节 |
| ⑤ 事实快照 | Postgres 读 | — | 200ms | 422 `invalid_fact` | 快照哈希进信封 |
| ⑥ api→Host | HTTP POST + SSE 回传 | 桥接 Bearer（0600 文件） | 建连 3s | 503 `dsh_unavailable` | 仅内部网络 |
| ⑦ Host 路由 | 精确路径 + 方法 | 同上（常量时间比较） | 同上 | 404（不暴露存在性） | 非可信来源拒绝 |
| ⑧ Peer 授权 | Typert Gateway | 非 owner principal | — | `remote-access/denied` → 403 | 只授 `businessAgent/run` |
| ⑨ Agent 执行 | 进程内 + 外部调用 | 凭据引用 | `timeout_ms`（≤600s） | `timeout` | 首 token 8s（客服 5s） |

### 2.3 关键设计点

- `DSH_BRIDGE_URL` 只在 `apps/api` 的环境里，web 拿不到；
- api 不信任 Host 返回的业务结论：Host 产出的是「建议/草稿」，事实字段必须再经判断层（`docs/11`）；
- Host 不信任 api 传来的角色：信封里的 `role/intent` 在 Host 侧再校验一次，防 api 被攻破后越权；
- 取消是链路级能力：浏览器「停止」/断开 → api 取消 → Host `signal` → Agent 停止；
- 页面读路径完全不依赖 Host：Host 挂了，商品、会话、审批、报表照常可看。

---

## 3. Typert RPC 契约与授权

### 3.1 Remote service 定义（`dsh-bundle/src/business-agent.ts`）

```ts
import { Remote } from '@deepseek-ai/dsh-typert-protocol';

export type AgentIntent =
  | 'content.draft'       // 文案草稿
  | 'content.rewrite'     // 改写/降重
  | 'product.qa'          // 商品资料问答
  | 'support.suggest'     // 客服建议
  | 'inquiry.quote_draft' // 询盘报价草稿
  | 'listing.diagnose';   // 上架驳回诊断

export interface AgentRunEnvelope {
  runId: string;
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  intent: AgentIntent;
  context: { page: string; objectType?: string; objectId?: string };
  input: { text?: string; params?: Record<string, unknown> };
  facts: { snapshotId: string; hash: string; version: number };
  bundle: { preset: string; skills: string[]; manifestHash: string };
  toolsAllow?: string[];              // 只能收窄预设工具集
  limits: { timeoutMs: number; maxOutputTokens: number; maxToolCalls: number; maxCostFen: number };
}

export class BusinessAgentService {
  @Remote({ mode: 'stream' })
  async *run(
    env: AgentRunEnvelope,
    signal: AbortSignal,              // 最后一个 Host 参数；wire 上不存在
  ): AsyncIterable<AgentEvent> {
    // 1) 校验 role × intent、toolsAllow ⊆ 预设工具集
    // 2) 解析会话、拼装上下文（事实块只读）
    // 3) 跑 agent loop，逐项 yield step/delta/tool/usage/final
  }
}
```

要点（均以包行为为准）：
- `mode:'stream'` 的方法返回 `Iterable`/`AsyncIterable`；一元调用不能走流式载体，反之亦然；
- 取消参数必须是最后一个 Host 参数、类型为全局 `AbortSignal`，Gateway 在解码后的业务参数之后注入；它**不是 wire 参数**；
- 入参在 Host 侧按 Typert 编译类型校验一次，非法即 `gateway/input-invalid`；
- 本方案不使用流上行（`RemoteStream<Out, In>`）：业务调用是单向请求 + 单向事件流；
- 方法内通过 `this.ctx.invocation` 读取 `request/peer/signal`，不要把 peer 塞进参数。

### 3.2 Host 内部事件 → 对外 SSE 映射

Host 只产出内部事件，`apps/api` 负责翻译成 `docs/12` §7.3 的公开事件，前端只认公开事件。

| Host 内部事件 | 载荷 | 对外 SSE（`docs/12`） |
|---|---|---|
| `queued` | `{position}` | `run.queued` |
| `meta` | `{runId, sessionId, bundleVersion, modelId}` | `hello`（首帧）+ `run.started` |
| `step` | `{seq, name, status, summary}` | `run.step` |
| `delta` | `{text}` | `run.delta` |
| `tool_call` | `{tool, argsSummary}` | `run.tool_call` |
| `tool_result` | `{tool, ok, summary}` | `run.tool_result` |
| `need_input` | `{question, options[]}` | `run.need_input` |
| `usage` | `{inputTokens, outputTokens, costFen}` | 并入 `run.finished` |
| `final` | `{output, durationMs}` | `run.finished` |
| `error` | `{code, message, retryable, nextAction}` | `run.error` |

顺序约束：`hello` 必须第一，`run.finished`/`run.error` 必须最后且互斥；`run.delta` 可在 `run.started` 之后任意位置；心跳是注释行，不是事件。

### 3.3 peer principal 授权

#### 3.3.1 为什么不用 `/connect`

已核实：`GET /connect?token=…` 创建的 API Peer，principal 恒为 `owner`；owner 的调用**不解析资源、不询问 `remoteAccess`**，直接分派。把它交给业务 BFF 等于放弃方法级授权，与总纲「peer principal 决定权限」相悖。

#### 3.3.2 采用方案：Host 内精确路由 + 非 owner Peer

```text
apps/api ──POST /internal/agent/run──► business-bridge（Host 内插件）
                                         │ 1. 校验 Bearer（常量时间）
                                         │ 2. 校验来源网段 + 方法 + Content-Type
                                         │ 3. createPeer({ principal:{kind:'business-api'}, interactions:'none' })
                                         │ 4. typertGateway.stream({
                                         │      namespace:'businessAgent', method:'run',
                                         │      args:[env], peer, signal })
                                         │ 5. 迭代结果 → SSE 帧（内部事件）
                                         └─ 请求结束/断开 → peer.dispose() + controller.abort()
```

要点：
- 精确路由挂在 `ctx.webServer.register({ kind:'exact', path:'/internal/agent/run', handler })`（route 字段以 `dsh-host-webserver` 类型为准），handler 直接拿 node `req/res` 写 SSE；**不经过** `connection.admit`，避免拿到 owner Peer；
- 来源校验：只接受 compose 内部网络地址（`172.16.0.0/12`、`10.0.0.0/8` 中配置的网段）与 `127.0.0.1`；其它一律 404；
- 令牌比较用 `crypto.timingSafeEqual`；令牌文件 0600，Host 启动生成，api 启动读取；
- 每个请求一个 Peer，结束即 `dispose()`；不跨请求复用，避免权限漂移与事件串流；
- `interactions:'none'`：业务 Peer 不参与转发事件，防越权接收 `$events`。

#### 3.3.3 policy（意图；字段名以 `@deepseek-ai/dsh-api-remote-access` 类型为准）

| 项 | 值 |
|---|---|
| principal kind | `business-api` |
| role | `agent-runner` |
| resource | `global`（本服务不暴露资源型方法） |
| actions | 仅 `businessAgent/run` |
| condition | `args[0].intent` 在部署白名单内；`args[0].role` 与 intent 匹配 |
| 其它动作 | `no-allow` |
| 资源解析失败 | `resource-invalid` |

```ts
// 示意
ctx.remoteAccess.registerPolicy('business-api', {
  bindings: () => [{ role: 'agent-runner', resource: { kind: 'global' } }],
  explain: (req) =>
    req.action === 'businessAgent/run' && envelopeAllows(req.args?.[0])
      ? undefined
      : 'business-api may only invoke businessAgent/run',
});
```

拒绝原因以 `remote-access/denied` 的 `details.reason` 返回；api 统一映射为 `403 forbidden` 并审计 `agent.denied`。

### 3.4 AbortSignal 全链路

| 环节 | 动作 |
|---|---|
| 浏览器 | 「停止」→ `POST /agent/runs/:id/cancel`，并 `AbortController.abort()` 断开 SSE |
| `apps/web` | 转发取消请求；SSE 断开 |
| `apps/api` | 取消端点 → 通知 Host 请求中断；`AbortSignal.any([clientSignal, AbortSignal.timeout(timeout_ms)])` |
| api→Host | abort 时关闭上游连接；Host 侧 `req.on('close')` → `bridgeController.abort()` |
| Host bridge | `signal` 传给 Gateway；请求结束 `peer.dispose()` |
| Gateway | 流方法的 `signal` 中止 → 迭代器 `return()` → Agent loop 收到取消 |
| Agent | 停止模型调用（供应商请求 abort）、停止工具（`exec.signal`）；**在下一次步骤边界停止，≤2s** |
| 结果 | 流以 `gateway/cancelled` 结束；api 把 run 置 `cancelled`；SSE 以 `run.finished{output.partial=true}` 收尾（连接已断则由 `GET /agent/runs/:id` 显示 `cancelled`） |
| 成本 | 已产生的 token 照记（`docs/12` §8.3） |
| 产物 | `output.partial=true` + `partial_output_ref`；**不写业务表**；用户可查看/复制，采用需重新提交 |

约定：
- 取消后 5 秒内必须释放并发槽；超时未释放计入 `agent_leak` 告警；
- 取消幂等：终态重复取消返回 `200` + 当前状态；
- 取消不产生半成品草稿；已写入的 `content_draft` 只在用户显式保存时产生。

---

## 4. 中心 Host 进程模型与并发上限

### 4.1 进程模型

| 项 | 取值 | 说明 |
|---|---|---|
| 进程数 | **1**（单实例） | 会话、preset、MCP 连接都在进程内；多实例会分裂状态 |
| 运行方式 | `dsh --profile business`（自建 profile） | 常驻、无 GUI |
| 监听 | 容器内 `0.0.0.0:43180`；compose 只发布 `127.0.0.1:43180`；`internal` 网络仅 api 可达 | 不向局域网/公网暴露 |
| 事件循环 | 单 Node 进程 | Agent 运行是异步 I/O；CPU 密集操作（图片处理）不放 Host |
| 内存上限 | 4 GB（容器 limit） | 超限 OOM 重启；上下文过大是主因 |
| 会话存储 | `dsh-data` 持久卷 | `.jsonl` 黑匣子 + 配置；不进业务读路径 |
| 重启语义 | 进行中的 run 失败，返回 `dsh_unavailable` | 客户端可重试；会话可恢复 |
| 健康 | `GET /internal/health` | 返回版本、preset 名、manifestHash、MCP 工具数 |

> `business` / `admin` 是本项目**自建 profile**（放 `dsh-bundle/`），不复用随附 `web` / `headless` / `sdk` / `acp` 的语义；随附 profile 名不能改含义，否则升级后行为漂移无从归因（`docs/04` X1）。

### 4.2 并发与配额

| 限制 | 默认 | 超限行为 | 可调 |
|---|---|---|---|
| 全局并发运行 | 8 | 满 → 入队（≤30），不直接报错 | `AGENT_MAX_CONCURRENCY` |
| 等待队列 | 30 | 队列满 → `429 quota` | `AGENT_QUEUE_LIMIT` |
| 单用户并发 | 2 | 第 3 个 `409 conflict`（`detail.sub=user_busy`） | 固定（`docs/12` §8.3） |
| 单会话并发 | 1 | 第 2 个 `409 conflict`（`detail.sub=agent_running`） | 固定（防上下文交错） |
| 单次运行时长 | 120s（请求可下调，上限 600s） | `timeout` 504，强制 abort | `AGENT_RUN_TIMEOUT_MS` |
| 首 token | 8s；客服草稿 5s（`docs/18`） | 切备用 route → 模板 | `AGENT_FIRST_TOKEN_TIMEOUT_MS` |
| 队列等待 | 30s | `429 quota`，不无限等 | 固定 |
| 单次工具调用 | 8 次 | 超限结束并提示 | 信封 `maxToolCalls` |
| 单次 MCP 调用 | 15s/次，4 次/运行 | 超时即失败，继续主流程 | MCP 配置 |
| 单次成本 | 文案 ¥2 / 图片 ¥20 | 超限拒绝或降级低价模型 | 路由配额 |
| 上下文 | 输入 ≤32k tokens；输出 ≤4k（文案）/8k（详情） | 裁剪历史或拒绝 | 信封 `limits` |

### 4.3 过载策略

```text
请求 → 单用户未满？ → 单会话未占用？ → 全局并发未满？ → 执行
          │否              │否              │否
          ▼                ▼                ▼
      409 conflict      409 conflict      入队(≤30)
                                            │ 等待>30s 或 队列满
                                            ▼
                                        429 quota（带 Retry-After）
```

- 队列 FIFO + 用户公平（同一用户连续排队不超过 2 个）；
- 批处理（夜间 headless）与在线请求分队列：在线优先，批处理最多占 50% 并发；
- 过载时**不降级成同步长等待**：直接告诉用户稍后再试，避免雪崩；
- 所有超限都写审计（`agent.overload`），用于容量规划。

---

## 5. 会话与上下文管理

### 5.1 归属规则

**会话键** = `sha256("v1|" + org_id + "|" + user_id + "|" + intent + "|" + objectType + "|" + objectId + "|" + objectVersion)`。

| 规则 | 说明 |
|---|---|
| 跨用户不共享 | 同一 SKU 的两个运营各自独立会话，防串话与越权 |
| 跨对象不共享 | 不同 SKU/会话/询盘各自独立 |
| 版本变化即新会话 | 草稿版本、商品数据版本变化后，旧上下文不再适用（防基于过期事实） |
| intent 隔离 | 文案生成与客服建议不共享上下文 |
| 可重建 | 映射丢了最多丢上下文，不丢业务数据；DSH 会话文件仍在，可人工排障 |

### 5.2 映射存储（Redis，非业务表）

| 项 | 规则 |
|---|---|
| 键 | `agent:sess:<session_key>` |
| 值 | `{dsh_session_id, bundle_hash, created_at, last_used_at, run_count}` |
| TTL | 按 intent：`content.draft` 24h、`product.qa` 7d、`support.suggest` 30min、`inquiry.quote_draft` 24h、`listing.diagnose` 24h、判断类单次 |
| 持久化 | Redis AOF；丢失时映射 miss → 新建会话（上下文重置，不报错） |
| 一致性 | 映射是索引不是事实源；`content_draft`/`judgment`/`reply_draft` 才是事实 |
| 清理 | TTL 自动过期；`abandoned` 由后台任务按 30 天清理审计引用 |

> 不新增 `agent_session` 表：`docs/06` 的 28 张表与 `docs/12` 的 4 张支撑表已定稿，会话映射属于可重建索引，放 Redis 足够。

### 5.3 生命周期

| intent | TTL | 续用条件 | 过期行为 |
|---|---|---|---|
| `content.draft` | 24h | 同用户、同对象、同版本 | 新建会话 |
| `content.rewrite` | 24h | 同上 | 新建 |
| `product.qa` | 7d | 同上 | 新建 |
| `support.suggest` | 30min | 同会话 + 同最后消息 id | 新建（避免旧上下文污染） |
| `inquiry.quote_draft` | 24h | 同询盘 + 同版本 | 新建 |
| `listing.diagnose` | 24h | 同 listing + 同驳回批次 | 新建 |
| L2 语义裁决 | 单次 | 不复用 | 每次独立，防上下文偏置 |
| 夜间批处理 | 单次 | 不复用 | 每次 `dsh-headless` 新会话 |

### 5.4 上下文组成（顺序固定）

```text
[1] 系统提示词（clothing-ops preset 的 intent 变体，版本化）
[2] 事实快照块（来自 Postgres，带 snapshotId + hash；只读，禁止模型改写）
[3] skill 片段（按 intent 选 1–2 个，版本化）
[4] 最近对话（最多 N 轮 / token 预算内；超出裁剪最早）
[5] 本次用户输入
```

规则：
- **事实块不可被对话覆盖**：模型输出与事实冲突时判断层拦截（`invalid_fact`）；
- 历史裁剪优先保留「用户最新意图 + 最近工具结果」，不保留完整旧草稿；
- 工具结果截断：单条 ≤8 KB，超出摘要 + 引用；
- 不写入跨用户长期记忆；知识检索只读；
- 上下文超 60% 预算时压缩一次（保留事实块 + 最近 3 轮），压缩动作写审计；
- `.jsonl` 仅调试：保留 7 天，业务接口不读（`docs/14` / `docs/15` 静态规则）。

### 5.5 会话与审批的关系

- 会话产出只写 `content_draft`/`judgment`/`reply_draft`，不直接产生 `approval`；
- 审批由 api 在草稿提交时创建，与会话解耦；
- 同一草稿的多次生成尝试都记在该草稿的版本历史里，便于对比与追责；
- Agent **永不**直接写平台、永不需要 `confirm_irreversible=true`（必须为 `false`）。

---

## 6. `POST /api/agent/run` 语义（以 `docs/12` §8 为准）

### 6.1 创建运行（异步 + SSE）

```http
POST /api/agent/run HTTP/1.1
Cookie: __Host-dssaas_sid=…
X-CSRF-Token: …
Idempotency-Key: 0199f0c2-…
X-Request-Id: 0199f0c2-…
Content-Type: application/json
```

```json
{
  "intent": "content.draft",
  "context": { "page": "copy_workbench", "object_type": "product", "object_id": "01J9Z…" },
  "input": { "text": "给这款风衣写拼多多标题，突出防风", "params": { "platform": "pdd", "length_max": 60 } },
  "stream": true,
  "timeout_ms": 120000,
  "tools_allow": ["kb.search", "product.read", "content.draft"],
  "confirm_irreversible": false
}
```

响应 `202`：

```json
{
  "request_id": "req_01J9Z…",
  "data": {
    "run_id": "01J9Z…",
    "status": "queued",
    "sse_url": "/api/agent/runs/01J9Z…/events",
    "expires_at": "2026-10-20T06:10:00.000Z",
    "concurrency_remaining": 1
  }
}
```

字段约束：
- `intent` 只接受第 6.2 节六个枚举，其它 422 `validation_failed`；
- `context` 只允许 `page/object_type/object_id`，不得传文件路径、URL、SQL；
- `stream=false` 时用 `GET /api/agent/runs/:id` 轮询（≤30s 的小任务）；
- `timeout_ms` 默认 120000、最大 600000；
- `tools_allow` 只能收窄预设工具集；越权项**忽略并审计**，不报错也不扩权；
- `confirm_irreversible` 必须为 `false`；Agent 不写平台，只产出待审批产物。

### 6.2 intent 白名单与角色

| intent | 用途 | viewer | operator | admin | 默认工具集（可收窄） |
|---|---|---|---|---|---|
| `content.draft` | 标题/卖点/详情草稿 | — | ✓ | ✓ | `kb.search`、`product.read`、`content.draft` |
| `content.rewrite` | 改写/降重 | — | ✓ | ✓ | 同上 |
| `product.qa` | 商品资料问答 | — | ✓ | ✓ | `kb.search`、`product.read` |
| `support.suggest` | 客服建议/话术 | — | ✓ | ✓ | `kb.search`、`conversation.read`、`reply.suggest` |
| `inquiry.quote_draft` | 询盘报价草稿 | — | ✓ | ✓ | `kb.search`、`product.read`、`quote.draft` |
| `listing.diagnose` | 上架驳回诊断 | — | — | ✓ | `kb.search`、`listing.read`、`platform.rules` |

角色不足返回 `403 forbidden`；Host 侧再校验一次，不一致按越权处理（`403` + 高优先级审计）。

> `viewer` 不创建 run（`docs/12` §8 将 `POST /agent/run` 标为 `O`）；只读问答走 `GET /kb/search`，不经过 Agent。

### 6.3 SSE（`GET /api/agent/runs/:id/events`）

```http
GET /api/agent/runs/01J9Z…/events HTTP/1.1
Cookie: __Host-dssaas_sid=…
Last-Event-ID: 01J9Z…-000042
Accept: text/event-stream
```

```text
retry: 3000

event: hello
id: 01J9Z…-000000
data: {"event_id":"01J9Z…-000000","type":"hello","seq":0,"ts":"…","org_id":1,"request_id":"req_…","payload":{"stream_id":"01J9Z…","server_time":"…","heartbeat_s":15}}

event: run.started
id: 01J9Z…-000001
data: {"…","payload":{"run_id":"01J9Z…","model_id":"…","started_at":"…"}}

event: run.delta
id: 01J9Z…-000002
data: {"…","payload":{"run_id":"01J9Z…","seq":2,"text":"秋季通勤"}}

event: run.finished
id: 01J9Z…-000020
data: {"…","payload":{"run_id":"01J9Z…","output":{"text":"…","artifacts":[]},"tokens":{"in":812,"out":146},"cost_cents":2,"duration_ms":4300}}
```

| 规则 | 值 |
|---|---|
| 事件类型 | `hello`、`run.queued`、`run.started`、`run.step`、`run.delta`、`run.tool_call`、`run.tool_result`、`run.need_input`、`run.finished`、`run.error` |
| 心跳 | 每 15 秒注释行 `: hb <ts>`，不计事件 |
| 断线续传 | `Last-Event-ID` 或 `?last_event_id=`；Redis Stream 回放（≥5 分钟 / 500 条） |
| 缺口 | 发 `event: resync` + 全量快照，前端整体刷新 |
| 背压 | 缓冲 >1000 条或 30s 未消费 → 断开，前端重连；不丢事件 |
| 结果保留 | run 结束后 30 分钟内可查 `GET /agent/runs/:id` |
| 鉴权 | 同会话 Cookie（只读 GET，不校验 CSRF） |
| 降级 | 连续 3 次重连失败 → 切轮询（列表 5s / 详情 3s）+ 横幅 |

> 金额字段统一为 `*_cents`（整数分，`docs/21` §1）；`docs/12` 若仍写 `cost_fen`/`micro_cny`，实现时以 `docs/21` 裁决为准。

### 6.4 状态码与错误（`docs/12` §4）

| HTTP | code | 场景 | 前端行为 |
|---|---|---|---|
| 202 | — | 已创建 run | 打开 SSE |
| 422 | `validation_failed` | 字段/intent 非法、`timeout_ms` 超限 | 字段级报错 |
| 401 | `unauthorized` | 未登录/会话过期 | 跳登录 |
| 403 | `forbidden` | 角色不足、intent 不允许、peer 拒绝 | 提示无权限 |
| 404 | `not_found` | run 不存在/已过期 | 空态 |
| 409 | `conflict` | 并发超限（`sub=user_busy/agent_running`）、版本冲突 | 按 `Retry-After` 重试 |
| 409 | `idempotency_conflict` | 同 key 不同 payload | 换 key 重试 |
| 422 | `invalid_fact` | 事实缺失/冲突 | 列缺失字段，跳主数据 |
| 429 | `quota` | 队列满/配额用尽 | 显示用量与倒计时 |
| 429 | `rate_limited` | 本地/平台限流 | 尊重 `Retry-After` |
| 503 | `dsh_unavailable` | Host 不可达/重启 | 降级模板/人工 |

> `timeout` 是 run 的终态（`GET /agent/runs/:id` 与 SSE `run.error`），不会作为 `POST /agent/run` 的响应；`locked` 只出现在登录端点。

### 6.5 超时矩阵

| 阶段 | 超时 | 行为 |
|---|---|---|
| 创建 run | 5s | 超时 → 503 `dsh_unavailable` |
| 排队 | 30s | 超时 → `run.error{code:"quota"}`，不执行 |
| 首 token | 8s（客服 5s） | 切备用 route；仍无 → 模板降级 |
| 单步 | 30s | 当前步失败，按可重试/人工分类 |
| 整次运行 | `timeout_ms`（默认 120s，上限 600s） | 强制 abort → `run.error{code:"timeout"}` |
| 取消生效 | 步骤边界 ≤2s | 超 5s 未释放 → `agent_leak` 告警 |
| SSE 建连 | 10s | 前端提示重连 |

### 6.6 幂等与重试

| 场景 | 行为 |
|---|---|
| 同 `Idempotency-Key` 运行中 | `409 conflict` + `Retry-After: 2`（不并行） |
| 同 key 已完成（10 分钟内） | 返回缓存的 `202` 结果 + `Idempotent-Replayed: true` |
| 同 key 失败（可重试） | 允许重试，沿用 key；内部生成新 `run_id` |
| SSE 断线 | 不取消 run；用 `Last-Event-ID` 续传 |
| 页面刷新 | 不自动重发；用 `run_id` 查结果 |
| 取消后重试 | 新 `Idempotency-Key`（旧 run 已终态） |

### 6.7 审计与成本

每次 run 落：
- `audit_log`：`action=agent.run`，`irreversible=false`，`meta` 含 `intent`、`run_id`、bundle 版本、模型、结果、是否取消/降级；
- `model_call_log`：模型、token、耗时、成本、产出摘要；
- 指标：`agent_runs_total{status}`、`agent_first_token_seconds`、`agent_duration_seconds`、`agent_cost_cents_total`；
- 成本进 `cost_ledger`，可按用户/intent/对象归集。

---

## 7. `dsh-headless` 的边界

| 维度 | 适用 | 禁用 |
|---|---|---|
| 交互形态 | 一次性任务、无人值守 | 多轮对话、需要中途取消/追问 |
| 调用方 | `apps/worker`、CI、定时任务 | `apps/api` 的网页请求路径 |
| 会话 | 每次新会话；或 `--session-id` 续接同一批任务 | 需要多用户并发共享上下文 |
| 输出 | `--json` 事件流 + 退出码 | 需要 SSE 实时回显给浏览器 |
| 凭据 | 启动环境 / `.env`（headless 默认**禁用托管凭据存储**） | 依赖 GUI 保存的登录凭据的供应商 |
| 生命周期 | 跑完即退，不开端口 | 常驻服务、健康检查探针 |
| 并发 | 由 worker 控制，≤CPU 核数 | 高并发在线请求 |

### 7.1 正确用法

```bash
# 批量文案：每个 SKU 一次 headless 调用，事件流落文件，再入草稿表
dsh --profile headless --json \
  "为 SKU ${SKU_ID} 生成拼多多标题与三条卖点，事实见 ${FACTS_FILE}" \
  > "artifacts/batch/${SKU_ID}.jsonl"
# 退出码：0 完成；1 中止/出错。--json 下正常结束以 final 事件收尾，
# 但失败运行也可能只有 final（空）——必须同时看退出码与 turn_end 原因。
```

约定：
- 任务文本必须自包含（headless 不读业务库）；
- 事实以文件/环境注入，**不把整库塞进提示词**；
- 批处理失败重试 2 次，仍失败进死信并通知；
- `--session-id` 只用于同一批任务续接，不跨业务对象复用；续接受 cwd/归属/preset 限制，不匹配会在任务前失败；
- 每次调用落 `audit_log`（`action=agent.headless`），与在线 run 同口径计成本；
- headless 的 stderr 可能含模型推理文本，重定向到受控位置，不进普通日志。

### 7.2 为什么不用 headless 做在线

| 原因 | 后果 |
|---|---|
| 每次启动加载插件（秒级） | 首 token 超 5 秒，违背草稿 SLA（`docs/18`） |
| 无取消语义（进程级） | 用户点停止只能杀进程，浪费成本 |
| 无多轮 | 澄清/追问要重启进程，上下文丢失 |
| 无并发治理 | 每请求一进程，内存与模型配额失控 |
| 凭据模型不同 | 托管凭据被禁用，需另注入环境变量 |
| 无 SSE | 只能整段输出，前端无法流式 |

---

## 8. 管理员如何使用 DSH 原生界面

### 8.1 访问方式（独立 admin 实例）

生产 Host 与管理员调试**不共用会话目录**，避免两个进程同时写同一 `dsh-data` 造成会话损坏。

| 项 | 规则 |
|---|---|
| 实例 | 独立 `dsh --profile admin` 实例，`DSH_HOME=/data/dsh-admin`（独立卷），共用只读 `dsh-bundle` |
| 端口 | 容器内 43181；compose 只发布 `127.0.0.1:43181` |
| 入口 | `ssh -N -L 43181:127.0.0.1:43181 ops@<host>`；从启动日志取一次性 `?token=…` |
| 身份 | 只有 admin 角色的人可用；使用者即 OS 登录者 |
| 时限 | 单次调试 ≤2 小时；结束切回 `viewer` 预设 |
| 审计 | 登录、preset 切换、工具调用写 `audit_log`（`action=dsh.admin_session`） |
| 网络 | 禁止公网/局域网直连；禁止 `--host 0.0.0.0` 对外 |

### 8.2 允许与禁止

| 允许 | 禁止 |
|---|---|
| 调试 preset/skill 加载、复现问题 | 用它替代业务页面做日常操作 |
| 观察 agent 行为、看会话黑匣子 | 在界面里直接改生产数据/发平台消息 |
| 测试 MCP 工具连通性 | 把启动 token 给非管理员 |
| 验证四档权限预设 | 长期保持 `admin`/`danger-full-access` 预设 |
| 验证取消/超时行为 | 把 `.jsonl` 内容拷进业务系统 |

### 8.3 调试后的收尾

1. 切回默认预设（`/permission viewer`）；
2. 关闭浏览器窗口与 SSH 隧道；
3. 记录「调试了什么、发现了什么、是否要改 preset/skill」；
4. 改了配置走 PR，不在生产卷直接改；
5. 清理 admin 卷中不再需要的会话（按保留期）。

---

## 9. preset / skill 的版本管理与灰度

### 9.1 资产结构（与 `docs/04` §2.1 一致）

```text
dsh-bundle/
├─ manifest.json                 # intent → bundleVersion、skills、modelRoute
├─ presets/
│  └─ clothing-ops/              # 唯一业务 preset（组合四组工具与技能）
│     ├─ 1.4.2/…
│     └─ 1.4.3/…
├─ skills/
│  ├─ brand-tone/2.1.0/SKILL.md
│  ├─ size-guide/3.0.1/SKILL.md
│  ├─ care/1.1.0/SKILL.md
│  └─ return-policy/1.3.0/SKILL.md
└─ config/
   ├─ cordis.patch.yml           # 权限预设、MCP、桥接
   └─ mcp-policy.yaml            # 工具白名单
```

`manifest.json`：

```json
{
  "schemaVersion": 1,
  "dsh": ">=0.2.1-rc.2 <0.3.0",
  "preset": "clothing-ops",
  "intents": {
    "content.draft":  { "bundle": "1.4.2", "skills": ["brand-tone@2.1.0"], "modelRoute": "copy-default" },
    "support.suggest":{ "bundle": "1.4.2", "skills": ["return-policy@1.3.0", "brand-tone@2.1.0"], "modelRoute": "reply-default" }
  }
}
```

规则：
- **一个 preset**（`clothing-ops`），intent 差异通过 bundle 内的提示词变体 + skill 选择实现；不建多套 preset（`docs/04` 决策）；
- bundle 版本语义化；**内容变更必须升版本**，不允许原地改；
- `manifest.json` 参与构建哈希，Host `/internal/health` 上报 `manifestHash`，api 启动校验一致；
- 生产卷只读挂载 `dsh-bundle`；改配置走镜像/发布，不 `docker cp`；
- 兼容性：manifest 声明 `dsh` 版本范围；升级前由 `docs/16` 第 8 节回归覆盖。

### 9.2 灰度

| 阶段 | 流量 | 观察 | 回滚条件 |
|---|---|---|---|
| 内部 | admin 用户 100% | 1 天 | 任一 P0/P1 |
| 金丝雀 | 5% 用户 / 5% 对象 | 2 小时 | 错误率 >2× 基线，或 L1 命中率异常 |
| 扩量 | 25% → 50% | 各 4 小时 | 成本 >1.2× 预算，或草稿采用率下降 >10% |
| 全量 | 100% | 24 小时 | — |

实现：
- `intent → bundle 版本` 映射存配置（热更新，不改镜像）；api 按 `hash(user_id) % 100` 分桶；
- 灰度期间两个 bundle 同时挂载，回滚只切映射（<1 分钟）；
- 每次切换写审计 `agent.bundle_rollout`（谁、从哪个版本到哪个版本、比例、原因）；
- 灰度期间**禁止同时改模型路由**，否则无法归因。

### 9.3 变更门槛

| 变更 | 必须 |
|---|---|
| skill 文案调整 | 版本 +1；黄金集对应子集回归；业务评审 |
| 提示词调整 | bundle +1；黄金集全量；安全评审（防越权） |
| 新增工具/MCP | bundle +1；`docs/14` MCP 白名单更新；安全测试 SEC-25~31 |
| 模型路由变更 | 单独变更单；压测 + 成本评估 |
| 权限预设变更 | `docs/14` 评审；越权回归 |

---

## 10. 失败降级路径

### 10.1 总原则

1. **读路径不依赖 Agent**：Host 挂了，商品、会话、审批、报表照常可看；
2. **写路径不依赖 Agent**：人工可以手写文案、手动回复、手动上架（走审批）；
3. **降级要可见**：明确告诉用户「现在用的是模板/关键词/稍后重试」，不静默；
4. **降级要可恢复**：Host 恢复后自动回切，不需要刷新或重启；
5. **降级有上限**：队列/重试有 TTL，不允许无限堆积；
6. **降级不降事实与审批**：任何降级路径都不得跳过写入门、去重、审计（`docs/18` 铁律）。

### 10.2 熔断与探测

| 项 | 取值 |
|---|---|
| 熔断触发 | 30 秒内 5 次失败（连接失败/5xx/超时） |
| 打开时长 | 60 秒 |
| 半开 | 放 1 个探针请求；成功则闭合 |
| 探测 | `/ready` 每 15 秒；Host `/internal/health` 每 15 秒 |
| 恢复 | 闭合后按 10%→50%→100% 放量，10 分钟内完成 |

### 10.3 故障 → 页面表现

| 故障 | 检测 | 页面表现 | 用户可见文案 | 自动恢复 |
|---|---|---|---|---|
| Host 进程挂 | `/ready` 失败 + 熔断打开 | 生成类按钮置灰；顶部横幅；读路径正常 | 「AI 能力暂不可用，可先用话术模板/人工处理」 | Host 起来后 15s 内恢复 |
| Host 重启中 | 连接拒绝 | 进行中的 run 标失败，给「重试」 | 「生成中断，可重试」 | 重试成功即恢复 |
| 首 token 超时 | 8s（客服 5s）计时 | 切备用 route → 模板；标注来源 | 「已切换备用模型/话术模板（原因：超时）」 | 下次请求重试主模型 |
| 模型供应商全挂 | 路由错误率 | 切备用；全挂则同 Host 挂 | 「模型服务异常，请稍后重试或用模板」 | 供应商恢复后回切 |
| 流中途断开 | SSE error/close | 保留已生成部分，标「未完成」；禁止直接采用 | 「内容未生成完整，请重试」 | 用新 run 重试 |
| 429 限流 | 平台/模型/本地 | 排队提示 + 倒计时 | 「当前请求较多，约 N 秒后重试」 | 自动 |
| 配额用尽 | 计数 | 生成禁用；审批/发送不受影响 | 「今日额度已用完，请联系管理员」 | 次日 0 点 |
| 知识库不可用 | 检索失败 | 关键词检索 + 低置信标记 | 「知识库暂不可用，结果仅供参考」 | 恢复后自动 |
| 事实缺失 | 预检 422 | 跳转主数据补全 | 「缺少尺码表/成分，请先补全」 | 补全后重试 |
| 判断层不可用 | L2 错误 | 全部升级人工（L3） | 「需人工复核」 | L2 恢复 |
| 数据库只读 | `/ready` 部分失败 | 全站写禁用，读可用 | 「系统维护中，暂不可提交」 | 恢复后解除 |
| 桥接令牌失效 | 401/404 | 同 Host 挂 | 同上 | api 重读令牌/重启 |

### 10.4 降级链（与 `docs/18` §0.3 对齐）

| 环节 | L0 正常 | L1 一级 | L2 二级 | L3 兜底 |
|---|---|---|---|---|
| 生成通道 | 主 route | 备用 route（一次切换） | 话术模板/固定骨架 | 人工手写 |
| 知识检索 | 向量 + 关键词 | 纯关键词 | 内置最小知识集 | 人工查文档 |
| 实时推送 | SSE | 20s 轮询 | 页内红条 + 标题闪烁 | IM/邮件通知值班 |
| 审批 | 正常队列 | 只读展示 | 通知升级 | 人工电话升级 |
| 客服草稿 | 5s 内 AI 草稿 | 备用模型 | 模板（标注原因） | 空白 + 人工 |

硬指标：客服草稿 `t0→t6` 100% ≤5000ms（`docs/18` §0.2）；其它 intent 首 token P95 <3s、超 8s 必须降级。

### 10.5 前端实现要求

- 统一 `AgentAvailability` 上下文：`available / degraded / unavailable`，由 api 的 `/ready` + 熔断状态驱动；
- 按钮禁用必须带 `title` 说明原因，不能只是灰；
- SSE 断线重连：1s/2s/4s/8s，上限 15s，最多 3 次；带 `Last-Event-ID`；重连不重放已渲染内容；
- 连续 3 次失败 → 轮询（列表 5s / 详情 3s）+ 顶部横幅；恢复后自动切回；
- 「停止」按钮在 run 创建后立即可用；停止后 2 秒内 UI 回到可操作状态；
- 所有降级事件上报 `agent_degraded_total{reason}`，用于验收「草稿降级率」；
- 「未完成」内容不得直接进入审批：必须重试成功或人工确认后才能提交。

### 10.6 降级演练（必须做）

| 演练 | 方法 | 通过标准 |
|---|---|---|
| Host 停机 | `docker compose stop dsh-host` | 页面 15s 内显示降级；读路径可用；恢复后自动回切 |
| 模型超时 | mock 延迟 10s | 客服 5s 内切模板并标注；其它 intent 8s 内切备用 |
| 流中断 | 中途杀连接 | 显示「未完成」；不落草稿；可重试 |
| 并发打满 | 20 并发 | 第 9 个入队（≤30）；队列满 429；单用户第 3 个 409；无雪崩 |
| 取消 | 运行中点停止 | ≤2s 停止产出、5s 内释放槽位；审计有 `cancelled` |
| SSE 重连 | 断网 10s 后恢复 | `Last-Event-ID` 续传无重复/无缺口 |

---

## 11. 验收清单

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 唯一入口 | 代码/网络中不存在浏览器直连 Host 或模型供应商 |
| 2 | 创建 + 流式 | `POST` 返回 202；`GET events` 收齐 `hello→run.finished`；首 token P95 <3s |
| 3 | 取消 | 取消后 ≤2s 停止产出、5s 释放槽位；终态幂等；审计有记录 |
| 4 | peer 授权 | 非白名单动作返回 `remote-access/denied`；owner 通道未被业务使用 |
| 5 | 并发上限 | 第 9 个入队；单用户第 3 个 409 + `Retry-After`；队列满 429 `quota`；无雪崩 |
| 6 | 会话归属 | 两用户同对象不串；版本变化新建；Redis 丢失可重建 |
| 7 | 幂等 | 同 key 不重复运行；完成可重放；in-flight 409 |
| 8 | headless 边界 | 网页请求路径无 headless 调用 |
| 9 | 管理员界面 | 独立实例、仅回环、一次性 token、有审计 |
| 10 | 版本灰度 | 切映射即生效；回滚 <1 分钟；两版本可并存 |
| 11 | 降级 | 第 10.6 节六个演练全过 |
| 12 | 成本 | 每次 run 有 token/成本记录，可按用户/intent/对象归集 |

## 12. 与其他文档的接口

| 文档 | 本文提供 | 对方提供 |
|---|---|---|
| `docs/04` | Remote service 与桥接的落地方式 | 扩展点、preset 目录、版本锁、回归 R1–R6 |
| `docs/06` | 会话映射不落业务表、审计字段使用方式 | 表结构、字段约束 |
| `docs/11` | Agent 产出如何进入草稿/判断/审批 | 状态机与写入门规则 |
| `docs/12` | Host 内部事件 → SSE 的映射、桥接语义 | `/agent/*` 端点、SSE 事件、错误码 |
| `docs/14` | 桥接鉴权、peer principal、预设选择、MCP 白名单 | 角色矩阵、密钥、审计、沙箱档位 |
| `docs/15` | Agent 链路测试点（流式/取消/降级/并发） | 测试分层与门禁 |
| `docs/16` | Host 部署、并发配置、降级开关、升级回归 | 环境、探针、SOP |
| `docs/18` | 客服 5 秒降级的实现约束 | 实时性与降级链细节 |
