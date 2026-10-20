# 验收记录 · M1 前端骨架（t6）

| 项 | 内容 |
|---|---|
| 任务 | t6 前端骨架：登录、布局、审批只读页 |
| 执行人 | frontend（attempt 2，attempt_id `4ea58405-86cd-4959-87ac-445771707ca0`） |
| 日期 | 2026-10-20 |
| 设计输入 | `docs/13-前端信息架构.md`、`docs/13a-视觉稿-骨架.md`（队长已确认）、`docs/12` v2、`docs/21` |
| 结论 | **M1 验收项全部通过**：本地起服可登录、12 页可达、权限可见性生效、审批中心只读列表与详情可浏览、四态组件与 SSE 占位落地 |
| 证据 | 本文件命令输出 + `docs/assets/M1-web/m1-*.png` 截图 |

---

## 0. 结论先行

1. `pnpm typecheck` 全仓 12 个包通过；`pnpm --filter @dssaas/web build` 通过；`pnpm lint` 0 违规。
2. 通过 web 同源代理真实登录（admin / viewer 两个账号），12 个业务页面全部 200。
3. 审批中心：真实 API 优先；**仅 404** 回退内置演示数据并显示 `DEMO`；**500 实测走错误态、绝不回退 DEMO**（截图 + DOM 文本双证据）。
4. 权限可见性只读 `GET /me.permissions[]`：viewer 访问 `/ops?tab=audit` 与 `/models?view=backend` 均为无权限态、不泄露数据；admin 专属 tab 不渲染给 viewer。
5. 审批只读：A/B 决策按钮为 `disabled` + "决策将在 M4 接入"；C 级不渲染任何决策按钮，只留不可逆声明；**未发送任何 decision 写请求**。
6. 风险编码为"颜色 + 图标 + 文字"三重（A=↺ / B=⚠ / C=⛔），符合队长硬要求。

---

## 1. 交付物

### 1.1 代码与页面

| 类别 | 内容 |
|---|---|
| 页面 | `/login`、`/`、`/products`、`/products/[id]`、`/copy`、`/media`、`/service`、`/inquiry`、`/approvals`、`/approvals/[id]`、`/platforms`、`/models`、`/kb`、`/ops`（12 页 + 2 个详情路由） |
| 壳层 | 深色侧栏 `#0F172A`、选中态 `#1E293B`、工作区 `#F8FAFC`、品牌蓝 `#2563EB`；4 组导航；顶栏（标题/搜索占位/实时灯/角色徽标/用户菜单） |
| 权限 | `GET /me.permissions[]` 驱动导航过滤 + 页面级 `guardPage()` + 无权限态；**不按角色名硬编码** |
| 审批中心 | 队列 + 详情（≥1024 并排；窄屏独立详情页）；级别徽标、SLA 倒计时、影响面、diff、事实来源、风险提示、双人信息、审计关联、历史、只读决策条 |
| 四态 | `EmptyState` / `Skeleton` / `ErrorState` / `ForbiddenState` + `AsyncSection` |
| SSE | `useRealtimeStream` 状态机（disabled/connecting/connected/reconnecting/degraded）+ 顶栏灯；M1 默认关闭，不假装连通 |
| 快捷键 | `?` 面板、审批列表 `j/k/Enter`；可关闭并持久化 `localStorage`；输入框/IME 内不触发 |
| 验收工具 | `scripts/dev/approvals-stub-proxy.mjs`（仅验收用：模拟审批端点 404/500，透传登录与 `/me`） |

### 1.2 关键文件

```text
apps/web/next.config.ts                     # /api rewrite、allowedDevOrigins、安全响应头
apps/web/src/proxy.ts                       # 匿名跳登录 + return_url（Next 16 proxy 约定）
apps/web/src/lib/{api,auth,contracts,nav,permissions,format,realtime,shortcuts,approval-view,approvals-client}.ts
apps/web/src/lib/demo/approvals.ts          # 8 条演示审批（6 pending / 1 approved / 1 rejected）
apps/web/src/components/shell/*             # AppShell / SidebarNav / TopBar / UserMenu / RealtimeLamp / MobileNav / ShortcutsDialog
apps/web/src/components/states/*            # 四态组件
apps/web/src/components/approvals/*         # 队列、详情、diff、事实 chips、决策条、DEMO 横幅
apps/web/src/components/login/*             # 登录页
apps/web/src/app/(app)/*                    # 12 页骨架
docs/13a-视觉稿-骨架.md                     # v1.0 已确认
docs/assets/M1-web/m1-*.png                 # 本次验收截图（不覆盖 wf-01/02/03）
scripts/dev/approvals-stub-proxy.mjs        # 404/500 分支验收工具
```

---

## 2. 验收环境

| 项 | 值 |
|---|---|
| OS / Node / pnpm | Windows；Node `v24.18.0`；pnpm `11.19.0` |
| Next / React | Next `16.4.2`（Turbopack）；React `19.3.1` |
| 数据库 | WSL Docker `pgvector/pgvector:pg16`（容器 `dssaas-api-test-pg`，`172.23.33.92:55434`），**独立库 `dssaas_web`** |
| API | `pnpm --filter @dssaas/api start`（非 watch，避免其他 agent 并发改文件导致进程重启、内存会话丢失）；`http://127.0.0.1:3101` |
| 验收 stub | `http://127.0.0.1:3102`，`APPROVALS_MODE=404`（正常验收）/ `500`（负向验收），其余请求透传 3101 |
| Web | `next dev -p 3100`，`API_INTERNAL_URL=http://127.0.0.1:3102` |
| 账号 | `web.admin@test.local`（admin）、`web.viewer@test.local`（viewer，只读），仅存在于本地 `dssaas_web` 演示库 |
| 视口 | 浏览器实际窗口 1384×797（截图同尺寸） |

> 隔离库与独立端口是为了不干扰其他任务正在使用的 `dssaas_test` 与 `:3001`；API 使用 `start` 而非 `tsx watch`，避免并发编辑触发内存会话失效。

### 2.1 数据库与账号准备

```bash
# 1) 独立库（WSL Docker 内）
docker exec dssaas-api-test-pg psql -U dssaas -d postgres -c "CREATE DATABASE dssaas_web;"

# 2) 迁移
export DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@172.23.33.92:55434/dssaas_web?schema=public'
pnpm db:deploy
# → All migrations have been successfully applied.

# 3) 种子 admin
SEED_ADMIN_EMAIL='web.admin@test.local' SEED_ADMIN_PASSWORD='WebAdminPassword!2026' \
  SEED_ADMIN_NAME='演示管理员' pnpm --filter @dssaas/api seed
# → {"ok":true,"created":true,"user_id":"01a1583f-32ed-7a93-899b-04214e9c626f","role":"admin",...}
```

viewer 账号由同一 Argon2id 哈希 + `viewer` membership 写入 `dssaas_web`（仅演示库；不写入业务代码、不新增迁移）。

### 2.2 启动命令

```bash
# API
export DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@172.23.33.92:55434/dssaas_web?schema=public'
export API_PORT=3101 API_HOST=127.0.0.1 NODE_ENV=development
pnpm --filter @dssaas/api start

# 审批端点 404/500 分支的验收 stub（另一个终端）
UPSTREAM_PORT=3101 PROXY_PORT=3102 APPROVALS_MODE=404 node scripts/dev/approvals-stub-proxy.mjs

# Web
API_INTERNAL_URL='http://127.0.0.1:3102' NEXT_PUBLIC_SSE_ENABLED=false \
  pnpm --filter @dssaas/web exec next dev -p 3100
```

---

## 3. 验收结果

### A. 构建与静态门禁

```text
$ pnpm --filter @dssaas/web typecheck
$ tsc -p tsconfig.json
EXIT 0

$ pnpm typecheck
✔ @dssaas/api  typecheck
✔ @dssaas/web  typecheck
...（共 12 个包）
[workspace-task] 全部 12 个包通过。
EXIT 0

$ pnpm --filter @dssaas/web build
▲ Next.js 16.4.2 (Turbopack)
✓ Compiled successfully in 5.6s
Route (app)
┌ ƒ /
├ ○ /_not-found
├ ƒ /approvals
├ ƒ /approvals/[id]
├ ƒ /copy
├ ƒ /inquiry
├ ƒ /kb
├ ƒ /login
├ ƒ /media
├ ƒ /models
├ ƒ /ops
├ ƒ /platforms
├ ƒ /products
├ ƒ /products/[id]
└ ƒ /service
EXIT 0

$ pnpm lint
QA 静态门禁 · docs/21 §11.3 + docs/15 §10
扫描范围：contracts 425 文件 · business 227 文件 · sql 12 文件 · package.json 11 个
✔ 通过：0 处违规
EXIT 0
```

### B. 登录（真实 API，同源 rewrite）

```text
$ curl -s -o /dev/null -w 'GET / -> %{http_code} redirect=%{redirect_url}\n' http://localhost:3100/
GET / -> 307 redirect=http://localhost:3100/login

$ curl -s -o /dev/null -w 'GET /login -> %{http_code}\n' http://localhost:3100/login
GET /login -> 200

$ curl -D - -c dssaas-web-cj.txt -X POST http://localhost:3100/api/auth/login \
    -H 'content-type: application/json' \
    --data '{"email":"web.admin@test.local","password":"WebAdminPassword!2026"}'
HTTP/1.1 200 OK
x-request-id: req_01M5C4ZFZ1KN2E6341Q3T73T0F
x-contract-version: 2
set-cookie: dssaas_sid=…; Max-Age=43199; Path=/; HttpOnly; SameSite=Lax
set-cookie: dssaas_csrf=…; Max-Age=43199; Path=/; SameSite=Lax

$ curl -b dssaas-web-cj.txt http://localhost:3100/api/me
{"request_id":"…","data":{"id":"01a1583f-…","name":"演示管理员","role":"admin",
 "permissions":["product.read",…,"approval.read",…,"audit.read","model.write",…]}}

$ POST /api/auth/login（不存在的账号） -> 401
{"error":{"code":"unauthorized","message":"邮箱或口令错误","retryable":false,"next_action":"login"}}
```

截图：[m1-login.png](assets/M1-web/m1-login.png)（登录页：品牌叙事 + 登录卡 + 系统健康状态）。

### C. 12 页面路由（带 admin 会话）

```text
/                                        200
/products                                200
/products/demo-spu                       200
/copy                                    200
/media                                   200
/service                                 200
/inquiry                                 200
/approvals                               200
/approvals/demo-c-main-image             200
/platforms                               200
/models                                  200
/models?view=backend                     200
/kb                                      200
/ops?tab=dashboard                       200
/ops?tab=audit                           200
/ops?tab=settings                        200
```

`/approvals` SSR 输出抽样（壳层已渲染，数据为客户端加载）：

```text
$ curl -s -b dssaas-web-cj.txt http://localhost:3100/approvals | grep -o '审批中心\|M1 只读\|审批队列' | sort | uniq -c
      2 M1 只读
      7 审批中心
      3 审批队列
```

截图：[m1-dashboard.png](assets/M1-web/m1-dashboard.png)（首页：4 张待办卡显示 “—” + 数据源未接入说明，不是 0）。

### D. 审批中心仅 404 回退 DEMO

验收 stub 对 `GET /api/approvals*` 返回 404，登录与 `/me` 透传真实 API：

```text
$ curl -s -o /dev/null -w 'GET /api/approvals -> %{http_code}\n' -b dssaas-web-cj.txt \
    http://localhost:3100/api/approvals
GET /api/approvals -> 404
{"request_id":"req_stub_approvals","error":{"code":"not_found","message":"审批端点尚未实现（stub 模拟 404）","retryable":false,"next_action":"none"}}
```

页面表现（浏览器快照与截图）：

- 顶部黄色 `DEMO` 横幅 + 每行 `DEMO` 角标；
- 6 条待处理、1 条已批准、1 条已驳回（共 8 条演示数据）；
- 级别徽标：`⛔ C · 不可逆` / `⚠ B · 不可撤回` / `↺ A · 可逆`；
- SLA 倒计时与“已超时”红色标记；C 级行左 4px 红条；
- 详情：影响面、平台现值 vs 变更、事实来源（可展开）、风险提示、双人信息、审计关联、历史、只读决策条。

截图：[m1-approvals-list.png](assets/M1-web/m1-approvals-list.png)、[m1-approval-detail-c.png](assets/M1-web/m1-approval-detail-c.png)。

### E. 非 404 不回退（500 实测）

stub 切 `APPROVALS_MODE=500`，同一页面刷新：

```text
页面 DOM：
审批队列加载失败
审批端点故障（stub 模拟 500）
code: upstream_5xx    request_id: req_stub_approvals
[重试] [复制错误信息]
→ 页面上没有 DEMO 横幅，也没有任何演示数据。
```

截图：[m1-approvals-error-500.png](assets/M1-web/m1-approvals-error-500.png)（统计区同步显示 “—”，不显示 0）。

> 结论：`loadApprovals()` 只在 `response.status === 404` 时返回 `demo`；网络错误、401/403、5xx 均抛 `ApiFailure`，由 `ErrorState` 呈现。此条已按队长要求单独验证并记录。

### F. 权限可见性（只读 `/me.permissions[]`）

viewer（`web.viewer@test.local`）实测：

```text
$ curl -s -b viewer-cj.txt http://localhost:3100/ops?tab=audit | grep -o '无权访问该 tab\|审计权限（audit.read）'
无权访问该 tab
审计权限（audit.read）
$ curl -s -b viewer-cj.txt http://localhost:3100/models?view=backend | grep -o '无权访问或不存在\|模型写（model.write）'
无权访问或不存在
模型写（model.write）
```

- `/ops` 的 tab：viewer 只渲染“看板”；审计/设置 tab 不渲染（`permissions[]` 无 `audit.read` / `users.write`）。
- `/models` 后台 tab：viewer/operator 不渲染；直入 `?view=backend` 显示无权限态。
- 导航由 `permissions[]` 过滤，未按角色名硬编码；越权直达统一“无权访问或不存在”，不泄露对象存在性。

截图：[m1-forbidden-audit.png](assets/M1-web/m1-forbidden-audit.png)。

### G. 审批只读（无写请求）

浏览器 DOM 实测（选中 B 级项）：
```text
[{"t":"批准并执行","disabled":true,"title":"决策将在 M4 接入"},
 {"t":"修改后批准","disabled":true,"title":"决策将在 M4 接入"},
 {"t":"驳回","disabled":true,"title":"决策将在 M4 接入"}]
```
- C 级详情不渲染任何决策按钮，仅显示：
  `C 级不可逆：M1 只读。M4 执行需滚动阅读 → 勾选知晓 → 一次性 confirm-token → 双人确认。`
- 审批中心代码中没有任何 `POST /approvals/:id/decide`、`batch-decide` 或 `delegate` 调用；网络面板中审批相关请求只有 `GET /api/approvals` 与 `GET /api/approvals/:id`。

截图：[m1-approvals-readonly-ab.png](assets/M1-web/m1-approvals-readonly-ab.png)。

### H. 快捷键 `?` / `j` / `k` / `Enter` 与可关闭偏好

- 按 `?` 打开面板（截图：[m1-shortcuts.png](assets/M1-web/m1-shortcuts.png)），面板含开关与“后续里程碑”标注；
- 审批列表 `j/k` 切换选中项、`Enter` 打开详情；输入框内与 IME 组合输入期间不触发；
- 关闭开关后：`localStorage['dssaas.shortcuts.enabled'] === 'off'`，再按 `j` 选中项不变化（实测 `before === after`）；
- 关闭后仍可从顶栏键盘按钮打开面板重新开启。

### I. SSE 占位

- 顶栏连接灯显示“实时未接入”（灰点），`title` 说明“M1 占位：SSE 开关关闭；M4 接审批、M5 接客服”；
- `NEXT_PUBLIC_SSE_ENABLED=false`（默认）时不发起 `/api/events/stream` 请求，不假装连通；
- `useRealtimeStream` 已实现连接/退避（1s/2s/4s/8s/15s）/连续 3 次失败降级状态机；M1 不消费业务事件。

### J. 四态组件

| 组件 | 使用位置 | 实测 |
|---|---|---|
| `EmptyState` | 首页告警/动态/不可逆、审批队列空/筛选空、占位页 | ✅ |
| `Skeleton` | 审批队列/详情加载 | ✅ |
| `ErrorState` | 审批 500、详情失败、壳层 `/me` 失败 | ✅（含 code/request_id/重试/复制） |
| `ForbiddenState` | `/ops?tab=audit`、`/models?view=backend`、页面级权限 | ✅ |
| `AsyncSection` | 审批详情区块四态编排 | ✅ |

---

## 4. 与 docs/13 §10 验收清单的 M1 对照

| docs/13 # | 判据 | M1 状态 | 证据 |
|---|---|---|---|
| 1 | 12 页面可达、路由与分组一致 | ✅ | §3.C 路由 200 |
| 2 | 每页每个区块四态 | ✅（骨架） | §3.J；真实数据随里程碑补齐 |
| 3 | 无权限入口不渲染；403 直达不泄露 | ✅ | §3.F |
| 4 | C 级红/图标/文字三重编码 | ✅ | 截图 m1-approvals-list / detail-c |
| 5 | C 级“滚动→勾选→token→执行” | ⏳ M4（M1 无执行能力，C 级不渲染按钮） | §3.G |
| 6–10 | 客服秒级/5s 降级/断线/键盘/IME | ⏳ M5；M1 仅 `?` + `j/k/Enter` | §3.H |
| 11 | 模型后台仅 admin；前台只出 visible | ✅ tab 权限门控；数据过滤待 M2 | §3.F |
| 12 | 5 断点布局 | ✅ CSS 按 docs/13 §8.1 实现；移动端底部 tab + 抽屉 | 代码走查；视觉回归 M9 全量 |
| 13 | 页面 × 端点 86/86 | ⏳ 随端点实现逐页接入；M1 只接认证与审批读 | §1 |
| 14 | LCP / JS 预算 | ⏳ M9 门禁；M1 记录基线 | — |
| 15 | 失败 toast 含 request_id 与 next_action | ✅ 错误态组件按此实现 | §3.E |

---

## 5. 偏差、限制与待办

| # | 项 | 说明 / 后续 |
|---|---|---|
| W1 | 审批 API 缺口 | 验收时 `GET /api/approvals` 尚未实现；用 stub 代理模拟 **404** 与 **500** 两条路径。真实端点接入后前端无需改动：404 分支自然消失，其余错误仍走错误态。 |
| W2 | 演示数据 | 8 条内置样本，id 均以 `demo-` 开头，页面顶部与每行标 `DEMO`；不参与任何写操作。 |
| W3 | `diff[]` 形状 | `docs/12` 只给字段名；M1 用视图模型 `{field,label,before,after,risk}`，文件注明 M4 服务端形状固化后只换适配层。 |
| W4 | 截图为 1384×797 | 浏览器窗口实际尺寸；不代表 1440×900 规范视口，视觉回归在 M9 用固定视口重跑。 |
| W5 | 登录表单 | 表单使用 React `onSubmit` + `method="post"`，并移除 `name` 属性，避免 JS 未加载时原生 GET 把口令带进 URL。 |
| W6 | Next dev 配置 | 开发期需 `allowedDevOrigins` 才能通过 127.0.0.1/localhost 加载 HMR；`devIndicators: false` 仅用于截图不遮挡侧栏 footer。 |
| W7 | 尺码表口径 | 商品详情 M1 为占位、未展示尺码表；M3 实现时按版本分组（一个商品同时只有一个生效版本，版本内可多码多行，t17 EXCLUDE 约束），不假设"一行尺码"。 |
| W8 | SSE | M1 不消费业务事件、不轮询不存在的端点；M4 接审批、M5 接客服。 |
| W9 | 无新增依赖 | 未引入 UI 库 / Tailwind / 图表库；图标为内置 SVG，样式为 CSS Modules。 |
| W10 | 环境并发 | 其他 agent 同期编辑 `apps/api` 会导致 `tsx watch` 重启、内存会话失效；本次验收改用 `start` + 独立库/端口，并记录该环境事实。 |

---

## 6. 复现步骤

```bash
# 1) 独立库 + 迁移 + 账号（见 §2.1）
# 2) API（3101）
DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@172.23.33.92:55434/dssaas_web?schema=public' \
API_PORT=3101 API_HOST=127.0.0.1 NODE_ENV=development \
pnpm --filter @dssaas/api start

# 3) 验收 stub（3102；404 → DEMO；500 → 错误态）
UPSTREAM_PORT=3101 PROXY_PORT=3102 APPROVALS_MODE=404 \
  node scripts/dev/approvals-stub-proxy.mjs

# 4) Web（3100）
API_INTERNAL_URL='http://127.0.0.1:3102' NEXT_PUBLIC_SSE_ENABLED=false \
  pnpm --filter @dssaas/web exec next dev -p 3100

# 5) 打开 http://localhost:3100/login
#    账号：web.admin@test.local / WebAdminPassword!2026
#    只读：web.viewer@test.local / WebAdminPassword!2026

# 6) 门禁
pnpm --filter @dssaas/web typecheck
pnpm typecheck
pnpm --filter @dssaas/web build
pnpm lint
```

---

## 7. 变更文件（本次任务）

```text
apps/web/next.config.ts
apps/web/next-env.d.ts
apps/web/package.json
apps/web/tsconfig.json
apps/web/src/proxy.ts
apps/web/src/app/globals.css
apps/web/src/app/layout.tsx
apps/web/src/app/not-found.tsx
apps/web/src/app/login/page.tsx
apps/web/src/app/(app)/layout.tsx
apps/web/src/app/(app)/error.tsx
apps/web/src/app/(app)/page.tsx
apps/web/src/app/(app)/dashboard.module.css
apps/web/src/app/(app)/{products,products/[id],copy,media,service,inquiry,platforms,models,kb,ops}/page.tsx
apps/web/src/lib/{api,auth,contracts,format,nav,permissions,realtime,shortcuts,approval-view,approvals-client,use-media-query,page-guard}.*
apps/web/src/lib/demo/approvals.ts
apps/web/src/components/{shell,states,approvals,login,common}/*
scripts/dev/approvals-stub-proxy.mjs
docs/13a-视觉稿-骨架.md          # 确认状态 + 队长决定
docs/验收记录-M1-Web.md          # 本文件
docs/assets/M1-web/m1-*.png      # 8 张验收截图（不覆盖 wf-*）
```

---

## 8. 截图索引

| 文件 | 内容 |
|---|---|
| [m1-login.png](assets/M1-web/m1-login.png) | 登录页（健康检查正常） |
| [m1-dashboard.png](assets/M1-web/m1-dashboard.png) | 首页（4 待办卡 + 三块正向空态 + 快捷入口） |
| [m1-approvals-list.png](assets/M1-web/m1-approvals-list.png) | 审批中心：队列 + 详情并排、DEMO 横幅、A/B/C 徽标、SLA |
| [m1-approval-detail-c.png](assets/M1-web/m1-approval-detail-c.png) | C 级详情：不可逆红条、影响面、diff、事实来源 |
| [m1-approvals-readonly-ab.png](assets/M1-web/m1-approvals-readonly-ab.png) | A/B 只读：三个 disabled 决策按钮 + 原因 |
| [m1-approvals-error-500.png](assets/M1-web/m1-approvals-error-500.png) | 500 错误态：code/request_id/重试，无 DEMO、统计显示 “—” |
| [m1-forbidden-audit.png](assets/M1-web/m1-forbidden-audit.png) | viewer 直达 `/ops?tab=audit` 的无权限态 |
| [m1-shortcuts.png](assets/M1-web/m1-shortcuts.png) | `?` 快捷键面板 + 可关闭开关 |

---

*本记录中的命令输出均为本次会话真实输出；截图由内置浏览器在 `http://localhost:3100` 实际渲染后截取。*
