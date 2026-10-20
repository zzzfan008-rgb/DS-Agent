# 17 · 交互入口与 Agent 驱动规范

| 项 | 内容 |
|---|---|
| 编号 | 17 |
| 用途 | 定义唯一入口原则、网页→api→中心 DSH Host 调用链、Typert 流式 RPC、AbortSignal 取消、peer principal 授权、Host 进程模型与并发、会话归属、`POST /agent/run` 语义、headless 边界、管理员界面、preset/skill 版本与灰度、失败降级 |
| 读者 | 前端、后端、Agent 集成开发者、运维、管理员；评审人 |
| 依赖 | `docs/00-方案总纲.md`（第三、五、十九、二十章）、`docs/14-安全与权限设计.md`、`docs/15-测试与质量门策略.md`、`docs/16-运维手册与交接.md`；DSH 包 `dsh-api-gateway`、`dsh-api-remote-access`、`dsh-permission-presets`、`dsh-agent-preset`、`dsh-skill-filesystem`、`dsh-session-persistence-jsonl`、`dsh-headless` |
| 状态 | 待评审；M1 联调前定稿，M3 前完成桥接与流式链路 |

版本 1.0 · 2026-10-20 · 与 `docs/00` v1.0 对齐。本文只回答一件事：**业务人员怎么用到 Agent，以及这条链路上每一跳的契约与失败行为。**

---

## 0. 结论先行

1. **唯一业务入口是 `apps/web`**。员工不安装 DSH、不接触 DSH 界面、不持有 DSH 令牌；DSH 原生界面只给管理员调试。
2. 调用链固定为：`浏览器 → apps/web(SSR/BFF) → apps/api → 中心 DSH Host（唯一 Typert Remote service）→ 模型/MCP`。任何一跳都不能被绕过。
3. `apps/api` 不是「转发器」，是**策略执行点**：鉴权、用途白名单、事实快照、配额、审计、降级都在这里；Host 只做有界任务。
4. 流式用 Typert `@Remote({ mode:'stream' })`，取消用 `AbortSignal`（Host 方法的最后一个参数，wire 上不存在），**取消要能从浏览器一路传到模型与工具**。
5. peer principal 做**机器级**授权：apps/api 以非 owner principal `business-api` 调用，只被授予 `businessAgent/run` 一个动作；业务 RBAC 在 apps/api 内完成（纵深防御，Host 再校验一次角色-用途）。
6. **实现校准（重要）**：DSH 的 `GET /connect?token=…` 接入的 API Peer，其 principal **恒为 owner**（包文档明确），owner 调用跳过 `remoteAccess` 判定。因此**不能用 `/connect` 作为业务 BFF 的接入方式**；改用 Host 内 `business-bridge` 精确路由 + 进程内非 owner Peer（第 3.3 节）。
7. Host 单进程、并发有硬上限（默认 8 跑 + 32 排队）；超限返回 `429 agent_busy`，**不排队到天荒地老**。
8. 会话按「用户 + 用途 + 业务对象 + 版本」唯一归属，跨用户/跨对象绝不共享；DSH `.jsonl` 只是黑匣子，业务不读。
9. 失败必须**降级到人能干的事**：模板话术、关键词检索、人工审批、只读页面；不允许白屏、不允许无限转圈、不允许静默失败。
10. preset/skill 是**代码资产**：Git 管理、版本化、灰度、可回滚；禁止在生产卷里手改。

---

## 1. 唯一入口原则

### 1.1 原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | 一个业务入口 | 所有业务操作从 `apps/web` 的 12 个页面发起；没有第二个业务前端 |
| P2 | 一条写入路径 | 平台写只经写入门（`docs/11`）；Agent 不直写平台 |
| P3 | 一个 Agent 出口 | 业务侧只通过 `apps/api` 的 `/agent/*` 调用 Agent；不直连 Host、不直连模型供应商 |
| P4 | 一个身份体系 | 业务身份来自 `users/roles/memberships`；DSH 身份只用于机器调用与管理员调试 |
| P5 | 一个事实源 | 页面与 Agent 的事实都来自 Postgres/知识库；`.jsonl` 与 DSH 原生存储不承载业务数据 |
| P6 | 可取消、可审计 | 每个 Agent 调用有 `request_id`、有取消、有成本记录、有审计 |

### 1.2 禁止清单（评审必查）

| 禁止 | 原因 | 检查方式 |
|---|---|---|
| 浏览器直连 DSH Host | 绕过鉴权与审计 | 网络策略 + 代码扫描（禁止 `DSH_BRIDGE_URL` 出现在 `apps/web`） |
| 浏览器/前端直连模型供应商 | 密钥泄露、成本失控 | 依赖与代码扫描（禁止 provider SDK 在 `apps/web`） |
| 用 DSH 原生界面承载业务 | 无业务审批、无 RBAC、无审计闭环 | 运维检查：Host 只绑回环 |
| 把 `dsh-headless` 当交互通道 | 每次一任务即退出，无多轮、无取消 | 架构评审 + 代码扫描（`apps/api` 不得 spawn headless 处理网页请求） |
| 浏览器自动化（Playwright/Puppeteer/Selenium）操作平台 | 账号风控与封号风险 | `check:boundaries`（`docs/15` S6） |
| 前端从 `.jsonl` 拼装数据 | 双写漂移、不可审计 | 静态规则 S1/S2 |
| Agent 输出直接落业务表 | 未经判断/审批 | 代码评审：只能写 `content_draft`/`judgment` 等中间表 |

---

## 2. 调用链总览

### 2.1 拓扑

```text
┌────────────┐   ①POST /api/agent/run (SSE)   ┌─────────────┐
│ 浏览器      │ ─────────────────────────────► │ apps/web    │
│ (operator) │ ◄───── SSE 事件 ────────────── │ (BFF/SSR)   │
└────────────┘                                └──────┬──────┘
                                                     │ ②同源转发（带会话 Cookie）
                                                     ▼
                                              ┌─────────────┐
                                              │ apps/api    │ ③鉴权/RBAC/用途白名单/配额
                                              │ 策略执行点   │ ④事实快照/幂等/审计
                                              └──────┬──────┘
                                                     │ ⑤POST /internal/agent/run
                                                     │   Bearer + 信封 + AbortSignal
                                                     ▼
                                        ┌────────────────────────┐
                                        │ dsh-host (单进程常驻)   │
                                        │ ⑥business-bridge 精确路由│
                                        │ ⑦非 owner Peer         │
                                        │ ⑧Typert stream         │
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
| ① 浏览器→web | HTTPS + Cookie + CSRF | `__Host-dssaas_sid` | 首字节 10s，总 130s | 401/403/429 | SSE；断线可重连（见 7.6） |
| ② web→api | 内部 HTTP（同源） | 会话 Cookie 透传 | 5s 建连 | 502 `web_upstream` | web 不解析业务 |
| ③ api 鉴权 | — | 角色矩阵 + 用途白名单 | — | 403 `authz_denied` | `docs/14` 第 2 节 |
| ④ 事实快照 | Postgres 读 | — | 200ms | 422 `invalid_fact` | 快照哈希进信封 |
| ⑤ api→Host | HTTP POST + SSE 回传 | 桥接 Bearer（0600 文件） | 建连 3s | 503 `agent_unavailable` | 仅内部网络 |
| ⑥ Host 路由 | 精确路径 + 方法 | 同上（常量时间比较） | 同上 | 404（不暴露存在性） | 非回环拒绝 |
| ⑦ Peer 授权 | Typert Gateway | 非 owner principal | — | `remote-access/denied` | 只授 `businessAgent/run` |
| ⑧ Agent 执行 | 进程内 + 外部调用 | 凭据引用 | 120s | `agent_timeout` | 首 token 8s |
| 模型/MCP | HTTPS | 供应商 Key / MCP 配置 | 30s/15s | 分类错误 | 出网白名单 |

### 2.3 关键设计点

- **web 不直连 api 的 Host 地址**：`DSH_BRIDGE_URL` 只在 `apps/api` 的环境里；
- **api 不信任 Host 返回的业务结论**：Host 返回的是「草稿/建议」，事实字段必须再经 api 校验（`docs/11` 判断层）；
- **Host 不信任 api 传来的角色**：信封里的 `role/purpose` 会在 Host 侧再校验一次（防 api 被攻破后越权）；
- **取消是链路级能力**：浏览器断开 → web 断开 → api `AbortController.abort()` → Host 请求 signal → Typert signal → Agent 停止。

---

## 3. Typert RPC 契约与授权

### 3.1 Remote service 定义（`dsh-bundle/src/business-agent.ts`）

```ts
import { Remote } from '@deepseek-ai/dsh-typert-protocol';

export interface AgentRunEnvelope {
  requestId: string;
  userId: string;
  role: 'viewer' | 'operator' | 'admin';
  purpose: AgentPurpose;              // 见 6.2
  object: { type: string; id: string; version: number };
  factsSnapshotId: string;
  factHash: string;                   // 事实快照哈希；Host 只读引用
  preset: string;                     // 例：copy.generate@1.4.2
  limits: { maxOutputTokens: number; maxToolCalls: number; maxCostCny: number };
  input: Record<string, unknown>;
}

export class BusinessAgentService {
  @Remote({ mode: 'stream' })
  async *run(
    env: AgentRunEnvelope,
    signal: AbortSignal,              // 最后一个 Host 参数；wire 上不存在
  ): AsyncIterable<AgentEvent> {
    yield { type: 'meta', runId: env.requestId };
    // …构建上下文、调用 agent loop、逐项 yield delta/tool/usage…
  }
}
```

要点（均以包行为为准）：
- `mode:'stream'` 的方法返回 `Iterable`/`AsyncIterable`；一元调用不能走流式载体，反之亦然；
- 取消参数必须是最后一个 Host 参数、类型为全局 `AbortSignal`，Gateway 在解码后的业务参数之后注入；它**不是 wire 参数**；
- 入参在 Host 侧按 Typert 编译类型校验一次，非法即 `gateway/input-invalid`；
- 流上行（`RemoteStream<Out, In>`）本方案不用：业务调用是单向请求 + 单向事件流；
- 方法内通过 `this.ctx.invocation` 读取 `request/peer/signal`，不要把 peer 塞进参数。

### 3.2 事件协议（Host→api→浏览器）

| 事件 | 载荷 | 频率 | 用途 |
|---|---|---|---|
| `meta` | `runId, sessionId, presetVersion, modelId` | 1 次 | 前端关联与排障 |
| `delta` | `{ text }` | 流式 | 逐字/逐段渲染 |
| `tool` | `{ name, status, durationMs }` | 每次工具调用 | 显示「正在查知识库」等 |
| `usage` | `{ inputTokens, outputTokens, costCny }` | 1 次（结束前） | 成本归集 |
| `done` | `{ finishReason, outputHash }` | 1 次 | 正常结束 |
| `error` | `{ code, message, retryable }` | 1 次 | 失败结束 |
| `heartbeat` | `{}` | 每 15s | 防代理超时 |

顺序不变：`meta` 必须第一，`done`/`error` 必须最后且互斥；`delta` 可在任意位置。

### 3.3 peer principal 授权

#### 3.3.1 为什么不用 `/connect`

已核实：`GET /connect?token=…` 创建的 API Peer，principal 恒为 `owner`；owner 的调用**不解析资源、不询问 `remoteAccess`**，直接分派。把它交给业务 BFF 等于放弃方法级授权，与总纲「peer principal 决定权限」相悖。

#### 3.3.2 采用方案：Host 内精确路由 + 非 owner Peer

```text
apps/api ──POST /internal/agent/run──► business-bridge（Host 内插件）
                                         │ 1. 校验 Bearer（常量时间）
                                         │ 2. 校验来源地址 + 方法 + Content-Type
                                         │ 3. createPeer({ principal: { kind:'business-api' }, interactions:'none' })
                                         │ 4. typertGateway.stream({ namespace:'businessAgent', method:'run',
                                         │                           args:[env], peer, signal })
                                         │ 5. 迭代结果 → SSE 帧
                                         └─ 请求结束/断开 → peer.dispose() + controller.abort()
```

要点：
- 精确路由必须挂在 `ctx.webServer.register({ kind:'exact', path:'/internal/agent/run', handler })`，handler 直接拿 node `req/res` 写 SSE；**不经过** `connection.admit`，避免拿到 owner Peer；
- 来源校验：只接受 compose 内部网络地址（`172.16.0.0/12`/`10.0.0.0/8` 中配置的网段）与 `127.0.0.1`；其它一律 404；
- 令牌比较用 `crypto.timingSafeEqual`；令牌文件 0600，Host 启动生成，api 启动读取；
- 每个请求一个 Peer，结束即 `dispose()`；不跨请求复用，避免权限漂移与事件串流；
- `interactions:'none'`：业务 Peer 不参与转发事件，防越权接收 `$events`。

#### 3.3.3 policy 形状（意图，类型以包为准）

| 项 | 值 |
|---|---|
| principal kind | `business-api` |
| role | `agent-runner` |
| resource | `global`（本服务不暴露资源型方法） |
| actions | 仅 `businessAgent/run` |
| condition | `args[0].purpose` 在部署白名单内；`args[0].role` 与 `purpose` 匹配 |
| 其它动作 | `no-allow` |
| 资源解析失败 | `resource-invalid` |

```ts
// 示意：注册 policy（字段名以 @deepseek-ai/dsh-api-remote-access 的类型为准）
ctx.remoteAccess.registerPolicy('business-api', {
  bindings: () => [{ role: 'agent-runner', resource: { kind: 'global' } }],
  explain: (req) =>
    req.action === 'businessAgent/run' && envAllows(req.args?.[0])
      ? undefined
      : 'business-api may only invoke businessAgent/run',
});
```

拒绝原因会以 `remote-access/denied` 的 `details.reason` 返回（`resource-invalid` / `no-allow` / `policy-failed`）；api 侧统一映射为 `403 agent_denied` 并审计。

### 3.4 AbortSignal 全链路

| 环节 | 动作 |
|---|---|
| 浏览器 | 用户点「停止」→ `AbortController.abort()`；或直接关闭页面 |
| `apps/web` | fetch 的 `signal` 透传到 api |
| `apps/api` | `req.on('close')` → `controller.abort()`；同时 `AbortSignal.any([clientSignal, AbortSignal.timeout(120_000)])` |
| api→Host | 请求 abort 时关闭上游连接；Host 侧 `req.on('close')` → `bridgeController.abort()` |
| Host bridge | `signal` 传给 Gateway；请求结束时 `peer.dispose()` |
| Gateway | 流方法的 `signal` 中止 → 迭代器 `return()` → Agent loop 收到取消 |
| Agent | 停止模型调用（供应商请求 abort）、停止工具（`exec.signal`）、落 `agent.cancelled` 审计 |
| 结果 | 流以 `gateway/cancelled` 结束；api 转 `error{code:'cancelled'}`；前端显示「已停止」 |

约定：
- 取消**不产生半成品业务数据**：取消时只丢弃草稿缓冲，不落 `content_draft`；
- 取消后 5 秒内必须释放并发槽；超时未释放计入 `agent_leak` 告警；
- 幂等：同一 `Idempotency-Key` 取消后重试视为新运行，不复用旧 runId。

---

## 4. 中心 Host 进程模型与并发上限

### 4.1 进程模型

| 项 | 取值 | 说明 |
|---|---|---|
| 进程数 | **1**（单实例） | 会话、preset、MCP 连接都在进程内；多实例会导致会话/工具状态分裂 |
| 运行方式 | `dsh --profile business`（自建 profile） | 常驻、无 GUI、只监听内部地址 |
| 监听地址 | `127.0.0.1:43180` 或 compose 内部地址 | 绝不 `0.0.0.0` 暴露公网 |
| 事件循环 | 单 Node 进程 | Agent 运行是异步 I/O；CPU 密集操作（图片处理）不放 Host |
| 内存上限 | 4 GB（容器 limit） | 超限 OOM 重启；会话上下文过大是主因 |
| 会话存储 | `dsh-data` 持久卷 | `.jsonl` 黑匣子 + 配置；不进业务备份（见 `docs/14`） |
| 重启语义 | 进行中的运行丢失，返回 `agent_unavailable` | 客户端可重试；Host 重启后会话可恢复 |

### 4.2 并发与配额

| 限制 | 默认 | 超限行为 | 可调 |
|---|---|---|---|
| 全局并发运行 | 8 | `429 agent_busy` + `Retry-After: 5` | `AGENT_MAX_CONCURRENCY` |
| 等待队列 | 32 | 入队满 → `429 agent_busy` | `AGENT_QUEUE_LIMIT` |
| 单用户并发 | 2 | 第 3 个 `429 agent_user_busy` | 固定 |
| 单会话并发 | 1 | 第 2 个 `409 agent_running` | 固定（防上下文交错） |
| 单次运行时长 | 120s | `agent_timeout`，强制取消 | `AGENT_RUN_TIMEOUT_MS` |
| 首 token | 8s | 切备用模型/降级模板 | `AGENT_FIRST_TOKEN_TIMEOUT_MS` |
| 队列等待 | 30s | `429 agent_busy`，不无限等 | 固定 |
| 单次工具调用 | 8 次 | 超限结束并提示 | 信封 `maxToolCalls` |
| 单次 MCP 调用 | 15s/次，4 次/运行 | 超时即失败，继续主流程 | MCP 配置 |
| 单次成本 | ¥2（文案）/ ¥20（图片） | 超限拒绝或降级低价模型 | 路由配额 |
| 上下文 | 输入 ≤32k tokens，输出 ≤4k（文案）/8k（详情） | 超限裁剪历史或拒绝 | 信封 `limits` |

### 4.3 过载策略

```text
到达 → 全局并发未满？ → 单用户未满？ → 单会话未占用？ → 执行
         │否              │否              │否
         ▼                ▼                ▼
      入队(≤32)         429 user_busy     409 running
         │ 等待>30s 或 队列满
         ▼
      429 agent_busy（带 Retry-After）
```

- 队列 FIFO + 用户公平（同一用户连续排队不超过 2 个）；
- 批处理（夜间）与在线请求分队列：在线优先，批处理最多占 50% 并发；
- 过载时**不降级成同步长等待**：直接告诉用户「稍后再试」，避免雪崩。

---

## 5. 会话与上下文管理

### 5.1 归属规则

**会话键 = `user_id + purpose + object_type + object_id + object_version`**，哈希后作为业务会话键。

| 规则 | 说明 |
|---|---|
| 跨用户不共享 | 同一 SKU 的两个运营各自独立会话，防串话与越权 |
| 跨对象不共享 | 不同 SKU/会话/询盘各自独立 |
| 版本变化即新会话 | 草稿版本、商品数据版本变化后，旧上下文不再适用（防基于过期事实） |
| 用途隔离 | 文案生成与客服回复不共享上下文 |
| 可重建 | 会话映射表是索引，丢了可从确定性键 + DSH 会话目录重建 |

### 5.2 映射表 `agent_session`（运维域，可重建，不作事实源）

| 字段 | 说明 |
|---|---|
| `id` | uuid |
| `session_key` | 上式的 SHA-256（唯一索引） |
| `dsh_session_id` | Host 侧会话 id |
| `user_id` / `purpose` / `object_type` / `object_id` / `object_version` | 归属维度 |
| `preset_version` / `skill_versions` | 创建时快照 |
| `status` | `active` / `expired` / `abandoned` |
| `last_used_at` / `created_at` | 生命周期 |
| `run_count` / `total_cost_cny` | 用量 |

> 说明：该表属「运维索引」，不是业务事实表；可在迁移中重建，不参与审批与对账。业务事实仍在 `content_draft`、`judgment`、`conversation` 等表。

### 5.3 生命周期

| 用途 | TTL | 续用条件 | 过期行为 |
|---|---|---|---|
| 文案生成 | 24h | 同用户、同 SKU、同对象版本 | 新建会话；旧会话保留供审计 |
| 商品问答 | 7d | 同上 | 新建 |
| 客服草稿 | 30min | 同会话 + 同最后消息 id | 新建（避免旧上下文污染） |
| 询盘报价 | 24h | 同询盘 + 同版本 | 新建 |
| 判断层 L2 | 单次 | 不复用 | 每次独立，防上下文偏置 |
| 夜间批处理 | 单次 | 不复用 | 每次 `dsh-headless` 新会话 |

### 5.4 上下文组成（顺序固定）

```text
[1] 系统提示词（preset 版本化，含角色边界、事实纪律、工具说明）
[2] 事实快照块（来自 Postgres，带 snapshotId + hash；只读，禁止模型改写）
[3] skill 片段（按用途选 1–2 个，版本化）
[4] 最近对话（最多 N 轮 / token 预算内；超出裁剪最早）
[5] 本次用户输入
```

规则：
- **事实块不可被对话覆盖**：模型若输出与事实冲突，判断层拦截（`invalid_fact`）；
- 历史裁剪优先保留「用户最新意图 + 最近工具结果」，不保留完整旧草稿；
- 工具结果截断：单条 ≤8 KB，超出摘要 + 引用；
- 不写入跨用户长期记忆；DSH 的记忆/知识能力只用于只读检索；
- 上下文超 60% 预算时做一次压缩（保留事实块 + 最近 3 轮），压缩动作记审计；
- `.jsonl` 仅调试：保留 7 天，业务接口不读（`docs/14` / `docs/15` 静态规则）。

### 5.5 会话与审批的关系

- 会话产出只写 `content_draft`/`judgment`，不直接产生 `approval`；
- 审批由 api 在草稿提交时创建，与会话解耦；
- 同一草稿的多次生成尝试都记在同一 `content_draft` 的版本历史里，便于对比与追责。

---

## 6. `POST /agent/run` 语义

### 6.1 请求

```http
POST /api/agent/run HTTP/1.1
Cookie: __Host-dssaas_sid=…
X-CSRF-Token: …
Idempotency-Key: 0199f0c2-…
X-Request-Id: 0199f0c2-…
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "purpose": "copy.generate",
  "object": { "type": "sku", "id": "0b6f…", "version": 3 },
  "input": { "instruction": "写一版秋季通勤风标题与卖点", "tone": "克制" },
  "options": { "maxOutputTokens": 1200, "stream": true }
}
```

校验顺序（任一失败即返回，不调用 Host）：
1. 会话与 CSRF；
2. 角色 × 用途白名单（`viewer` 只能 `qa.*`/`report.*`）；
3. 对象存在且 `version` 匹配（乐观锁）；
4. 事实快照可生成（缺尺码/成分 → `422 invalid_fact`，并列出缺失字段）；
5. 配额（用户/日、用途/日、成本）；
6. 幂等键。

### 6.2 用途白名单（`AgentPurpose`）

| 用途 | 说明 | viewer | operator | admin | 默认 preset |
|---|---|---|---|---|---|
| `copy.generate` | 标题/卖点/详情 | — | ✓ | ✓ | `viewer` |
| `copy.rewrite` | 改写/降重 | — | ✓ | ✓ | `viewer` |
| `reply.draft` | 客服回复草稿 | — | ✓ | ✓ | `viewer` |
| `quote.draft` | 询盘报价草稿 | — | ✓ | ✓ | `viewer` |
| `qa.product` | 商品资料问答 | ✓ | ✓ | ✓ | `viewer` |
| `judge.semantic` | L2 语义裁决 | — | — | ✓（系统） | `viewer` |
| `media.prompt` | 出图提示词 | — | ✓ | ✓ | `viewer` |
| `batch.copy` | 批量文案（headless） | — | — | ✓ | `ci` |
| `report.narrative` | 日报叙述 | ✓ | ✓ | ✓ | `viewer` |

### 6.3 响应（SSE）

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

```text
event: meta
data: {"runId":"…","sessionId":"…","preset":"copy.generate@1.4.2","modelId":"…"}

event: delta
data: {"text":"秋季通勤"}

event: usage
data: {"inputTokens":812,"outputTokens":146,"costCny":0.021}

event: done
data: {"finishReason":"stop","outputHash":"…"}
```

### 6.4 状态码与错误

| HTTP | code | 场景 | 前端行为 |
|---|---|---|---|
| 200 | — | 流开始 | 渲染 |
| 400 | `bad_request` | 参数缺失/类型错 | 提示修正 |
| 401 | `auth_required` | 未登录/会话过期 | 跳登录 |
| 403 | `authz_denied` / `agent_denied` | 角色/用途/peer 拒绝 | 提示无权限 |
| 409 | `agent_running` | 同会话已有运行 | 提示等待或取消 |
| 409 | `version_conflict` | 对象版本过期 | 刷新后重试 |
| 422 | `invalid_fact` | 事实缺失/冲突 | 列出缺什么，跳主数据 |
| 429 | `agent_busy` / `agent_user_busy` | 并发/队列满 | 显示 `Retry-After` 倒计时 |
| 429 | `quota_exceeded` | 配额用尽 | 提示明日/找 admin |
| 503 | `agent_unavailable` | Host 不可用/重启 | 降级（第 11 节） |
| 504 | `agent_timeout` | 超 120s | 提示重试/改用模板 |

### 6.5 幂等与重试

| 场景 | 行为 |
|---|---|
| 同 `Idempotency-Key` 运行中 | 409 `agent_running`（不并行） |
| 同 key 已完成（10 分钟内） | 直接返回缓存结果（非流式 JSON，`X-Idempotent-Replay: true`） |
| 同 key 失败（可重试） | 允许重试，沿用 key；内部生成新 `runId` |
| 客户端断线重连 | 用 `runId` 调 `GET /api/agent/runs/:id`（10 分钟内可查最终结果；不重放 token 流） |
| 页面刷新 | 不自动重发；用户手动重试 |

### 6.6 审计与成本

每次运行落：
- `audit_log`：`agent.run`（用户、用途、对象、preset/skill 版本、模型、结果、是否取消/降级）；
- `model_call_log`：模型、token、耗时、成本、产出摘要；
- 指标：`agent_runs_total{status}`、`agent_first_token_seconds`、`agent_duration_seconds`、`agent_cost_cny_total`。

---

## 7. `dsh-headless` 的边界

| 维度 | 适用 | 禁用 |
|---|---|---|
| 交互形态 | 一次性任务、无人值守 | 多轮对话、需要中途取消/追问 |
| 调用方 | `apps/worker`、CI、定时任务 | `apps/api` 的网页请求路径 |
| 会话 | 每次新会话；或 `--session-id` 续接同一批任务 | 需要多用户并发共享上下文 |
| 输出 | `--json` 事件流 + 退出码 | 需要 SSE 实时回显给浏览器 |
| 凭据 | 启动环境 / `.env`（headless 默认**禁用托管凭据存储**） | 依赖 GUI 保存的登录凭据的供应商 |
| 生命周期 | 进程跑完即退，不开端口 | 常驻服务、健康检查探针 |
| 并发 | 由 worker 控制，≤CPU 核数 | 高并发在线请求 |

### 7.1 正确用法

```bash
# 批量文案：读任务 → 每个 SKU 一次 headless 调用 → 写草稿表
dsh --profile headless --json \
  "为 SKU ${SKU_ID} 生成拼多多标题与三条卖点，事实见 ${FACTS_FILE}" \
  > "artifacts/batch/${SKU_ID}.jsonl"
# 退出码 0 成功；1 失败（--json 下以 error 事件或 turn_end 原因判定）
```

约定：
- 任务文本必须自包含（headless 不读业务库）；
- 事实以文件/环境注入，**不把整库塞进提示词**；
- 批处理失败重试 2 次，仍失败进死信并通知；
- `--session-id` 只用于同一批任务的续接，不跨业务对象复用；
- 每次调用落 `audit_log`（`agent.headless`），与在线运行同口径计成本。

### 7.2 为什么不用 headless 做在线

| 原因 | 后果 |
|---|---|
| 每次启动加载插件（秒级） | 首 token 超 5 秒，违背草稿 SLA |
| 无取消语义（进程级） | 用户点停止只能杀进程，浪费成本 |
| 无多轮 | 澄清/追问要重新起进程，上下文丢失 |
| 无并发治理 | 每个请求一个进程，内存与模型配额失控 |
| 凭据模型不同 | 托管凭据被禁用，需另注入环境变量 |

---

## 8. 管理员如何使用 DSH 原生界面

### 8.1 访问方式

```bash
# 1) 跳板/本机建立隧道（Host 只绑回环）
ssh -N -L 43180:127.0.0.1:43180 ops@<host>
# 2) 从 Host 日志取一次性启动 token（打印一次，含过期）
docker compose logs dsh-host | grep -o 'http://127.0.0.1:43180/?token=[^ ]*' | tail -1
# 3) 本机浏览器打开该 URL；token 换取 Cookie 后从地址栏消失
# 4) 用完关闭窗口；不共享 URL、不截图外发
```

| 项 | 规则 |
|---|---|
| 网络 | 仅回环/隧道；禁止公网暴露、禁止 `--host 0.0.0.0` |
| 身份 | 只有 admin 角色的人可用；使用者即 OS 登录者 |
| 时限 | 单次调试 ≤2 小时；结束切回 `viewer` 预设 |
| 审计 | 登录、preset 切换、工具调用都记 `audit_log`（`dsh.admin_session`） |
| 数据 | 界面里能看到会话内容；禁止在其中处理真实买家隐私以外的批量数据 |

### 8.2 允许与禁止

| 允许 | 禁止 |
|---|---|
| 调试 preset/skill 加载 | 用它替代业务页面做日常操作 |
| 观察 agent 行为、复现问题 | 在界面里直接改生产数据/发平台消息 |
| 测试 MCP 工具连通性 | 把启动 token 给非管理员 |
| 查看会话黑匣子排障 | 把 `.jsonl` 内容拷进业务系统 |
| 验证权限档位 | 长期保持 `admin`/`danger-full-access` 预设 |

### 8.3 调试后的收尾

1. 切回默认预设（`/permission viewer`）；
2. 关闭浏览器窗口与 SSH 隧道；
3. 记录「调试了什么、发现了什么、是否需要改 preset/skill」；
4. 若改了配置，走 PR，不在生产卷直接改。

---

## 9. preset / skill 的版本管理与灰度

### 9.1 目录与版本

```text
dsh-bundle/
├─ manifest.json                 # purpose → preset@version、skills、模型路由
├─ presets/
│  ├─ copy.generate/1.4.2/…
│  ├─ reply.draft/1.2.0/…
│  └─ qa.product/1.0.3/…
├─ skills/
│  ├─ brand-tone/2.1.0/SKILL.md
│  ├─ size-guide/3.0.1/SKILL.md
│  ├─ care-label/1.1.0/SKILL.md
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
  "purposes": {
    "copy.generate": { "preset": "copy.generate@1.4.2", "skills": ["brand-tone@2.1.0"], "modelRoute": "copy-default" },
    "reply.draft":   { "preset": "reply.draft@1.2.0",   "skills": ["return-policy@1.3.0", "brand-tone@2.1.0"] }
  }
}
```

规则：
- 版本号语义化；**内容变更必须升版本**，不允许原地改；
- `manifest.json` 参与构建哈希，Host `/internal/health` 上报 `manifestHash`，api 启动校验一致；
- 生产卷只读挂载 `dsh-bundle`；改配置走镜像/发布，不 `docker cp`；
- 兼容性：preset 声明 `dsh` 版本范围与 `skillsApi`；升级前由 `docs/16` 第 8 节回归覆盖。

### 9.2 灰度

| 阶段 | 流量 | 观察 | 回滚条件 |
|---|---|---|---|
| 内部 | admin 用户 100% | 1 天 | 任一 P0/P1 |
| 金丝雀 | 5% 用户 / 5% SKU | 2 小时 | 错误率 >2× 基线，或 L1 命中率异常 |
| 扩量 | 25% → 50% | 各 4 小时 | 成本 >1.2× 预算，或草稿采用率下降 >10% |
| 全量 | 100% | 24 小时 | — |

实现：
- `purpose → 版本` 的映射存配置（可热更新，不改镜像）；api 按 `hash(user_id) % 100` 分桶；
- 灰度期间两个版本同时挂载，回滚只需切映射；
- 每次切换写审计 `preset.rollout`（谁、从哪个版本到哪个版本、比例、原因）；
- 灰度期间**禁止同时改模型路由**，否则无法归因。

### 9.3 变更门槛

| 变更 | 必须 |
|---|---|
| skill 文案调整 | 版本 +1；黄金集对应子集回归；业务评审 |
| preset 系统提示词调整 | 版本 +1；黄金集全量；安全评审（防越权） |
| 新增工具/MCP | 版本 +1；`docs/14` MCP 白名单更新；安全测试 SEC-25~31 |
| 模型路由变更 | 单独变更单；压测 + 成本评估 |
| 权限预设变更 | `docs/14` 评审；越权回归 |

---

## 10. 失败降级路径

### 10.1 总原则

1. **读路径不依赖 Agent**：Host 挂了，商品、会话、审批、报表照常可看；
2. **写路径不依赖 Agent**：人工可以手写文案、手动回复、手动上架（走审批）；
3. **降级要可见**：页面明确告诉用户「现在用的是模板/关键词/稍后重试」，不静默；
4. **降级要可恢复**：Host 恢复后自动回切，不需要刷新或重启；
5. **降级有上限**：队列/重试有 TTL，不允许无限堆积。

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
| Host 进程挂 | `/ready` 失败 + 熔断打开 | 生成类按钮置灰；顶部横幅；读路径正常 | 「AI 能力暂不可用，可先用话术模板/人工处理」 | Host 起来后 15s 内自动恢复 |
| Host 重启中 | 连接拒绝 | 进行中的流显示「生成中断」+ 重试 | 「生成中断，可重试」 | 重试成功即恢复 |
| 首 token >8s | 超时计时器 | 自动切模板/备用模型；显示来源 | 「已使用话术模板（AI 响应超时）」 | 下次请求重新尝试主模型 |
| 模型供应商全挂 | 路由错误率 | 切备用；全挂则同 Host 挂 | 「模型服务异常，已切换备用/请稍后」 | 供应商恢复后回切 |
| 流中途断开 | SSE error/close | 保留已生成部分，标「未完成」；禁止直接采用 | 「内容未生成完整，请重试」 | 重试新 runId |
| 429 限流 | 平台/模型 | 排队提示 + 倒计时 | 「当前请求较多，约 N 秒后重试」 | 自动 |
| 配额用尽 | 计数 | 生成禁用；审批/发送不受影响 | 「今日额度已用完，请联系管理员」 | 次日 0 点 |
| 知识库不可用 | 检索失败 | 关键词检索 + 低置信标记 | 「知识库暂不可用，结果仅供参考」 | 恢复后自动 |
| 事实缺失 | 校验 422 | 跳转主数据补全 | 「缺少尺码表，请先补全」 | 补全后重试 |
| 判断层不可用 | L2 错误 | 全部升级人工（L3） | 「需人工复核」 | L2 恢复 |
| 数据库只读 | `/ready` 部分失败 | 全站写禁用，读可用 | 「系统维护中，暂不可提交」 | 恢复后解除 |
| 桥接令牌失效 | 401 | 同 Host 挂 | 同上 | api 重读令牌/重启 |

### 10.4 降级矩阵（能力 × 状态）

| 能力 | 正常 | Host 挂 | 模型挂 | 知识库挂 | DB 只读 |
|---|---|---|---|---|---|
| 商品浏览/编辑 | ✓ | ✓ | ✓ | ✓ | 只读 |
| 文案生成 | Agent | 模板/人工 | 备用模型→模板 | ✓（事实不依赖 KB） | ✗ |
| 客服草稿 | Agent（5s） | 模板话术 | 备用→模板 | 模板 + 人工 | ✗ |
| 客服发送 | 审批后发送 | ✓（不依赖 Agent） | ✓ | ✓ | ✗ |
| 审批 | ✓ | ✓ | ✓ | ✓ | ✗ |
| 平台发布 | 写入门 | ✓ | ✓ | ✓ | ✗ |
| 知识问答 | 混合检索 | 关键词 | ✓ | 关键词 + 低置信 | 只读 |
| L2 判断 | 模型 | 人工 L3 | 人工 L3 | 人工 L3 | 人工 L3 |
| 报表 | ✓ | ✓ | ✓ | ✓ | 只读 |

### 10.5 前端实现要求

- 统一 `AgentAvailability` 上下文：`available / degraded / unavailable`，由 api 的 `/ready` + 熔断状态驱动；
- 按钮禁用时必须有 `title` 说明原因，不能只是灰；
- SSE 断线重连：指数退避（1s/2s/4s/8s，上限 15s），最多 3 次；重连不重放已渲染内容；
- 「停止」按钮在请求发出后立即可用；停止后 2 秒内 UI 必须回到可操作状态；
- 所有降级事件上报指标 `agent_degraded_total{reason}`，用于验收「草稿降级率」。

### 10.6 降级演练（必须做）

| 演练 | 方法 | 通过标准 |
|---|---|---|
| Host 停机 | `docker compose stop dsh-host` | 页面 15s 内显示降级；读路径可用；恢复后自动回切 |
| 模型超时 | mock 延迟 10s | 5s 内切模板并标注来源 |
| 流中断 | 中途杀连接 | 显示「未完成」；不落草稿；可重试 |
| 并发打满 | 20 并发 | 第 9 个起 429；页面倒计时；无雪崩 |
| 取消 | 运行中点停止 | 5s 内释放槽位；审计有 `cancelled` |

---

## 11. 验收清单

| # | 项 | 通过标准 |
|---|---|---|
| 1 | 唯一入口 | 代码/网络中不存在浏览器直连 Host 或模型供应商 |
| 2 | 流式链路 | E2E：生成→delta→done；首 token P95 <3s |
| 3 | 取消 | 停止后 Host 侧 5s 内释放；审计有记录 |
| 4 | peer 授权 | 非白名单动作返回 `remote-access/denied`；owner 通道未被业务使用 |
| 5 | 并发上限 | 超限返回 429 + `Retry-After`；无排队雪崩 |
| 6 | 会话归属 | 两个用户同 SKU 会话不串；版本变化新建会话 |
| 7 | 幂等 | 同 key 不重复运行；完成可重放 |
| 8 | headless 边界 | 网页请求路径无 headless 调用 |
| 9 | 管理员界面 | 仅回环可访问；token 一次性；有审计 |
| 10 | 版本灰度 | 切换映射即生效；回滚 <1 分钟 |
| 11 | 降级 | 第 10.6 节五个演练全过 |
| 12 | 成本 | 每次运行有 token/成本记录，可按用户/用途归集 |

## 12. 与其他文档的接口

| 文档 | 本文提供 | 对方提供 |
|---|---|---|
| `docs/11` | Agent 产出如何进入草稿/判断/审批 | 状态机与写入门规则 |
| `docs/14` | 桥接鉴权、peer principal、preset 选择、MCP 白名单 | 角色矩阵、密钥、审计、沙箱档位 |
| `docs/15` | Agent 链路的测试点（流式/取消/降级/并发） | 测试分层与门禁 |
| `docs/16` | Host 部署、并发配置、降级开关、升级回归 | 环境、探针、SOP |
| `docs/18` | 客服 5 秒降级的实现约束 | 实时性与降级链细节 |
