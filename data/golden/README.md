# 黄金集种子（data/golden）

面料/尺码/资质/平台类目的**黄金集骨架**，用于 L1 规则命中率与误杀率回归。
当前 **12 条商品**（上衣 / 裤装 / 连衣裙 / 外套各 3 条），目标 **50 条**（M8 前补齐）。

> 数据全部**虚构但自洽**：标题、商品、报告编号均为示例；平台类目用 `FICT-*` 占位符，
> 不代表真实平台类目 ID（docs/01、docs/02 的接口文档尚未取得）。禁止写入真实品牌名、
> 店铺名、人名或真实检测报告号。

## 目录

```text
data/golden/
├─ products.csv           # 12 条商品主数据（UTF-8，含表头）
├─ size-charts.jsonl      # 12 条 SizeChartV1（每商品一行）
├─ fabrics.jsonl          # 12 条成分（每商品一行，整数百分比合计 100）
├─ expected/
│  ├─ <spu_code>.json     # 每商品一条期望结论（L1 命中 + 硬事实）
│  └─ negative/           # 4 条应被拦截的变异样本
└─ README.md
```

## 字段说明

### `products.csv`

| 列 | 说明 |
|---|---|
| `spu_code` | 商品唯一编码；与 `size-charts.jsonl`、`fabrics.jsonl`、`expected/` 对应 |
| `title` | 中文标题；含极限词的商品，期望结论会命中 `L1-LEX-001` |
| `category_code` | docs/19 类目（`A0101` 男 T 恤、`A0202` 女衬衫、`B0211` 女牛仔长裤、`C0221` 连衣裙、`D0232` 羽绒服） |
| `fabric_json` | 成分对象：`{fabric_code,fabric_name,role,materials:[{material,percent}]}`；百分比为整数、合计 100 |
| `size_chart_json` | 尺码表引用：`{version_no:1, sku_size_codes:[...]}`；码集必须与 `size-charts.jsonl` 一致 |
| `qualification_json` | 资质：`{textile_safety:{standard,grade,report_no},origin_country}`；不得为空 |
| `platform_pdd_category` / `platform_1688_category` | 平台类目占位符（`FICT-*`）；真实接入后替换 |
| `price_cents` / `stock_qty` | 价格整数分 / 库存；自拟，用于硬事实断言 |

### `size-charts.jsonl`

遵循 docs/06 §6.1 的 `SizeChartV1`：

```json
{"spu_code":"GOLD-SPU-001","version_no":1,"size_system":"alpha","unit":"cm",
 "effective_from":"2026-10-01","effective_to":null,"source":"manual","fit_note":"...",
 "sizes":[{"sku_size_code":"S","size_order":20,
   "measurements":{"胸围":96,"衣长":64,"肩宽":42,"袖长":21},
   "recommend_height_min":155,"recommend_height_max":165,
   "recommend_weight_min":45,"recommend_weight_max":55}]}
```

- 一行一个商品；`sizes[].sku_size_code` 必须是合法码（`XXXS`…`5XL`、两位/三位数字码、`ONE`）；
- `size_order` 严格递增；码集必须**完全覆盖** `products.csv` 的 `sku_size_codes`；
- 必测部位按 docs/19 §3.2：上装 胸围+衣长；下装 腰围+裤长；连衣裙 胸围+裙长；外套 胸围+衣长；
- 数字码（如 26/27/28）使用 `size_system=numeric`，字母码使用 `alpha`。

### `fabrics.jsonl`

一行一个商品：`{"spu_code":"...","fabric_code":"...","fabric_name":"...","role":"main","materials":[{"material":"棉","percent":100}]}`。
材料百分比必须为整数且合计 100；必须与 `products.csv` 的 `fabric_json` 一致。

### `expected/<spu_code>.json`

```json
{
  "spu_code": "GOLD-SPU-002",
  "platform": "pdd",
  "expected_verdict": "reject",
  "expected_l1": [
    {"rule_id": "L1-LEX-001", "severity": "blocker", "field": "title", "matched": "全网最低"}
  ],
  "facts": {"price_cents": 12900, "stock_qty": 90, "category_code": "A0202",
            "composition_text": "棉60%+聚酯纤维40%", "size_codes": ["S","M","L"]},
  "notes": "期望 L1 拦截：标题含极限词"
}
```

- `expected_l1` 为空 → `expected_verdict=pass`；非空 → `needs_revision|reject|escalate`；
- `rule_id` 取 docs/08 的 L1 规则（如 `L1-LEX-001`）或平台资质规则（`PLAT-QUA-001`）；
- `facts` 必须与主数据逐字一致（价格/库存/成分/码集/类目）。

### `expected/negative/*.json`

变异样本，用于覆盖“合法输入无法表达”的拦截点：

| 文件 | 变异 | 期望 |
|---|---|---|
| `NEG-001` | 成分改为棉 99% | `L1-CMP-001` + `invalid_fact` |
| `NEG-002` | 资质置空 | `PLAT-QUA-001` + `invalid_fact` |
| `NEG-003` | M 码缺胸围 | `L1-SIZE-003` + `invalid_fact` |
| `NEG-004` | 尺码表删 M 码但 SKU 仍含 M | `L1-SIZE-004` + `invalid_fact` |

结构：`{case_id,base_spu,rule,mutation,expected:{verdict,error_code,l1[]},data:{...变异后的定义}}`。

## 自校验

```bash
node scripts/qa/golden-validate.mjs
# ✔ 黄金集校验通过：12 商品（上衣 3 / 裤装 3 / 连衣裙 3 / 外套 3）+ 12 尺码表 + 12 成分 + 12 期望 + 4 负例
```

校验内容：CSV 列数/表头/行数、JSON 可解析、成分合计 100、尺码表码集覆盖 SKU、
品类必测部位、资质非空、期望结论与主数据一致、负例变异确实违反对应规则；
失败 exit 1。`--json` 输出机器可读结果，`--root <dir>` 可校验副本（篡改验证用）。

**接入计划（按 t15 要求暂不接）**：后续在 t10 的统一编排中，把
`node scripts/qa/golden-validate.mjs` 加入 `pnpm check:contracts`（或 CI quality-gate 的
golden 步骤），与 `tests/golden` 的机器评分器一起跑；本任务先只提供脚本与数据。

## 如何新增样例

1. 按上述格式在 `products.csv`、`size-charts.jsonl`、`fabrics.jsonl` 各加一行（`spu_code` 一致）；
2. 在 `expected/` 增加 `<spu_code>.json`；需要负例时在 `expected/negative/` 增加文件；
3. 运行 `node scripts/qa/golden-validate.mjs`，修复全部报错；
4. 提交 PR；黄金集变更需业务评审（docs/15 §7.3）。

## 评分口径（命中率 / 误杀率）

按 docs/15 §7.2 黄金集规则：

| 指标 | 定义 | 门槛 |
|---|---|---|
| 硬断言命中率 | 期望拦截的负例中被正确拦截的比例 | **100%**（任一漏拦即阻断） |
| 硬事实一致率 | 文案/尺码中的价格、库存、成分、尺码与主数据逐字一致的比例 | **100%** |
| L1 规则命中率 | L1 期望命中的规则确实命中 / 全部期望命中 | 100%（L1 确定性规则） |
| 误杀率 | 合法样本被 L1 错误拦截的比例 | **< 2%** |
| L2 软指标 | 与人工标注一致率（后续模型网关接入） | ≥ 90% |

当前 12 条样例用于“校验器 + 数据格式”自洽性验证；真实模型调用的 L2 评分在 M8 前补齐。

## 与 `tests/golden/` 的关系

- `data/golden/`（本目录）：**种子数据**，CSV/JSONL 形态，便于导入与规则回归；当前 12 条；
- `tests/golden/`（t10 交付）：**机器评分回归基线**，JSON 形态 + `golden.lock.json` 版本锁，当前 10 SKU；
- 两者互补：前者扩规模、接导入；后者锁版本、做 CI 硬事实比对。M8 目标 50 条时统一去重合并。
