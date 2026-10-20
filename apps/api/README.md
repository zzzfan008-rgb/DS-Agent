# @dssaas/api

Fastify 业务 API：身份 / 审计 / 商品 / 内容 / 判断 / 审批 / 上架写入门 / 客服 / 媒体 / 知识库 / Agent / **对账与日报（M8）**。

完整验收与差异样例见 [`docs/验收记录-M8-对账日报.md`](../../docs/验收记录-M8-对账日报.md)。

## 运行

```bash
pnpm --filter @dssaas/api dev          # 开发
pnpm --filter @dssaas/api test         # 全量测试（需要 TEST_DATABASE_URL；推荐 pnpm test:api）
pnpm --filter @dssaas/api typecheck
```

## M8 对账与日报

### 端点

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| POST | `/api/sync/:platform` | operator | 同步（`{resource, since?, cursor?}`）；`orders` 落 `orders`+`order_items`、`after_sale` 落 `after_sale`（均 `dry_run:false`），`products/messages/stock` 只推进游标（`dry_run:true`）；返回 202、`sync_id/cursor/pages/stats` |
| GET | `/api/sync/status` | viewer | `items[{platform,resource,status,last_success_at,cursor,lag_seconds,errors}]` + `stale` |
| POST | `/api/reconcile/:platform` | admin | 平台快照 vs 本地 listing/订单/售后 → 差异清单（商品 6 + 订单 5 + 售后 3 类）；`{day?, mode?:"recorded"\|"adapter"}` |
| GET | `/api/dashboard/daily` | viewer | `?date=YYYY-MM-DD&platform=pdd\|1688`：上架/驳回/审批积压/消息/媒体成本/差异数 + 告警 + `critical_thresholds` |

`POST /api/reconcile/:platform` 响应同时给两种视图（同源，不重复计算）：

- `items[{drift_key,kind,severity,subject_ref,suggested_action{level,kind},auto_fixable:false}]` —— docs/12 §3.11 契约视图；
- `diffs[...]` —— 完整差异（含 `local/platform_value/detail/suggestion.actions`），供人工核对与归档；
- `drift{inserted,updated,unchanged}` 是 `persisted` 的契约别名；
- `key_version` —— 当前 `drift_key` 规则版本；统计只取该版本的行（旧版本行保留不删、不参与统计）。

`POST /api/sync/:platform` 的 `stats` 里，`pending` / `pending_reasons` 表示"拿到但暂时写不进去"的条数：
`after_sale` 在本地缺对应订单时无法落库（`order_id` NOT NULL + FK RESTRICT），计入 `{order_missing:N}` 而非丢弃，
对账的 `after_sale_platform_only` 会继续把它报出来。

**pending 会被自动救回（t50）**：`orders` 同步写入新订单后，服务会自动重放 `after_sale` 的 pending 关联
（不推进 after_sale 游标），响应里给出 `after_sale_retry{created,updated,skipped,pending,degraded}`。
pending 清单**不持久化** —— 它的唯一事实源是平台侧数据，持久化就是第二份真相。

### 每日任务

```bash
pnpm --filter @dssaas/api daily:report -- --date=2026-10-20
# 产物：artifacts/daily/<day>.json；告警写 event_log(topic=reconcile.alert)
```

建议 cron（Asia/Shanghai）：

```cron
30 9 * * *  cd /opt/dssaas && pnpm --filter @dssaas/api daily:report >> /var/log/dssaas/daily.log 2>&1
```

### 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `RECONCILE_STORE` | `postgres` | `postgres` = 落 `drift_log`（t37 已建表）；`auto` = 探测有表则 PG、否则文件；`file` 仅本地/测试 |
| `RECONCILE_DIR` | `<repo>/artifacts/reconcile` | 文件存储目录（`<day>/<platform>.json`） |
| `RECONCILE_READER` | `recorded` | 平台快照来源：录制样本 / 真实 adapter |
| `SYNC_READER` | `recorded` | 同步 reader 来源 |
| `SYNC_STALE_SECONDS` | `3600` | `/sync/status` 的 stale 提示阈值（非告警阈值） |
| `AFTER_SALE_RETRY_MAX_ITEMS` | `5000` | orders 同步后重放 pending 售后的单次上限；超限降级为只处理前 N 条并打 WARNING |
| `DAILY_SNAPSHOT_DIR` | `<repo>/artifacts/daily` | 日报快照目录 |
| `DAILY_ALERT_THRESHOLDS` | 未配置 | JSON；`value > threshold` 触发，`0` = 出现即告警。`drift_by_kind` 的 key 必须是已知差异类型（拼错会启动失败）。**`after_sale_platform_only` 必须配 `0`** —— 见下方告警建议 |

### 告警配置建议（`after_sale_platform_only` 必须配）

```bash
DAILY_ALERT_THRESHOLDS='{
  "drift_by_kind": {
    "after_sale_platform_only": 0,
    "price_mismatch": 1,
    "state_mismatch": 1,
    "order_amount_mismatch": 1
  },
  "drift_total": 50,
  "approvals_pending": 20
}'
```

`after_sale_platform_only` = **平台有退款、本地零记录**，意味着同步失败或有人绕过系统退款。
不配这条，风险敞口没有任何人看着 —— 日报仍会打 WARNING 点名，但只有配了才会真正写 `event_log` 告警。
规则 `value > threshold`，所以阈值 `0` = 出现即告警。

### 真实接通的硬条件（未满足时不会"假装成功"）

1. **平台只读接口核验**：1688 需 `TODO-1688-001/002/003/004/009/012` 关闭（method/协议/签名/限流/类目字典/沙箱），PDD 需 `TODO-PDD-CONTRACT-VERIFY`；
2. 真实 reader 未核验时一律返回 **409 `publish_blocked`**，`detail.reason="adapter_contract_unverified"` + TODO 列表（不是空数据、不是 500）；
3. **`drift_log` 表**：t37 已建（迁移 `20261020250000_orders_drift_after_sale`），默认 `RECONCILE_STORE=postgres`；
   旧库缺表时 `auto` 落文件并返回 `store:"file"` + 原因，`postgres` 显式模式会带 DDL 硬失败（不静默降级）；
4. **`orders` / `order_items` / `after_sale` 表**：t37 已建；订单/售后维度差异已接入（`checked.orders/after_sale` 为真实计数）；
   `syncOrders` / `syncAfterSale` 均真实落库。**`after_sale.order_id` 是 NOT NULL + FK RESTRICT**：
   本地缺订单的售后写不进去 → 走 `stats.pending`（`order_missing`），不丢、仍由对账报出；
5. 真实对账需平台账号 + 测试店/沙箱 + IP 白名单（`docs/02 §1.1`），否则只跑 `recorded` 样本。
6. **生产禁止 `recorded`**：`NODE_ENV=production` 且 `mode=recorded` 时对账端点/每日脚本返回
   `422 validation_failed`（`reason=recorded_samples_forbidden_in_production`）——样本不完整会在生产造成全量误报。

### 不做的事

- **不自动修正**：差异只出清单与修复建议（`suggestion.auto_fixable=false`），写动作走写入门 + A/B/C 分级与审批；
- **不调用平台写接口**：对账/同步只读；
- **不删订单/售后**：`syncOrders` / `syncAfterSale` 只 upsert（`after_sale.order_id` 是 RESTRICT），订单/明细/售后都不删除；
- **不伪造订单**：缺订单的售后不会先造一笔假订单来"接住"，只记 `pending`。
