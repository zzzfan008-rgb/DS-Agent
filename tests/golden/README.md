# 黄金集（golden set）

docs/15 §7 要求的回归基线骨架。当前为 **10 个结构化样例 SKU**（目标 50 个真实 SKU，M8 起替换），
覆盖 7 个品类、2XS–4XL 常见码段、两平台差异（1688 起批/阶梯价）与 4 条负例。

## 目录

```text
tests/golden/
├─ skus/<sku_id>.json                 # 主数据输入（价格整数分/成分/尺码表/平台差异）
├─ expected/pdd/<sku_id>/copy.json    # PDD 文案期望 + 硬事实
├─ expected/pdd/<sku_id>/size.json    # PDD 尺码表期望（图文同版本）
├─ expected/1688/<sku_id>/copy.json   # 1688 文案期望
├─ expected/1688/<sku_id>/size.json   # 1688 尺码表期望
├─ expected/1688/<sku_id>/quote.json  # 1688 起批量/阶梯价
├─ negative/*.json                    # 应被拦截的负例 + 期望错误码
├─ golden.lock.json                   # 数据集哈希 + 规则/提示词/路由版本
├─ lib/dataset-hash.mjs               # 哈希口径（generator 与 validator 共用）
└─ tools/generate-samples.mjs         # 样例 bootstrap 生成器
```

## 运行

```bash
pnpm test:golden
# 等价于：
node --test tests/golden/golden.test.mjs
node scripts/qa/golden-check.mjs
```

## 校验规则

1. **版本锁**：`golden.lock.json.dataset_sha256` 必须与 `skus/ + expected/ + negative/` 的文件集合一致；
   数据集变更必须走 PR 评审并更新基线（docs/15 §7.3）。
2. **SKU 硬规则**：金额整数分且 `sale ≤ price`、`list ≥ price`；成分合计 100%；
   按 docs/19 §3.2 品类必测部位齐全；`size_order` 严格递增；建议身高/体重区间成对且 `min < max`。
3. **平台预期硬事实**：文案中的价格/库存/成分/尺码/类目必须与主数据逐字一致；
   尺码表逐行一致（图文同版本）；1688 起批量与阶梯价一致。
4. **负例**：`expected_code` 必须在 docs/12 §4 词表内；且变异确实违反对应规则
   （成分≠100 / 缺必测部位 / 价格≤0 / 含禁止词）。

校验器自测（`tests/golden/golden.test.mjs`）还会验证：篡改预期、篡改后同步刷新哈希、负例规则失效
三类情况都能被发现 —— 证明“锁”不是唯一防线。

## 变更流程

1. 新增/替换 SKU：修改 `tools/generate-samples.mjs` 或直接编辑 `skus/` 与 `expected/`（推荐后者）；
2. 运行 `node scripts/qa/golden-check.mjs`，按报错修正硬事实；
3. 运行生成器或手动更新 `golden.lock.json` 的 `dataset_sha256`；
4. 提交 PR，附业务评审记录（docs/15 §7.3）。

> 警告：`tools/generate-samples.mjs` 会覆盖 `skus/expected/negative` 并重写 lock，仅用于 bootstrap；
> 不要在生产基线上顺手运行。

## 已知限制

- 当前是结构化样例，不是 50 个真实脱敏 SKU；
- 不调用真实模型，L2 语义评分待模型网关（t7）与黄金集评分器落地后接入；
- 图片类预期（尺寸/比例/AIGC 标识/EXIF）待素材管线（M4）补齐，当前只覆盖文案与尺码表。
