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
| POST | `/api/sync/:platform` | operator | 只读同步骨架（`{resource, since?, cursor?}`）；返回 202、`sync_id/cursor/pages/stats` |
| GET | `/api/sync/status` | viewer | `items[{platform,resource,status,last_success_at,cursor,lag_seconds,errors}]` + `stale` |
| POST | `/api/reconcile/:platform` | admin | 平台快照 vs 本地 listing → 差异清单；`{day?, mode?:"recorded"\|"adapter"}` |
| GET | `/api/dashboard/daily` | viewer | `?date=YYYY-MM-DD&platform=pdd\|1688`：上架/驳回/审批积压/消息/媒体成本/差异数 + 告警 |

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
| `RECONCILE_STORE` | `auto` | `auto` = 有 `drift_log` 用 PG，否则文件；`file`/`postgres` 显式选择 |
| `RECONCILE_DIR` | `<repo>/artifacts/reconcile` | 文件存储目录（`<day>/<platform>.json`） |
| `RECONCILE_READER` | `recorded` | 平台快照来源：录制样本 / 真实 adapter |
| `SYNC_READER` | `recorded` | 同步 reader 来源 |
| `SYNC_STALE_SECONDS` | `3600` | `/sync/status` 的 stale 提示阈值（非告警阈值） |
| `DAILY_SNAPSHOT_DIR` | `<repo>/artifacts/daily` | 日报快照目录 |
| `DAILY_ALERT_THRESHOLDS` | 未配置 | JSON，如 `{"drift_total":5,"drift_by_kind":{"price_mismatch":1},"approvals_pending":20}`；配置后 `value > threshold` 触发 |

### 真实接通的硬条件（未满足时不会"假装成功"）

1. **平台只读接口核验**：1688 需 `TODO-1688-001/002/003/004/009/012` 关闭（method/协议/签名/限流/类目字典/沙箱），PDD 需 `TODO-PDD-CONTRACT-VERIFY`；
2. 真实 reader 未核验时一律返回 **409 `publish_blocked`**，`detail.reason="adapter_contract_unverified"` + TODO 列表（不是空数据、不是 500）；
3. **`drift_log` 表**：由 t37 补建；在此之前 `RECONCILE_STORE=auto` 落文件并返回 `store:"file"` + 原因；
4. **`orders` / `order_items` / `after_sale` 表**：由 t37 补建；在此之前对账响应显式
   `checked.orders={checked:false,reason:"local order table missing"}`、`checked.after_sale` 同理；
5. 真实对账需平台账号 + 测试店/沙箱 + IP 白名单（`docs/02 §1.1`），否则只跑 `recorded` 样本。
6. **生产禁止 `recorded`**：`NODE_ENV=production` 且 `mode=recorded` 时对账端点/每日脚本返回
   `422 validation_failed`（`reason=recorded_samples_forbidden_in_production`）——样本不完整会在生产造成全量误报。

### 不做的事

- **不自动修正**：差异只出清单与修复建议（`suggestion.auto_fixable=false`），写动作走写入门 + A/B/C 分级与审批；
- **不调用平台写接口**：对账/同步只读；
- **不写业务数据**：同步骨架只推进 `sync_cursor`（订单/售后表就绪后再接写入）。
