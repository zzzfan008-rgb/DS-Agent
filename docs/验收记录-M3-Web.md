# M3 Web 验收记录（商品库 / 文案工作台 / 模型与供应商）

| 项目 | 内容 |
|---|---|
| 任务 | t25 · M3 前端：商品库 + 文案工作台 + 模型管理 |
| 里程碑 | M3（商品、文案、模型） |
| 验收日期 | 2026-10-20 |
| 结论 | **通过（PASS）**；3 个页面、新建/导入/生成/判定/审批/模型配置主流程均以真实 API 跑通。2 个后端缺陷登记为 G22/G23，1 个契约缺口 G21 按设计降级，均不阻塞本任务验收 |
| 代码范围 | `apps/web/src/**`；未修改 `apps/api/**`、`prisma/**` |
| 截图目录 | `docs/assets/M2-web/`，文件名 `m3-*` |

---

## 1. 交付内容

### 1.1 路由（12 页面骨架中的 5 条业务路由）

| 路由 | 页面 | 权限（读） | 写操作 |
|---|---|---|---|
| `/products` | 商品库列表（搜索/类目/状态/游标分页/平台态/缺失字段） | `product.read` | 无（按钮按 `product.write` / `product.import` 显示） |
| `/products/[id]` | 商品详情（概览与 SKU、尺码表按版本、成分、平台属性、素材摘要） | `product.read` | 无（只读；文案入口按 `content.read`） |
| `/products/new` | 新建商品（基本信息、SKU、面料、尺码表） | `product.write` | `POST /api/products` |
| `/products/import` | CSV 导入（模板下载、dry-run、失败行、确认写入） | `product.import` | `POST /api/products/import` |
| `/copy` | 文案工作台（生成、编辑、L1/L2、证据抽屉、审批、历史草稿） | `content.read` | `POST /content/drafts`、`POST /judgments`、`POST /approvals` |
| `/models` | 模型与供应商（前台只读 / 后台 Provider、Model、Route、用量） | 登录即可；后台视图需 `model.write` | Provider/Model/Route 新建、测试、发布、停用、编辑 Route |

> M1 的其余 7 个占位页未改动；全局壳层只把“M1 骨架”字样更新为当前产品名，避免 M3 页面挂 M1 标签。

### 1.2 关键实现文件

| 文件 | 作用 |
|---|---|
| `apps/web/src/lib/m3-types.ts` | M3 API 类型（商品/尺码表/成分/属性/草稿/判定/审批/Provider/Model/Route/Usage） |
| `apps/web/src/lib/m3-api.ts` | 同源 `/api` 读写：CSRF、Idempotency-Key、If-Match、信封解析、401 跳登录 |
| `apps/web/src/lib/products-client.ts` | 商品列表/详情/创建/CSV 导入 |
| `apps/web/src/lib/content-client.ts` | 草稿生成/列表/详情、判定、内容审批 |
| `apps/web/src/lib/models-client.ts` | Provider/Model/Route/Usage 读写 |
| `apps/web/src/lib/garment-ui.ts` | 15 色系示意色、20 纤维词表、色卡/尺码归一、0.5 步进与 12 测量列 |
| `apps/web/src/lib/m3-format.ts` | 价格（分/元）、判定/等级/能力/用途/平台态/缺失字段标签 |
| `apps/web/src/components/m3/M3Ui.tsx` + `m3.module.css` | Chip / SectionCard / PendingAggregate / Field / Drawer / InlineAlert / ValidationList / Spinner / Segmented |
| `apps/web/src/components/products/*` | 列表、详情、新建、导入四个视图与样式 |
| `apps/web/src/components/copy/*` | 文案工作台与样式 |
| `apps/web/src/components/models/*` | ModelsView、ProviderPanel、ModelPanel、RoutePanel、UsagePanel、model-ui |
| `apps/web/src/app/(app)/{products,copy,models}/**` | 服务端页面壳、`guardPage` 权限、`metadata` |

---

## 2. 验收环境与数据

### 2.1 环境

```text
Windows 11 · Node v24.18.0 · pnpm 11.19.0
PostgreSQL：WSL Docker dssaas-api-test-pg · 172.23.33.92:55434/dssaas_web
API：http://127.0.0.1:3101（tsx src/index.ts）
Web：http://localhost:3100（next dev）
模型桩：https://127.0.0.1:8443（scripts/dev/mock-model-server.mjs，自签证书，仅验收用）
```

- 数据库已应用全部迁移：`pnpm db:deploy` → “All migrations have been successfully applied”。
- API 启动参数：`DSSAAS_MODEL_CREDENTIALS='{"mock_cred":"sk-mock"}'`、`NODE_TLS_REJECT_UNAUTHORIZED=0`（仅本地自签桩）。
- 账号：`web.admin@test.local`（admin）、`web.viewer@test.local`（viewer），密码均为 M1 演示库口令。
- 没有改后端代码；所有写入都走真实 API 与真实数据库。

### 2.2 数据（真实写入，非 mock 数据）

| 对象 | ID / 值 | 来源 |
|---|---|---|
| Provider `mock_text` | `01a15866-4d4c-7b22-9065-df4e41753aa8` | API 种子（真实 `POST /providers`），测试连通 ok |
| Model `Mock Chat` | `01a15866-69ad-7d22-89a1-5740f4344229` | API 种子，测试通过后发布 |
| Route copy | org / copy / priority 100 / active | API 种子 |
| Route judge | org / judge / priority 100 / active | API 种子 |
| SPU-2026-001 `双面穿风衣` | `01a15867-542d-7472-ba5e-22447fcd4933` | API 种子；3 SKU / 2 色；尺码表 v1、v2；2 条成分；PDD/1688 属性映射 |
| SPU-2026-002 `重磅纯棉短袖` | `01a15867-5458-7731-9bf8-ac95f292c475` | API 种子 |
| SPU-2026-010 `验收防晒衣` | `01a1586d-a583-7400-a55c-4d880efbaf0d` | **CSV 导入 UI 真实写入**（3 行聚合成 1 商品） |
| SPU-2026-020 `验收圆领卫衣` | `01a15875-c79d-71b1-8fd7-9c881dd7b4d3` | **新建商品 UI 真实写入** |
| Provider `ui_provider` | `01a15879-61e7-7bf3-8137-d3849f9f311f` | **后台新建表单 UI 真实写入**，测试 ok 6ms |
| Model `UI Mock` | `01a15879-c2f2-7aa3-8845-0b7b906a6f98` | **后台新建表单 UI 真实写入**，测试→发布 |
| Route `UI 验收草稿路由` | org / copy / priority 200 | **后台新建表单 UI 真实写入**，编辑为 active 成功 |
| 文案审批 | `01a15873-2253-7e12-a92a-09a85ed14f01`（B，pending） | 文案工作台真实提交；target_hash `a8909717…a4f1162` |
| 旧审批（改稿前） | `01a1586e-e288-7560-8248-4e1bc14b43d0`（B，pending） | target_hash `7fcf330c…34c560`，用于对照改稿后的 hash 变化 |

> 种子脚本在 `.tmp-m3/`（已 gitignore），只调用公开 API；未直接 SQL 写业务表。属性映射的 `platform_category` 两行是验收夹具（见 §6）。

---

## 3. 主流程验收

### 3.1 商品列表

**路径**：登录 admin → 侧栏“商品库” → `/products`。

实测：

- 4 条商品（2 条 API 种子 + 1 条 CSV 导入 + 1 条 UI 新建），游标分页显示“本页 4 条”。
- 平台列来自服务端 `platform_states`：PDD/1688 均为“未上架”；缺失字段来自服务端 `missing_fields`：显示“缺资质 / 缺平台类目”chips，tooltip 保留原始 code。
- 尺码版本列显示 v2 / v1（后端按商品返回 `size_chart_version`）。
- 搜索实测：viewer 输入“防晒”后请求带 `q`，列表收敛为 SPU-2026-010 1 条（真实过滤）。
- 权限：admin 显示“导入 CSV / 新建商品”；viewer 不渲染这两个按钮。
- 错误/空态：加载骨架、空结果、请求失败重试均已接线；本轮 4 条数据无空态截图。

截图：[m3-products-list.png](assets/M2-web/m3-products-list.png)、[m3-viewer-products.png](assets/M2-web/m3-viewer-products.png)。

### 3.2 商品详情

**路径**：列表点击 `SPU-2026-001` → `/products/{id}`。

截图与实测：

1. **概览与 SKU**：SPU、名称、类目、fit、状态、描述；SKU 表显示色卡示意块、归一后的色卡号（`BE-0201` / `BK-0101`）、SKU 编码、面料编码、售价/划线价/促销价（分→元）、库存、起批。颜色固定标注“色系示意，实物颜色以素材为准”。
   - [m3-product-detail.png](assets/M2-web/m3-product-detail.png)
2. **尺码表按版本**：v2 为“生效中（推断）”，v1 为“历史”；切换 v1 后测量值变化。页面固定提示“**服务端未返回 status，按最高版本推断‘生效中’；历史版本仅用于查看，不代表平台当前读取的版本**”。
   - [m3-size-chart-versions.png](assets/M2-web/m3-size-chart-versions.png)
   - [m3-size-chart-history.png](assets/M2-web/m3-size-chart-history.png)
3. **面料成分**：按 note 分组（主料），棉 80% / 聚酯纤维 20%，合计 100%；百分比条按比例绘制；合计非 100 时红标（逻辑已实现）。
   - [m3-fabric.png](assets/M2-web/m3-fabric.png)
4. **平台属性**：PDD / 1688 双 tab，显示属性路径、内部值、平台值 ID、状态；`attr_type/platform_value_name/unmapped` 未返回时不伪造。
   - [m3-attributes.png](assets/M2-web/m3-attributes.png)
5. **素材摘要**：`media_summary.counts={}` 时显示“素材统计未接入（M6）”，不显示 0。
6. **事实版本**：详情头部显示 `fact v14`（由后端返回），不是前端计算。

### 3.3 新建商品（UI 真实提交）

**路径**：`/products` → “新建商品” → `/products/new`。

1. 空表单提交 → 顶部出现“校验未通过（7 项）”，逐项列出 `spu_code / name / category_code / skus[0].color_id / size_code / price_cents / size_chart`；不发起写请求。
   - [m3-product-create-errors.png](assets/M2-web/m3-product-create-errors.png)
2. 填写 `SPU-2026-020 / 验收圆领卫衣 / A0101`，SKU `GY0101 / M / 199 元`，尺码表 `M`（衣长 70、胸围 108、肩宽 45），面料默认棉 100%；提交成功，跳转详情。
3. 详情实测：`GY0101` 被归一为 `GY-0101`，SKU 编码 `SPU-2026-020-GY-0101-M`，售价 `¥199.00`，库存 0，起批 1；`fact v4`。
   - [m3-product-created.png](assets/M2-web/m3-product-created.png)
   - [m3-product-create.png](assets/M2-web/m3-product-create.png)（表单全貌）

> 校验口径与后端一致：SPU 正则、类目正则、色卡/尺码归一、价格转整数分、成分 1–8 条且降序合计 100、尺码至少 2 个测量值且 0.5 步进、SKU 尺码必须在尺码表内、建议身高/体重成对且递增。服务端 422 的 `detail.issues` 会回填到同一校验列表；409 单独提示 SPU 重复。

### 3.4 CSV 导入

**路径**：`/products` → “导入 CSV” → `/products/import`。

1. 点击“下载模板 CSV”得到带 BOM 的模板（18 列，含 JSON 列示例）。
2. 通过浏览器文件选择注入 3 行同 SPU CSV（S/M/L，含面料 JSON、测量 JSON、建议区间、生效日期）→ 预览：
   - `rows_total=3`、`rows_ok=3`、`rows_failed=0`、`warnings=0`；确认按钮可用。
   - [m3-import-preview.png](assets/M2-web/m3-import-preview.png)
3. 确认导入 → 返回 `import_id`、3 行成功；生成 `SPU-2026-010 / 验收防晒衣`（3 SKU / 1 色）。
   - [m3-import-success.png](assets/M2-web/m3-import-success.png)
4. 失败样本：1 行、未知纤维“不存在的纤维” → 预览 `rows_total=1 / rows_ok=0 / rows_failed=1`，失败行表格显示“整组 · SPU-2026-011 · 面料成分校验失败”，确认按钮禁用；未写库。
   - [m3-import-failed.png](assets/M2-web/m3-import-failed.png)

### 3.5 文案工作台

**路径**：`/copy` → 选择 `双面穿风衣` → 拼多多 / 标题。

#### A. 生成

- 请求 `POST /content/drafts`（product_id/platform/content_type/tone/constraints）；同步等待，按钮显示已耗时，可“取消请求”（AbortController；取消时明确提示“模型调用可能仍在服务端继续，成本可能产生”）。
- 实测返回 20 字标题、`facts_hash=76b69fdb…`、`model_call_id=01a1586e…8d71`；页面显示“模型：由路由策略自动选择（copy 用途）”，无模型选择器。
- [m3-copy-generated.png](assets/M2-web/m3-copy-generated.png)

#### B. L1 / L2 判定

- 干净文案：L1 0 命中；L2 未调用，`short_circuit=NO_EVIDENCE`，`verdict=escalate`、`severity=high`、修复建议“转 L3 人工复核”。页面用紫色“升级人工复核”区分，并明确“**这是升级态，不是通过**；系统不会自动放行”。
- 编辑为“双面穿风衣 全网最低价 春秋新款 防风立领”后重判：L1 命中 2 条（`L1-LEX-001` “全网最低”“最低价”），`short_circuit=L1_BLOCKER`，`verdict=reject`、`severity=blocker`；命中预览用红色 mark 精确标出两段；提交审批按钮禁用并提示“驳回内容不可提交审批”。
- 证据抽屉：本次判定 `evidence_refs=[]`，显示“无引用证据”；抽屉代码支持逐字 quote + doc/chunk/version + 复制 + `/kb` 占位（G4）。
- [m3-copy-escalate.png](assets/M2-web/m3-copy-escalate.png)
- [m3-copy-reject.png](assets/M2-web/m3-copy-reject.png)

#### C. 内容审批

- 恢复干净文案并重判（escalate）后提交 `POST /approvals`（`subject_type=content_draft`、`action=publish`、正文、original、facts_hash、判定摘要、商品快照）。
- 返回 `level=B`、`target_hash=a8909717…a4f1162`、`expires_at`、`sla_due_at`；页面只显示服务端 level（“提交内容发布 · B 级”），不硬编码。
- 审批创建后再次编辑正文，页面显示逐字黄条：**“内容已修改，旧审批的 target_hash 将不再匹配，请提交新审批”**；不出现“旧审批已失效/自动作废”。
- 数据库中保留改稿前审批 `7fcf330c…34c560` 与改稿后审批 `a8909717…a4f1162` 两条 pending，证明新审批是新 hash，旧审批未被服务端自动失效（G3）。
- [m3-copy-approval.png](assets/M2-web/m3-copy-approval.png)
- [m3-copy-target-hash-warning.png](assets/M2-web/m3-copy-target-hash-warning.png)

#### D. 历史草稿

- 抽屉 `GET /content/drafts?limit=20` 实测 3 条（2 条早期判定 + 1 条本次），显示 `status=judged`、`verdict=—`（列表不返回判定）、更新时间；点击可载入正文后重新判定。viewer 可看历史，但生成区显示“当前账号没有 content.write 权限，只能查看历史草稿与判定”。
- [m3-viewer-copy.png](assets/M2-web/m3-viewer-copy.png)

### 3.6 模型与供应商

**路径**：`/models`；admin 可切“后台视图（配置）”，viewer 只渲染前台只读。

#### A. 后台新建 Provider（UI 真实提交）

- 填 `name=ui_provider`、`base_url=https://127.0.0.1:8443`、`credential_ref=mock_cred`，提交成功；状态“配置中”。
- 点击“测试连通” → `连通性正常 · 6ms · probed 1`，状态转为“启用”。
- [m3-models-provider-ui.png](assets/M2-web/m3-models-provider-ui.png)
- 已有 `mock_text` 的测试也实测通过（8ms）。列表只显示 `moc****ed` 凭据掩码，不返回密钥。

#### B. 后台新建 Model → 测试 → 发布（UI 真实提交）

- 选 `ui_provider`，填 `mock-chat-ui / UI Mock`，能力 text，purpose copy+judge，`params_schema={"type":"object","properties":{"prompt":{"type":"string"}}}`，`default_params={"prompt":"ping"}`，输入 10 分/千 token、输出 20 分/千 token，context 32000。
- 创建成功为“草稿”，`visible=false`，原因 `no_route`（后端返回 `visible_reason`，前端直接展示）。
- 点击“测试” → 8ms 通过；点击“发布” → `published`，前台可见。
- [m3-models-model-ui.png](assets/M2-web/m3-models-model-ui.png)
- 已有 `Mock Chat` 的测试/发布也已实测；发布守卫失败时的 `detail.missing[]` 会显示为清单（本轮 UI 新建模型一次通过，失败分支由代码路径覆盖）。

#### C. Route 新建与编辑（UI 真实提交）

- 新建 org / copy / priority 200 / model `UI Mock` / status draft → 成功，列表显示 3 条路由（copy 100、copy 200、judge 100）。
- 点击草稿行的“编辑”，把 status 改为 active 并保存 → PATCH（If-Match 用列表返回的 `version`）成功，列表变为“生效”。
- [m3-models-route-ui.png](assets/M2-web/m3-models-route-ui.png)
- [m3-models-route-create.png](assets/M2-web/m3-models-route-create.png)（新建表单）

#### D. 用量与成本

- `GET /usage?from&to&group_by=model` 实测 5 次调用、输入 900 / 输出 120 token、费用 ¥0.06；表格与占比条按真实数据绘制。
- [m3-models-usage.png](assets/M2-web/m3-models-usage.png)

#### E. 前台只读

- admin 前台视图：显示 `Mock Chat`，能力“文本”、价格“输入 10 分/千 token ≈ ¥0.10 / 输出 20 分/千 token ≈ ¥0.20”、rpm 60、tpm 120000、发布日；无选择器，固定提示“由路由策略自动选择”。
- viewer 前台视图：`当前角色没有可用模型`，空态解释可能原因（角色无用途权限 / 无 active 路由 / 未发布 / 供应商不可用），并声明“前端不推断”；不显示后台 tab。
- [m3-models-frontend.png](assets/M2-web/m3-models-frontend.png)
- [m3-viewer-models.png](assets/M2-web/m3-viewer-models.png)
---

## 4. 权限与可见性（只读 `/me.permissions[]`）

| 能力 | admin | viewer | 实测 |
|---|---|---|---|
| 商品列表/详情 | ✅ | ✅ | viewer 可读列表；平台态/缺失字段正常 |
| 新建商品 / 导入 | ✅ | ❌ | viewer 列表不渲染“新建商品 / 导入 CSV”；直达 `/products/new`、`/products/import` 由 `guardPage` 显示无权限态 |
| 文案生成/判定/审批 | ✅ | ❌ | viewer `/copy` 显示只读提示与“历史草稿”，生成按钮不渲染 |
| 模型前台只读 | ✅（1 个可见） | ✅（0 个） | viewer 空态，不伪造模型 |
| 模型后台 | ✅ | ❌ | viewer 不渲染“后台视图”tab；直达 `/models?view=backend` 显示“无权访问或不存在 / 模型写（model.write）” |
| 文案审批级别 | 服务端 B | — | 页面只显示“提交内容发布 · B 级” |

截图：[m3-viewer-products.png](assets/M2-web/m3-viewer-products.png)、[m3-viewer-models.png](assets/M2-web/m3-viewer-models.png)、[m3-viewer-forbidden.png](assets/M2-web/m3-viewer-forbidden.png)。

> 权限判断只用 `permissions[]` 键，不按角色名硬编码；直入后台统一显示“无权访问或不存在”，不泄露对象存在性。

---

## 5. 契约缺口与偏差（按 docs/13b §7）

| # | 实际表现 | M3 处理 | 影响 / 后续 |
|---|---|---|---|
| **G1** | **已解决**：`GET /products` 实际返回 `platform_states{pdd,1688}` 与 `missing_fields[]`（t28 在实现期间落地） | 列表直接渲染“未上架 / 缺资质 / 缺平台类目”，未改布局；`platform/missing_fields` 查询参数仍未启用，UI 不渲染这两个筛选 | 无阻塞；筛选参数待后端确认语义 |
| G3 | 无草稿 PATCH、无审批自动失效 | 本地编辑 + 带 text 重判 + 新审批；黄条逐字按裁决；不写“已失效” | 编辑不落库；刷新后回到草稿原文 |
| G5 | 尺码表无 status/effective_to | 按 `max(version_no)` 推断“生效中”，固定注明“服务端未返回 status，按最高版本推断” | 平台实际读取版本仍可能与推断不同 |
| G13 | 内容审批映射 `listing.create` → B 级 | 只显示服务端 `level`（B 级），不硬编码 | 语义待后端加 content action |
| G15/G16 | 模型列表无 provider 名称；草稿接口忽略 model_id | 后台用 Provider 列表本地关联名称；前台不显示供应商；**无任何模型选择器**，固定“由路由策略自动选择” | 无“假开关” |
| G21 | 商品草稿 facts 无 KB 证据，L2 实际不可达 | UI 完整支持 L2 渲染与证据抽屉，但只展示真实的 L1 / `NO_EVIDENCE` escalate；不伪造 L2 | L2 验收留到 KB 证据接入后 |
| G22 | `GET /providers`、`GET /models` 不返回 `version`，但 PATCH 要 `If-Match` | 后台不渲染 Provider/Model 编辑按钮，页面注明原因；新建/测试/发布/停用可用；Route 列表有 version，编辑已实测 | 无法改价格/参数/凭据，需后端补 `version` |
| G23 | `POST /products` 带 0.5 测量值（如肩宽 45.5）返回 **500**：`canonicalValue: float is not allowed in business payload` | 前端仍按规则允许 0.5 步进；验收样本改用整数测量值，并在本记录登记，不伪装成功 | **需后端修**：幂等 checksum 允许有限小数（金额/测量统一整数/字符串） |
| G17 | 历史草稿列表 verdict 恒 null、cost 恒 0 | 显示“—”，打开后重新判定 | 列表无法按判定筛选 |
| G14 | 无角色/用户列表 | Route scope=role/user 需填 UUID；org 流程已实测 | 账号管理后补下拉 |
| G4 | 无 KB chunk 查询端点 | 证据抽屉显示 quote/doc/chunk/version；“去知识库”跳 `/kb?doc=…` 占位 | M7 接入 |

### 5.1 实现中发现并修复的前端问题

- `mutateJson` 对“无 body 的 POST”（Provider 测试、Model 测试/发布/停用）仍发送 `content-type: application/json` 且 body 为空，API 返回 `validation_failed: 请求体不是合法 JSON`。已修为：非 DELETE 且无 body 时发送 `{}`；随后 Provider 测试、Model 测试/发布均实测成功。
- 面料百分比条在 grid 容器内因 `span` 未块级化而不显示，已补 `display:block`；复测正常。
- 全局壳层“M1 骨架”字样在 M3 页面已过时，更新为产品名；未改 M1 页面结构。

---

## 6. 测试夹具说明

- 属性映射需要 `platform_category` 叶子类目；`dssaas_web` 原本为空，验收时插入 1 条 PDD、1 条 1688 叶子类目（`PDD-1001` / `1688-2001`），仅作夹具，不属于产品代码。
- 模型桩 `scripts/dev/mock-model-server.mjs` 用自签 HTTPS，仅验收用；生产不引用。
- `.tmp-m3/` 下种子/夹具脚本已 gitignore；验收后可删除，不影响业务数据。

---

## 7. 质量门

| 命令 | 结果 |
|---|---|
| `pnpm --filter @dssaas/web typecheck` | ✅ exit 0 |
| `pnpm --filter @dssaas/web build` | ✅ exit 0；`/products`、`/products/[id]`、`/products/new`、`/products/import`、`/copy`、`/models` 均为动态路由 |
| `pnpm lint`（静态门禁） | ✅ 0 处违规（contracts 559 / business 306 / sql 24 / package.json 11） |
| `pnpm db:deploy` | ✅ 全部迁移应用 |
| API `/api/health` | ✅ 200（db ok；redis/minio 未配置） |
| 模型桩 `/models` | ✅ 200 |

未运行：`pnpm test`（全仓后端测试，非本任务范围）；本任务未改后端，故未重复跑 API 测试套件。

---

## 8. 截图索引（全部在 `docs/assets/M2-web/`）

| 文件 | 内容 |
|---|---|
| `m3-products-list.png` | 商品列表：平台态、缺失字段、尺码版本、分页 |
| `m3-product-detail.png` | 详情概览 + SKU + 色卡示意 |
| `m3-size-chart-versions.png` | 尺码表 v2“生效中（推断）”+ v1 历史 |
| `m3-size-chart-history.png` | 切到 v1 历史版本 |
| `m3-fabric.png` | 面料成分分组 + 百分比条 |
| `m3-attributes.png` | 平台属性 PDD/1688 映射 |
| `m3-product-create.png` | 新建商品表单全貌 |
| `m3-product-create-errors.png` | 新建校验错误 7 项 |
| `m3-product-created.png` | UI 创建成功后的详情（SPU-2026-020） |
| `m3-import-preview.png` | CSV dry-run 3 行通过 |
| `m3-import-success.png` | 确认导入成功 + import_id |
| `m3-import-failed.png` | CSV 失败行 + 确认禁用 |
| `m3-copy-generated.png` | 生成结果（facts_hash/model_call） |
| `m3-copy-escalate.png` | L1 0 命中 → L2 NO_EVIDENCE 升级 |
| `m3-copy-reject.png` | L1 极限词 2 命中 → reject + 高亮 |
| `m3-copy-approval.png` | 审批 B 级 + target_hash + SLA |
| `m3-copy-target-hash-warning.png` | 改稿后逐字黄条 |
| `m3-models-provider.png` | Provider 列表 + 连通性测试 |
| `m3-models-provider-create.png` | Provider 新建表单 |
| `m3-models-provider-ui.png` | UI 新建 `ui_provider` + 测试 6ms |
| `m3-models-model.png` | Model 列表 + 价格 + 发布态 |
| `m3-models-model-create.png` | Model 新建表单（JSON/价格/purpose） |
| `m3-models-model-ui.png` | UI 新建 `UI Mock` 并发布 |
| `m3-models-route.png` | Route 列表（copy/judge） |
| `m3-models-route-create.png` | Route 新建表单（scope/fallback/quota） |
| `m3-models-route-ui.png` | UI 新建 + 编辑为 active 的 3 条路由 |
| `m3-models-usage.png` | 用量与成本（5 调用 ¥0.06） |
| `m3-models-frontend.png` | admin 前台只读模型卡 |
| `m3-viewer-products.png` | viewer 商品列表（无新建/导入） |
| `m3-viewer-models.png` | viewer 无可用模型空态 |
| `m3-viewer-copy.png` | viewer 文案只读 + 历史草稿 |
| `m3-viewer-forbidden.png` | viewer 直入后台的无权限态 |

---

## 9. 未覆盖 / 遗留

1. **窄屏 760 截图**：响应式断点已实现（≤1400 两栏、≤900 单栏；copy 三栏在 ≤1400/≤900 降级；模型卡自适应），本轮浏览器窗口固定 1384 宽，未单独截 760；M4 前补窄屏走查。
2. **Provider/Model 编辑**：受 G22 阻塞，不渲染编辑；补 version 后开放。
3. **0.5 测量值**：受 G23 阻塞，后端修复后创建/导入可支持半码。
4. **L2 真实裁决**：受 G21 阻塞，当前只有 escalate；KB 证据接入后按现有 UI 直接展示。
5. **Route role/user scope**：无账号列表（G14），只能填 UUID；org scope 已实测。
6. **M4 平台写入门、M6 素材、M7 知识库**：不在 M3 范围，保持占位。
7. 审批决策页属 M1/M2 既有页面；本任务只验证“创建审批 + 跳转链接”，未重复验收决策流。
