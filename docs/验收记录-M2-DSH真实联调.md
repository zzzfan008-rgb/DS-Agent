# 验收记录 · M2 真实 DSH Host 联调（t18）

| 项 | 内容 |
|---|---|
| 任务 | t18 · 真实 DSH Host 联调（替换协议桩验证） |
| 日期 | 2026-10-20 |
| 依据 | `docs/17` §2.2/§3.3/§3.4/§6.5/§11、`docs/12` §7/§8、`docs/14` §4.3、`docs/21` §13、`docs/16` §7.3 |
| 环境 | Windows + DSH Desktop 安装 `E:\DSH\DSH Desktop\resources\app`，内核 **0.2.1-rc.2**；模型 **deepseek-flash**（本机 DSH 账号凭据只读引用） |
| 结论 | **PASS（真实 Host 联调）**：插件被真实 Host 加载；真实模型跑出 `meta→step→tool_call→tool_result→step→delta*→usage→final`；取消 44ms 终态、Host active_runs 16ms 归零；缺失/错误/轮换后旧令牌均 401。发现 **F1：真实首 token 10.0s，>`AGENT_FIRST_TOKEN_TIMEOUT_MS` 默认 8s**，需队长决策（见 §8）。 |
| 证据 | `apps/api/test/agent-real-host-{stream,cancel,auth}.log`、`dsh-bundle/.dev-home/logs/*.log`（本机，已 gitignore）、本文档 |

> 本任务**没有伪造**：所有事件、token、耗时、401 都是真实 Host/真实模型产生；一次流式运行约消耗
> 实际账号额度（输入 ~691 tokens / 输出 ~1689 tokens）。协议桩（t3）保留为无凭据的 CI 回归工具。

---

## 1. 联调架构（全部文件在工作区）

```text
E:\DSH\...\resources\app（DSH 安装，只读，不改任何文件）
        │ node ...\@deepseek-ai\dsh\lib\bin.js --profile dssaas-host --patch dsh-bundle/config/dev-host.patch.yml
        ▼
dsh-bundle/.dev-home/                         # 独立 DSH_HOME（gitignore）
├─ profiles/dssaas-host/                       # 从 shipped web 模板生成
├─ secrets/bridge-token                        # 32B Base64URL，0600 意图
└─ logs/host-*.log                             # Host stdout/stderr

dsh-bundle/bridge/
├─ business-agent.mjs                          # 真实 Remote service businessAgent/run
├─ business-bridge.mjs                         # /internal/agent/run + /internal/health
└─ node_modules -> E:\DSH\...\node_modules     # junction（import 同一份 @deepseek-ai 包）

dsh-bundle/config/dev-host.patch.yml           # credentials 路径 / 权限 / preset / 两个插件行
dsh-bundle/presets/clothing-ops/1.0.0/         # persona + skills（真实 Host 使用）
dsh-bundle/skills/*/<version>/SKILL.md         # 4 个 skill 逐个挂载
```

关键设计：
- **不改 DSH 安装目录**：profile/令牌/日志都在工作区；插件通过 `file:///D:/DSSAAS/dsh-bundle/bridge/*.mjs` 挂载。
- **凭据不复制**：`dev-host.patch.yml` 把 `credentials.path` 指向本机 `~/.dsh/.credentials.yaml`
  （`!!js process.env.DSSAAS_DEV_CREDENTIALS_PATH ?? USERPROFILE/...`）；令牌刷新由 DSH 账号插件处理。
- **非 owner Peer**：桥接插件 `createPeer({ principal:{kind:'business-api',role:'agent-runner'}, interactions:'none' })`，
  `remoteAccess` policy 只放行 `businessAgent/run`；每请求 dispose（docs/21 §13）。
- **真实 agent loop**：`businessAgent` 使用 Host 的 `sessionController.create/prompt/cancel`，
  监听 `agent/assistant-stream` 与 `session/event`，把真实 turn/step/tool/文本映射为 `AgentEvent`。

---

## 2. 可复现运行方式

### 2.1 启动（一键脚本）

```powershell
pwsh -File scripts/dev/start-dsh-host.ps1
```

真实输出：

```text
==> 启动真实 DSH Host（profile=dssaas-host version=0.2.1-rc.2 port=43181）
    DSH_HOME=D:\DSSAAS\dsh-bundle\.dev-home
    credentials=C:\Users\zzzfa\.dsh\.credentials.yaml（只读引用）
    log=D:\DSSAAS\dsh-bundle\.dev-home\logs\host-20261020-155600.log
==> 等待 /internal/health（≤90s）

Host 就绪：http://127.0.0.1:43181
  桥接令牌文件：D:\DSSAAS\dsh-bundle\.dev-home\secrets\bridge-token（Bearer）
  健康检查：GET /internal/health
{
  "status": "ok",
  "version": "0.2.1-rc.2",
  "preset": "clothing-ops",
  "manifest_hash": "2d4b3547274c2dd3be0de17474eb75763ae1d323a823ad51698bd9e29d2265b1",
  "mcp_tools": 0,
  "uptime_s": 1,
  "active_runs": 0,
  "active_run_ids": [],
  "bridge": {
    "principal": "business-api",
    "role": "agent-runner",
    "auth_failure_status": 401
  }
}
```

`mcp_tools=0` 是真实值：M1 的两个只读 MCP server 仍是占位（`dsh-bundle/config/mcp-servers.yaml`），
未在本任务启用；skill 通过 `tool-skill` 正常可用（见 §3 的 tool_call）。

### 2.2 停止

```powershell
pwsh -File scripts/dev/stop-dsh-host.ps1
# ==> 停止 Host pid=22692
# 端口 43181 已释放。
# health after stop: unreachable (expected)
```

`stop` 只停进程；profile/会话/令牌/日志保留以便下次复用。`-Purge` 才会删除 `.dev-home`。

### 2.3 手工等价命令（脚本内部执行的就是这些）

```powershell
$env:DSH_HOME='D:\DSSAAS\dsh-bundle\.dev-home'
$env:DSH_VERSION='0.2.1-rc.2'
$env:DSSAAS_DEV_CREDENTIALS_PATH='C:\Users\<user>\.dsh\.credentials.yaml'
node "E:\DSH\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  --profile dssaas-host --patch D:\DSSAAS\dsh-bundle\config\dev-host.patch.yml `
  --host 127.0.0.1 --port 43181 --no-open
```

---

## 3. 真实流式运行（api → 真实 Host → 真实模型）

命令：

```powershell
$env:SMOKE_MODE='stream'
$env:SMOKE_RUN_TIMEOUT_MS='180000'
$env:AGENT_FIRST_TOKEN_TIMEOUT_MS='60000'   # 见 §8 F1；默认为 8000
$env:AGENT_RUN_TIMEOUT_MS='200000'
$env:DSH_BRIDGE_URL='http://127.0.0.1:43181'
$env:DSH_BRIDGE_TOKEN_FILE='D:\DSSAAS\dsh-bundle\.dev-home\secrets\bridge-token'
pnpm --filter @dssaas/api smoke:agent
```

真实结果（`apps/api/test/agent-real-host-stream.log`）：

| 项 | 值 |
|---|---|
| create | `202`，`run_id=01a1584f-a9cc-…` |
| 终态 | `succeeded` |
| 事件计数 | `hello×1, run.started×1, run.step×4, run.tool_call×2, run.tool_result×2, run.delta×530, run.finished×1` |
| tokens | `in=691, out=1689`（Host 真实上报） |
| cost_cents | `5`（按 `priceInCentsPer1k=1`、`priceOutCentsPer1k=2` **估算**，见 §8） |
| 运行时长 | `13.041s`（`run.finished.duration_ms`） |
| 首 delta | `run.started` 后 **10.033s**（模型先做了 2 次 skill 工具调用） |
| steps | `(101, agent.1.1, done)`、`(102, agent.1.2, done)` |
| model / bundle | `deepseek-flash` / `1.0.0` |
| 输出 | 908~1700 字中文标题/文案，含 markdown 结构（真实模型结果） |

真实事件序列（前 10 条 + 末 4 条，均为 api 公开事件）：

```text
hello              seq 0   07:56:18.280
run.started        seq 1   07:56:18.330   model_id=deepseek-flash, bundle_version=1.0.0
run.step           seq 2   07:56:18.408   seq=101 agent.1.1 running
run.tool_call      seq 3   07:56:21.101   tool=skill, args_summary={"name":"brand-tone"}
run.tool_result    seq 4   07:56:21.119   ok=true, summary=<brand-tone SKILL.md 片段>
run.tool_call      seq 5   07:56:21.119   tool=skill
run.tool_result    seq 6   07:56:21.130   ok=true
run.step           seq 7   07:56:21.131   seq=101 done
run.step           seq 8   07:56:21.145   seq=102 running
run.delta          seq 9   07:56:28.363   首个 token
…                  …      …
run.step           seq 539 07:56:30.950   seq=102 done
run.finished       seq 540 07:56:31.324   tokens 691/1689, cost_cents=5, duration_ms=13041
```

`run.finished.payload.output.text` 示例（截断）：

```text
**结论：给你三组可直接使用的标题（均 60 字以内，搜索词覆盖一致）**
> 2026秋季女士中长款风衣 收腰显瘦 防风防泼水 小个子通勤外套
…（省略，完整文本见日志）
```

---

## 4. 取消联调（api cancel → Host signal → agent 停止）

```powershell
$env:SMOKE_MODE='cancel'; $env:SMOKE_RUN_TIMEOUT_MS='180000'
$env:AGENT_FIRST_TOKEN_TIMEOUT_MS='60000'
… pnpm --filter @dssaas/api smoke:agent
```

真实结果（`apps/api/test/agent-real-host-cancel.log`）：

| 项 | 值 |
|---|---|
| 触发时机 | 收到首个 `run.delta` 后立即 `POST /api/agent/runs/:id/cancel` |
| cancel 响应 | `200` `{status:"cancelled", partial_output_ref:"mem://…/partial.txt"}` |
| 终态延迟 | **44ms**（从 cancel 请求到 `GET /run` 看到 `cancelled`） |
| SSE 结束 | `run.finished`，`output.partial=true`（最后事件） |
| Host 侧残留 | `active_runs=0`，从 cancel 到归零 **16ms** |
| 结论 | ≤2s 目标达成；无残留运行；已产生 token 照记（partial output 可读） |

---

## 5. 鉴权矩阵（直连真实 Host 桥接端点）

```powershell
$env:SMOKE_MODE='auth'; $env:DSH_BRIDGE_URL='http://127.0.0.1:43181'
$env:DSH_BRIDGE_TOKEN_FILE='…\secrets\bridge-token'
… pnpm --filter @dssaas/api smoke:agent
```

真实结果（`apps/api/test/agent-real-host-auth.log`）：

| 场景 | HTTP | 说明 |
|---|---|---|
| 正确令牌 | **200** | 返回真实 health |
| 缺失令牌 | **401** | `unauthorized` |
| 错误令牌 | **401** | 常量时间比较，不区分长度 |
| 令牌轮换后旧令牌 | **401** | 令牌文件按 mtime 热读；Host 无需重启 |
| 令牌轮换后新令牌 | **200** | 轮换立即生效 |

> 与 docs/14 §4.3「路径/方法/令牌任一失败返回 404」的差异：t18 要求鉴权失败 401，dev patch 用
> `authFailureStatus: 401`；生产可改为 404（插件配置项），api 侧 401/403/404 都映射为
> `dsh_unavailable`，**无需改代码**。

---

## 6. 真实 Host vs 协议桩 对照表

| 维度 | 协议桩（t3，无凭据 CI） | 真实 Host（t18） | 是否需改 api |
|---|---|---|---|
| 事件名 | `hello/run.started/run.step/run.tool_call/run.tool_result/run.delta/run.finished` | 同名；另有 `usage`（api 折叠进 finished） | 否 |
| `meta` 字段 | `runId/sessionId/bundleVersion/modelId` | 同名字段；`sessionId` 为真实 session id（`session-…`） | 否（api 只读 modelId/sessionId） |
| `step.seq` | 1（running/done 同 seq） | 101/102（`turn*100+step`，running/done 同 seq） | 否（api 按 seq 合并任意整数） |
| `step.name` | `kb.search` | `agent.<turn>.<step>`（真实 step 无名字，由 bridge 生成） | 否（展示层差异；前端可显示 name+summary） |
| 工具事件 | 1 组（`kb.search`） | 2 组（`skill` × 2），`args_summary` 为 JSON 字符串 | 否（api 原样透传） |
| 增量数量 | 4 | 530（逐 token/片段） | 否（SSE 背压/缓冲已按 1000 条设计） |
| `usage` | `cost_cents=2`（假值） | 真实 token（691/1689），cost 按价格表估算（5 分） | 否，但 cost 语义见 F2 |
| `final.duration_ms` | 420（固定） | 13041（真实） | 否 |
| 结束语义 | `final` 唯一终态 | `final` 唯一终态；断流时 bridge 补 `error{dsh_unavailable}` | 否 |
| 取消 | 桩端不感知；api 本地完成 | Host 真实 abort：44ms 终态、16ms 释放 | 否 |
| 鉴权失败 | 404 → api `dsh_unavailable` | 401 → api `dsh_unavailable` | 否（401/403/404 统一映射） |
| 首 token | ~15ms | **10.0s**（skill 工具调用后再生成） | **需决策：默认 8s 会超时（F1）** |
| 会话 | 每次新会话 | 每次新 Host session（未做 api sessionKey 映射） | 后续 M3（Redis 映射） |
| manifest 对账 | 桩固定 hash | 真实 `manifest_match=true` | 否 |

**api 侧代码改动：0 处**。事件名、字段名、顺序、终态语义均兼容；t3 的协议桩与真实 Host 行为一致。
需要处理的是**配置/策略**（F1）与 **M3 会话映射/成本计价**（F2/F3）。

---

## 7. 联调中发现并修复的真实差异（实现层）

这三个问题只在真实 Host 上暴露，协议桩无法发现，已全部修复并复跑通过：

| # | 现象（报错原文/行为） | 根因 | 修复 |
|---|---|---|---|
| 1 | `business-bridge (…): Error: cannot get property "remoteAccess" without inject` | 模块同时 `export default` 与 named exports 时，Loader 取 `default`（函数）而丢失 `inject` | 改为 `export function apply` + named `inject/name`，不用 default |
| 2 | `Cannot read properties of undefined (reading 'includes')`（502） | `remoteAccess` 的 binding.role 需要 `{name,resource,actions}`，原写成字符串 | role 改为 `{name:'agent-runner', resource:'global', actions:['businessAgent/run']}` |
| 3 | `persona (@deepseek-ai/dsh-persona): invalid config: $.prefix missing required value` | DSH 0.2.1-rc.2 的 persona 配置键是 `prefix`，不是 `text`（旧文档/示例是 text） | dev patch 与 `dsh-bundle/presets/clothing-ops/1.0.0/agent.cordis.yml` 均改为 `prefix` |

另外修正了 bridge 自身的两个问题（真实运行才可见）：
- `run.finished.duration_ms` 原为 epoch 毫秒（`Date.now()-0`），改为从 run 开始计时；
- 同一 step 的 running/done 原使用自增事件序号，改为稳定 `turn*100+step`，api 才能合并步骤。

---

## 8. 已知限制与需队长决策

**F1（需决策）首 token 10.0s > 默认 8s。**
真实 Host 在生成第一个 token 前先执行了 2 次 `skill` 工具调用（brand-tone 等），
`run.started → 首 delta` = **10.033s**；`AGENT_FIRST_TOKEN_TIMEOUT_MS` 默认 8000，按默认配置
本次 run 会被 api 判 `timeout`。本次 smoke 显式设为 60000 才通过。
选项（需队长定）：
1. 调高默认（如 15000–20000ms），与 docs/17 §6.5 的 8s 冲突，需同步改文档；
2. 优化 preset：把 skill 内容以前置上下文注入，避免首 token 前的 2 次工具往返（docs/17 §5.4 的
   「skill 片段」本来就是拼进上下文，不是工具调用）——推荐；
3. 路由层用更快的模型/预热；客服 5s 场景不能靠这个（docs/18）。
本任务**未擅自改默认值**（属于 SLA/产品决策），只记录并给出建议。

**F2 成本为估算值（真实 token，非真实计价）。**
Host 上报真实 token；`costCents` 由 bridge 按 `1 分/1k input、2 分/1k output` 估算（可配）。
真实计价应由 M2/t7 的 `model_call_log` + `cost_ledger` 完成；本任务不写业务账。

**F3 会话未复用。**
每个 api run 在 Host 新建 session（真实 session id 见事件 meta）；api 的 `sessionKey` 尚未传给 Host。
M3 按 docs/17 §5 建 Redis 映射后，同一用户/对象/版本的连续对话可复用上下文。

**F4 凭据共享。**
dev Host 只读引用本机 `~/.dsh/.credentials.yaml`（本机已登录的 DSH 账号）。令牌刷新可能由 DSH
账号插件写回该文件（正常行为）；生产 Host 必须使用自己的 `$DSH_HOME/.credentials.yaml` 或 Vault
（docs/14 §5），且不应与桌面端共用同一 home。**没有把任何密钥写进工作区文件。**

**F5 鉴权状态码与 docs 的差异。**
dev 按 t18 要求 401；生产按 docs/14 §4.3 建议 `authFailureStatus: 404`。两种 api 都兼容。

**F6 真实 Host 的其它未覆盖项。**
- `need_input`（业务 preset 无提问工具；澄清交互 M5）；
- MCP 工具（`mcp_tools=0`，两个 server 仍占位）；
- 多轮上下文、preset 灰度、manifest 不匹配告警；
- Host 重启中的 run（api 会 `dsh_unavailable`，需 M3 演练）；
- 真实账号额度/限流（本任务只跑了 3 次真实 run）。

**F7 运行成本提示。**
每次真实流式 run 消耗实际账号额度（本例约 691 in / 1689 out tokens）；CI 默认使用协议桩，
不要把真实 Host 测试接进无凭据的流水线。

---

## 9. 复现与清理

```powershell
# 1) 启动（生成/复用 profile、令牌、junction）
pwsh -File scripts/dev/start-dsh-host.ps1

# 2) 三种联调
$env:DSH_BRIDGE_URL='http://127.0.0.1:43181'
$env:DSH_BRIDGE_TOKEN_FILE='D:\DSSAAS\dsh-bundle\.dev-home\secrets\bridge-token'
$env:AGENT_FIRST_TOKEN_TIMEOUT_MS='60000'
$env:SMOKE_MODE='auth';   pnpm --filter @dssaas/api smoke:agent   # 200/401 矩阵
$env:SMOKE_MODE='stream'; pnpm --filter @dssaas/api smoke:agent   # 真实流式
$env:SMOKE_MODE='cancel'; pnpm --filter @dssaas/api smoke:agent   # 取消 ≤2s

# 3) 停止（保留 profile；-Purge 删除 .dev-home）
pwsh -File scripts/dev/stop-dsh-host.ps1
```

清理：`stop-dsh-host.ps1 -Purge` 删除 `.dev-home`（profile/会话/令牌/日志）；删除
`dsh-bundle/bridge/node_modules` junction 即可移除对安装目录的引用。两者都在 `.gitignore` 中，
不会进仓库。

---

## 10. 与 M1/t3 验收记录的关系

- `docs/验收记录-M1-Agent.md` §8 D1 的「真实 Host 未联调」限制由本文件关闭；协议桩保留为
  **CI/无凭据回归**，真实 Host 作为 **dev 联调与 M3 前置**。
- t3 的 api 侧驱动 19/19 用例、并发/超时/降级逻辑未改动；本任务只新增 dev Host 资产、
  smoke 模式与文档。
- M3 仍需完成：会话映射（F3）、真实计价（F2）、skill 前置注入（F1 方案 2）、生产镜像与
  `/ready` 聚合、MCP 启用与工具守卫。

---

## 11. 证据文件索引

| 文件 | 内容 |
|---|---|
| `scripts/dev/start-dsh-host.ps1` / `stop-dsh-host.ps1` | 一键启动/停止真实 Host（幂等、健康等待、pid 管理） |
| `dsh-bundle/config/dev-host.patch.yml` | credentials 路径、权限、clothing-ops preset、两个插件行 |
| `dsh-bundle/bridge/business-agent.mjs` | 真实 Remote service：sessionController 驱动 + 事件映射 |
| `dsh-bundle/bridge/business-bridge.mjs` | 真实桥接路由：401 鉴权、来源校验、peer/policy/gateway、active_runs |
| `apps/api/test/agent-smoke.ts` | 4 种模式：stream / cancel / auth / host-down |
| `apps/api/test/agent-real-host-stream.log` | 真实流式完整 JSON（事件、tokens、cost、duration、first-delta） |
| `apps/api/test/agent-real-host-cancel.log` | 取消延迟、Host active_runs、partial 输出 |
| `apps/api/test/agent-real-host-auth.log` | 鉴权矩阵（200/401/401/401/200） |
| `dsh-bundle/.dev-home/logs/host-*.log` | 真实 Host 启动/插件日志（本机，gitignored） |
