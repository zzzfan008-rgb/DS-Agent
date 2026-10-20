# 0001 · 后端主线选择 TypeScript 与 Fastify

| 项 | 内容 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-20 |
| 决策类型 | 技术选型（架构主线，迁移成本高） |
| 关联 | `docs/00` §三 §四 §五；ADR-0002、ADR-0004、ADR-0007 |

## 背景

1. **DSH 的扩展面全部是 TypeScript**：MCP client、skill 发现、agent preset、Cordis bundle、`@Remote({mode:'stream'})` 的 Typert RPC、`dsh-permission-presets` 的工具策略——只有 TS 实现与类型，Python 侧没有对等物。
2. **schema 只能有一份真相**：模型供应商协议、工具调用参数、判断层固定 JSON Schema（`verdict/severity/reason/evidence_refs/repair_hint`）、`model.params_schema`。两套语言 = 两份 schema = 必然漂移，而漂移点恰好落在「模型输出解析」与「平台写入门」这两个零容忍环节。
3. **实时链路有硬预算**：`docs/18` §0.2 要求回调 P99 ≤ 300ms、草稿 100% ≤ 5s。链路是 webhook → 事务落库 → SSE → 队列 → agent。单进程内共享类型与校验器、少一次序列化，就直接换成延迟余量。
4. **团队与运维规模**：单机房、内部系统、人力有限。一个语言栈、一个镜像、一套 CI，比「按任务挑语言」的实际总成本低。
5. **Python 的真实优势域存在但很窄**：报表统计、图像批处理（OpenCV/Pandas）。这些是离线、可异步、不参与写入门的工作。

## 决策

- `apps/api`、`apps/worker` 一律 **TypeScript（Node 22 LTS）**；HTTP 框架用 **Fastify 5**（`@fastify/*` 官方插件，`fastify-type-provider-typebox`）。
- Schema 单一来源：**TypeBox 定义 → 生成 OpenAPI（`docs/12`）→ 生成 TS 类型**；禁止手写第二份 DTO。Fastify 校验失败统一映射为 `docs/00` §14.1 的错误码。
- `packages/core`（领域规则）、`packages/db`（Prisma + raw SQL 迁移）、`packages/adapters-*`（平台适配）、写入门、模型网关、`packages/knowledge` 全部 TS。
- `apps/web` Next.js 只调 `/api`；不直连模型、不直连平台（ADR-0004）。
- Python **仅允许**存在于 `apps/analytics`（可选 FastAPI）与 `scripts/analytics/*`：只读 Postgres 只读副本或导出文件、只产出报表/图像文件，**不写业务表、不进写入门、不被 api 同步调用**。越界即视为架构违规（评审阻断项）。

## 备选方案与放弃理由

| 方案 | 放弃理由 |
|---|---|
| 全 Python（FastAPI + Celery） | DSH 扩展面 TS-only，必须再写一层 TS 桥；MCP/preset/RPC 无 Python 对等物，等于自建两套内核；桥成为唯一写路径的瓶颈与故障点 |
| Python 主 + TS 只做 DSH 桥 | 模型网关、判断层 schema、成本记账各维护两份；桥的进程边界让 `AbortSignal` 取消与流式透传变复杂，直接顶到 5s 预算 |
| NestJS 取代 Fastify | 装饰器/DI 带来隐式启动行为与冷启动开销；约定优于显式在「毫秒级预算 + 审计必须可追」的场景里是负担；其底层仍是 Express 语义 |
| Bun / Deno 运行时 | 原生模块（`sharp`、`ffmpeg` 绑定、`pg`）与镜像生态不足；DSH 预发布期要求 Node 兼容，双运行时风险不可控 |
| Go/Rust 核心 + TS 边缘 | 没有可独占的收益（本项目不是高并发网关）；人力与包生态不匹配，等于为性能假设付双倍维护费 |

## 影响

| 面向 | 内容 |
|---|---|
| 正面 | 一份 schema 贯穿 api/web/worker；与 DSH 同语言，preset/MCP/skill 直接复用；单镜像多进程（`api`/`worker` 同镜像不同 CMD），发布原子 |
| 代价 | CPU 密集任务（图像变体、视频抽帧）受 Node 单线程限制；Fastify 生态小于 Express，个别中间件需自写；团队成员若偏 Python，前期效率略低 |
| 代价 | 数值计算与统计生态弱，报表需走 `apps/analytics` 或 SQL 聚合 |
| 缓解 | `worker` 按队列分池（`media:*` 独立进程池）；CPU 密集走 `sharp`/`ffmpeg` 子进程 + 并发上限；限流与 P95/P99 指标进 CI 压测门（`docs/15`）；报表优先用 SQL 窗口函数，避免过早引入 Python |
| 迁移成本 | 已接受为「高」：若复审触发，替换 Fastify 是局部的，替换语言是全量的——所以本 ADR 的复审条件写得比其它 ADR 更严 |

## 复审触发条件

- 出现 **≥2 个**只能通过 Python SDK 接入、且无 HTTP 契约的必需接口（平台或供应商）。
- 草稿链路连续 2 周出现 5s 违约（`draft.timeout_violation > 0`）且归因为运行时/序列化，而非模型时延。
- DSH 转向 Python 扩展面，或放弃 Cordis TS 扩展模型。
- 团队主力语言结构变化（≥50% 后端人力以 Python 为主），且招聘/维护成本连续两个季度上升。
- Node 22 到达 EOL 且升级路径受阻（此时先评估运行时，不动语言）。
