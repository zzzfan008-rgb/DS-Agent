# 0002 · 业务工作流自建 BullMQ + Postgres（而非使用 DSH 的 workflow）

| 项 | 内容 |
|---|---|
| 状态 | 已接受 |
| 日期 | 2026-10-20 |
| 决策类型 | 架构（核心运行时，替换成本高） |
| 关联 | `docs/00` §9.1 §9.2 §19.1；`docs/06` §3.5；`docs/11`；ADR-0005、ADR-0007 |

## 背景

1. **DSH `dsh-workflow` 的语义是 agent 扇出编排**：JS 脚本 + `agent()` / `parallel()` / `pipeline()`，**执行引擎由调用方提供**（`docs/00` 附录 A 已核实）。它没有持久化状态机、没有人工节点、没有幂等键、没有失败三分与死信重放、没有回滚/补偿语义。
2. **本方案要的东西它全都不提供**（`docs/00` §9.1）：`workflow_run` 状态机 + 业务 `stage`、每步 `idempotency_key`、`retryable/manual/permanent` 三类失败、断点续跑、`waiting_approval` 人工节点、死信重放、`stop_loss/rollback` 分支。
3. **状态必须落库**：审批可能挂 72 小时，Redis 不是事实源；重启、发版、Redis 故障都不能丢在途流程。
4. **队列能力必须开箱可用**：延时重试（1s/4s/16s/64s/256s）、限流、并发隔离（媒体任务不能饿死客服草稿）、死信、去重。这些是 BullMQ 的既有能力，自研等于重写。

## 决策

- **分两层，职责不混**：
  - **执行层** = Redis + BullMQ：只做「唤醒与节流」，job payload 只放 `{run_id, stage}` 指针，不放业务快照（避免 Redis 内存失控与状态双写）。
  - **事实层** = Postgres `workflow_run`：`state`（运行时）× `stage`（业务阶段）正交建模（`docs/06` §3.5）；每次状态转移是 `UPDATE ... WHERE state=$from` 的条件更新 + 同事务写 `audit_log`。
- **幂等**：`UNIQUE (org_id, type, idempotency_key)`；重复入队返回既有 run（HTTP 200 + `deduped=true`），不建第二个。
- **续跑**：worker 启动时执行 reconciler——扫 `state IN ('queued','running','retrying')` 且 `lock_until < now()` 的 run，按 `next_run_at` 重新入队（至少一次投递，业务侧幂等兜底）。
- **人工节点**：`running → waiting_approval` 时建 `approval` 行；审批通过由写入 `state` 的回调重新入队，不依赖「谁还记得」。
- **失败三分**：`retryable`（退避重试）→ `permanent`（`failed` + 工作台待办）→ 重试耗尽 `dead_letter`（可 `replay`）。`manual` 类同步开 `compensating_ticket`（`docs/00` §9.4）。
- **与 DSH 的分工**：DSH 只负责「单次有界任务内的多步工具调用」；任何跨请求、跨天、需要人工节点的流程都在本状态机里。两者交界只有一个点：`POST /agent/run`（ADR-0004）。

## 备选方案与放弃理由

| 方案 | 放弃理由 |
|---|---|
| 直接用 `dsh-workflow` | 无持久化状态、无人工节点、无幂等/死信/回滚；执行引擎还需自己提供——等于只借了 API 形状，没借到能力 |
| Temporal（自托管） | 能力过剩且运维成本高：额外集群 + 自身持久化层；本项目个位数并发的业务流程用不上工作流级版本化与活动重放；团队学习曲线与故障域都翻倍 |
| n8n / Dify 一类可视化编排 | 许可证含附加条款（`docs/00` 附录 A：NOASSERTION，n8n 为 Fair-code 非 OSI）；低代码产物难以做代码评审与静态漂移检查；审批与写入门需要硬编码的分级语义，塞不进节点面板 |
| Camunda / Zeebe (BPMN) | JVM 技术栈引入第二语言运行时（违反 ADR-0001 的单栈收益）；BPMN 建模成本高于本方案的状态机收益 |
| 纯 Postgres 轮询（无队列） | 无延时/退避/死信原语，需自建 `next_run_at` 轮询与锁，DB 空转压力大；且无法做队列级限流与并发隔离 |
| 用 `dsh-headless` 常驻当编排器 | headless 是**一次性任务模式**（跑完即退出，无 GUI、不常驻），语义上不可能承载在途流程 |

## 影响

| 面向 | 内容 |
|---|---|
| 正面 | 状态可审计、可重放、可人工介入；Redis 可丢（用 reconciler 从 PG 重建），故障域被限制在「延迟」而非「丢失」 |
| 正面 | 队列与状态机解耦后，换执行引擎不动业务语义（复审时只换 BullMQ） |
| 代价 | Redis 成为延迟敏感依赖：Redis 挂了 = 全站「慢」但不「错」，需在 `docs/18` 降级链里体现（草稿回落模板） |
| 代价 | 两个真相源（Redis 有在途 job、PG 有 run）必须靠 reconciler 收敛；写错 reconciler 会双跑 → 必须配合幂等键 |
| 缓解 | `lock_until` 用 Redis 租约 + DB 双写（`docs/06` §3.5）；job 只放指针；reconciler 单实例（Redis 锁）运行；死信与 `dead_letter` 数进看板 |
| 观测 | 指标：队列深度、最老 job 年龄、`retrying` 比例、`dead_letter` 数、reconciler 修复数 |

## 复审触发条件

- 并发在途 run 持续 > 500 或需要跨机 Redis 高可用/分片，BullMQ 的运维模型成为瓶颈。
- 出现「跨系统恰好一次」的强制要求（如平台侧不提供幂等而我们必须端到端一次），需要事务性消息或分布式事务能力。
- 人工节点平均等待 > 7 天且占比升高，状态机与审批表的耦合开始拖慢迭代（考虑独立审批服务）。
- 团队引入 Temporal/Camunda 的既有运维能力，且迁移可在一个迭代内完成并有等价回归用例。
- DSH 若发布带持久化状态与人工节点的流程引擎（需重新核实其语义，不得按名称假设）。
