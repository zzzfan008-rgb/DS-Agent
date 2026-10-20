# 拼多多上架包 · 人工导入说明

- template_profile：`pdd-backend-import-unverified-v0`（verified=`false`）
- generated_at：2026-10-20T06:42:28.861Z
- payload_hash：`b3f95c7d9679640e8735adf9a7e58996f3ecd00256263be091d46080f0d28674`
- data_origin：synthetic_sample
- dry_run：是（本包未触达平台）

## 模板状态

待填：拼多多商家后台批量导入模板的列名、必填列、单文件行数上限与失败回执格式（docs/01 §2.1；需开发者账号后台核验）

- 本 profile 是内部规范列，不是平台官方模板；核验后必须替换列名并升 version。
- 价格同时输出 price_cents（整数分，主数据口径）与 price_yuan（两位小数，人工核对用）。
- 导入前必须确认后台模板与本 profile 一致；不一致时不得手工改包，应改 profile 后重导。

## 行数

- 商品：1
- SKU：8
- 尺码表：4
- 面料成分：3
- 平台属性：3

## 导入与回填清单

1. 在拼多多商家后台选择批量导入入口（入口 URL/路径待核验，docs/01 §2.1）
2. 确认后台模板列名与 manifest.template_profile.id 一致；不一致先改 profile 再导出，禁止手工改包
3. 导入后回填：批次号、成功条数、失败条数、平台驳回原因、包 sha256（ADR-0006 要求）
4. 失败行按平台回执修复主数据后重新生成；不重复提交同一包
5. 资质/主图缺失时不得导入（docs/01 G1：qualification_unknown 禁止进入上架草稿）
6. 本包不触达平台、不产生任何平台写操作；导入动作由人工执行并登记

