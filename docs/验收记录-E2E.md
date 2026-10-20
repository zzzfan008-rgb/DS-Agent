# 验收记录 · 端到端全链路（t38）

| 项 | 内容 |
|---|---|
| 任务 | t38 · 商品 → 文案 → 判定 → 审批 → 上架 → 客服 → 媒体 → 知识库 |
| 执行 | qa |
| 日期 | 2026-10-20 |
| 依据 | `docs/00`、`docs/12`（v2 契约）、`docs/15`、`docs/08`、`docs/18`、`docs/19` |
| 结论 | **链路 PASS（12/12 步）**；发现 3 条跨模块缺口，其中媒体渲染 DB 约束为 blocker（见 §4） |
| 报告 | `artifacts/e2e/report.json`（`artifacts/` 被 gitignore，运行 `pnpm e2e` 可再生成） |

---

## 1. 运行方式与结果

### 1.1 命令

推荐复用本机既有 Postgres（独立库，跑完自动 DROP）：

```bash
DSSAAS_DB_REUSE=1 \
DSSAAS_PG_BASE_URL="$DSSAAS_PG_BASE_URL" \
pnpm e2e
```

干净机器（需要 docker，默认路径）：

```bash
pnpm e2e
```

> 本机 Windows 无 Docker CLI，本次使用 WSL 内 Postgres 的 reuse 模式；base 库只用于建库，脚本实际连接 `dssaas_test_<6hex>`。`pnpm e2e` 不进 `quality-gate`，何时跑见 `scripts/qa/README.md §7`。

### 1.2 本次结果

| 运行 | 结果 | 脚本内总耗时 | 说明 |
|---|---|---|---|
| 第 1 次 | 12/12 步通过 | 1.6s | 独立库 `dssaas_test_<6hex>`，跑完 DROP |
| 第 2 次（重复性） | 12/12 步通过 | 1.8s | 新独立库，无唯一键冲突 |
| 最终（健壮性小修后） | 12/12 步通过 | 1.6s | 报告为本次结果（`artifacts/e2e/report.json`） |

每次 `with-db` 会先 `migrate deploy`，因此两次都是从空 schema 开始，验证了脚本可重跑。

---

## 2. 分步结果

| # | 步骤 | 耗时 | 关键断言 |
|---|---|---|---|
| 01 | seed admin/operator + 登录 | 476ms | 两个角色会话 Cookie、CSRF 均成功 |
| 02 | 导入黄金集 `GOLD-SPU-001` | 117ms | 4 个尺码行全部导入；`platform_states.pdd/1688 = not_listed` |
| 03 | 文案草稿（标题 + 卖点） | 88ms | 均 201；`facts_hash` 为 64 hex；`model_call_id` 非空 |
| 03b | 预置退换政策 KB | 46ms | 政策入库 201；存在 operator 可读切片（作为 L2 证据来源，见 §3） |
| 04 | 判断 L1+L2 | 71ms | `verdict=needs_revision`；`rule_hits=["L1-TXT-002"]`；`evidence_refs=1`；未走 `NO_EVIDENCE` |
| 05 | 内容审批 `publish_content` → admin 批准 | 58ms | 201，定级 B；状态 `approved` |
| 06 | listing + 上架写入门 dry_run | 123ms | `result=success`；`platform_response.status=dry_run`；listing 仍 `draft`；`listing_write_log=1`；审计 `listing.write=1` |
| 07 | 模拟入站 + SSE | 56ms | `unread_count=1`（DB 同）；SSE 拉到 `message.created` |
| 08 | 回复草稿（5s / 降级） | 105ms | 无证据 `degraded=true, reason=no_evidence`（28ms）；有证据 `degraded=false`（38ms） |
| 09 | 发送审批 B → dry-run → 回放 | 89ms | `delivery_mode=dry_run`；`status=queued`（≠sent）；重复 `deduped=true` 且同 `message_id`；出站仅 1 条 |
| 10 | 媒体（mock provider） | 365ms | 图片任务 `succeeded`；`media_asset=pending_review`；`cost_ledger=4` 分；变体可读；尺码表 PNG 直接渲染落盘（DB 路径受限，见 §4） |
| 11 | 知识库检索 | 20ms | 命中政策文档；`evidence_refs` 非空且含 `doc_id/quote` |

脚本内总耗时 **1614ms**（约 1.6s）；含 `with-db` 建库/迁移/清理的外层墙钟约 7s。

关键证据（report 内）：

- 步骤 02 商品 ID 与双平台 `not_listed`；
- 步骤 04 `verdict=needs_revision`、`rule_hits=["L1-TXT-002"]`、`evidence_refs` 长度 1；
- 步骤 06 `write_id` / `snapshot_ref` / `compensating_ticket_id` / `workflow_run_id` 均存在；
- 步骤 10 图片变体与尺码表 PNG 落盘在 `artifacts/e2e/downloads/`（可人工打开核对）；
- 步骤 11 引用 `doc_id`、`quote`。

---

## 3. 判定步骤的说明（重要）

本次按任务要求跑 L1+L2，但存在一个跨模块事实：

1. **草稿绑定判断**（`subject_type=content_draft`）使用 `buildProductFacts` 生成的事实信封，其中没有 `source=kb` 的 `kb_document` 条目；
2. 判断层 `loadEvidence` 只从事实信封中引用的 KB 文档加载证据，因此草稿判断必然走 `NO_EVIDENCE`，verdict 为 `escalate`；
3. 为了验证“L1+L2 可达 pass/needs_revision”的通路，脚本第 04 步额外用 `subject_type=listing` + 显式 facts（产品事实 + 一条 KB 政策事实）构造判断请求，得到 `needs_revision`，并验证 `rule_hits`/`evidence_refs`；
4. 草稿判断的 `escalate` 记为预期失败 **F-E2E-01**，不修改判断层/内容服务。

这不是 E2E 脚本绕过业务规则，而是当前模块间的真实缺口；需要判断层证据组装任务（或 t35 后续）决定“草稿如何携带政策证据”。

另：步骤 03b 提前把政策入库，是为了让第 04 步的 L2 有合法证据；步骤 11 仍按任务要求验证“入库 → 检索命中 → 带引用”。报告按实际顺序记录（03b 在 04 前）。

---

## 4. 跨模块缺口（需 captain 分派，不在本任务修改）

| ID | 严重度 | 区域 | 现象 | 依赖/建议 |
|---|---|---|---|---|
| F-E2E-01 | medium | 内容草稿 → 判断 L2 | 草稿判断无法携带 `kb_document` 政策证据，L2 直接 `NO_EVIDENCE` → `escalate` | 判断层证据组装 / t35；让 `buildProductFacts` 带入政策，或允许草稿判断显式引用 KB |
| F-E2E-02 | **blocker** | `media_job.purpose` ↔ 媒体管线 | DB CHECK `ck_media_purpose` 只允许 `image|video`；M6 尺码表渲染使用 `purpose=render`，DB 路径无法创建渲染任务 | t12/t26：迁移放宽 CHECK（加 `render`），或管线把渲染映射为 `image + kind=size_chart`。当前 E2E 用图片任务验证 pending_review/cost_ledger，用直接渲染验证 PNG |
| F-E2E-03 | high | 媒体 HTTP API | `docs/12 §3.7` 的 `POST /media/generate`、`GET /media/jobs`、`GET /media/assets`、下载端点未实现；当前仅有 `POST /media/jobs/:id/cancel` | M6 API 补齐（t26 后续）；E2E 只能直接调用 worker `MediaPipeline` |

除以上 3 条外，本次链路上的字段名、状态机、错误码、审批动作未发现新的不一致：

- `publish_content` 定级 B，`publish`（listing.create）定级 B，均与契约一致；
- 上架 dry-run 不把 listing 改成 `published`，符合“dry-run 无平台副作用”；
- 发送 `delivery_mode=dry_run`、`status=queued`（不是 `sent`），重复提交按 outbound key 回放；
- `platform_states` 导入后为 `not_listed`；KB 检索引用结构符合预期。

### 预期失败清单（与报告一致）

- `content_draft` L2 证据缺口：expected `escalate`（`NO_EVIDENCE`）。
- 媒体 DB 渲染任务：`purpose=render` 被 CHECK 拒绝（blocker）。
- 媒体 HTTP API 不完整：仅 cancel。

---

## 5. 覆盖范围与限制

- **平台/模型零真实依赖**：上架与发送均 `dry_run`；模型用进程内 mock gateway（copy 返回中文文案、judge 返回带引用的 JSON、embed 返回确定性向量）；媒体用 `MockMediaProvider` + 本地 `FsStorage`；
- **无真实密钥**：未读取任何平台/模型凭据；DB 连接串来自 `with-db`；
- **SSE**：真实 HTTP `GET /api/events/stream`，通过 `last_event_id=0` 回放 `message.created`；
- **媒体**：DB 图片任务走 `PrismaMediaRepository` + `MediaPipeline`；尺码表 PNG 用 `renderSizeChart` 直接渲染并落盘；DB 渲染任务受 F-E2E-02 限制；
- **清理**：脚本不删数据；由 `with-db` 在成功时 DROP 独立库；失败时保留并打印连接串，便于排查；
- **失败可读性**：`scripts/e2e/full-chain.mjs` 对每个 HTTP 失败输出中文原因 + `request_id`，并写入 report 的 `error` 字段；成功时每步也记录 `request_ids`。

---

## 6. 交付物

| 文件 | 说明 |
|---|---|
| `scripts/e2e/full-chain.mjs` | 可重跑全链路脚本（本任务新增） |
| `package.json` | 新增 `pnpm e2e`（with-db 包装；默认不进 quality-gate） |
| `scripts/qa/README.md` | §7 说明何时跑 E2E、与质量门的关系 |
| `docs/验收记录-E2E.md` | 本文件 |
| `artifacts/e2e/report.json` | 机器可读报告（每次运行覆盖；artifacts 被 gitignore） |
