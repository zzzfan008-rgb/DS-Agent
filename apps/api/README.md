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
| POST | `/api/sync/:platform` | operator | 同步（`{resource, since?, cursor?}`）；`orders` 真实落库 `orders`+`order_items`（`dry_run:false`），其余资源只推进游标（`dry_run:true`）；返回 202、`sync_id/cursor/pages/stats` |
| GET | `/api/sync/status` | viewer | `items[{platform,resource,status,last_success_at,cursor,lag_seconds,errors}]` + `stale` |
| POST | `/api/reconcile/:platform` | admin | 平台快照 vs 本地 listing/订单/售后 → 差异清单（商品 6 + 订单 5 + 售后 3 类）；`{day?, mode?:"recorded"\|"adapter"}` |
| GET | `/api/dashboard/daily` | viewer | `?date=YYYY-MM-DD&platform=pdd\|1688`：上架/驳回/审批积压/消息/媒体成本/差异数 + 告警 |

`POST /api/reconcile/:platform` 响应同时给两种视图（同源，不重复计算）：

- `items[{drift_key,kind,severity,subject_ref,suggested_action{level,kind},auto_fixable:false}]` —— docs/12 §3.11 契约视图；
- `diffs[...]` —— 完整差异（含 `local/platform_value/detail/suggestion.actions`），供人工核对与归档；
- `drift{inserted,updated,unchanged}` 是 `persisted` 的契约别名；
- `key_version` —— 当前 `drift_key` 规则版本；统计只取该版本的行（旧版本行保留不删、不参与统计）。

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
| `DAILY_SNAPSHOT_DIR` | `<repo>/artifacts/daily` | 日报快照目录 |
| `DAILY_ALERT_THRESHOLDS` | 未配置 | JSON，如 `{"drift_total":5,"drift_by_kind":{"price_mismatch":1},"approvals_pending":20}`；配置后 `value > threshold` 触发 |

### 真实接通的硬条件（未满足时不会"假装成功"）

1. **平台只读接口核验**：1688 需 `TODO-1688-001/002/003/004/009/012` 关闭（method/协议/签名/限流/类目字典/沙箱），PDD 需 `TODO-PDD-CONTRACT-VERIFY`；
2. 真实 reader 未核验时一律返回 **409 `publish_blocked`**，`detail.reason="adapter_contract_unverified"` + TODO 列表（不是空数据、不是 500）；
3. **`drift_log` 表**：t37 已建（迁移 `20261020250000_orders_drift_after_sale`），默认 `RECONCILE_STORE=postgres`；
   旧库缺表时 `auto` 落文件并返回 `store:"file"` + 原因，`postgres` 显式模式会带 DDL 硬失败（不静默降级）；
4. **`orders` / `order_items` / `after_sale` 表**：t37 已建；订单/售后维度差异已接入（`checked.orders/after_sale` 为真实计数）；
5. 真实对账需平台账号 + 测试店/沙箱 + IP 白名单（`docs/02 §1.1`），否则只跑 `recorded` 样本。
6. **生产禁止 `recorded`**：`NODE_ENV=production` 且 `mode=recorded` 时对账端点/每日脚本返回
   `422 validation_failed`（`reason=recorded_samples_forbidden_in_production`）——样本不完整会在生产造成全量误报。

### 不做的事

- **不自动修正**：差异只出清单与修复建议（`suggestion.auto_fixable=false`），写动作走写入门 + A/B/C 分级与审批；
- **不调用平台写接口**：对账/同步只读；
- **不删订单/售后**：`syncOrders` 只 upsert（`after_sale.order_id` 是 RESTRICT），订单/明细都不删除。
