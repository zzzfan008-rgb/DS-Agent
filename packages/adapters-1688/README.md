# @dssaas/adapters-1688

1688（B2B）适配：**接口客户端骨架 + 阶梯价/起批量领域模型 + 字段映射 + 上架包导出 + 录制回放**。

> 状态：M1 骨架。**平台契约未核验**（`docs/02` §0）。本包不含任何猜测的 method 名、字段名或限流数字；
> 所有平台事实以 `TODO_ITEMS`（`src/todo.ts`）登记，未回填前 `execute()` 必然拒绝发送。

## 为什么 1688 要单独一个包

| 维度 | 拼多多（零售） | 1688（批发/代发） |
|---|---|---|
| 价格 | 售价 + 促销价（单一数字） | **起批价 + 阶梯价 + 区间价**（结构必须先行） |
| 起订 | 无限购语义 | **起批量 / 步进 / 混批** |
| 履约 | 自营发货 | **代发**（代发价、代发库存、退货地址、时效承诺） |
| 客服 | 消费者会话 | **旺旺询盘 → 报价 → 成交**（报价为 C 级不可逆） |

因此本包不复用 `adapters-pdd` 的类型；价格、起批、代发、规格在本包内建模（`src/domain/`）。

## 目录

```
src/
  todo.ts                 # 未核实项登记表（docs/02 附录 B 的代码化）
  validation.ts           # {code, field, expected, actual, hint} 校验问题（docs/19 §10）
  errors.ts               # AdapterError / DomainValidationError
  json.ts csv.ts          # 确定性 JSON/哈希、CSV 转义
  domain/
    money.ts              # 整数分；元→分只在导入层
    price-tiers.ts        # PriceTiersV1：档位连续/不重叠/单调不增/首档=起批量/末档开放
    moq.ts                # 起批量、步进、混批、下单量归整
    dropship.ts           # 代发条款 + 代发字段映射表（平台字段一律 null）
    spec.ts               # 颜色×尺码规格轴与矩阵、别名归一、重复组合检测
    size-chart.ts         # 12 部位键、0.5 步进、品类必测部位、建议区间衔接、码集覆盖
    fabric.ts             # 成分 1–8 条、合计 100、俗称拦截、文本生成
    care.ts               # 洗护五槽位码表与冲突规则
    qualification.ts      # 资质状态机 valid/expiring/expired/missing/unknown
  mapping/attributes.ts   # platform_attribute_mapping 草稿行（全部 draft）+ CSV
  listing/
    package.ts            # 上架包类型、canonicalJson、packageHash
    exporter.ts           # 三级门禁 + JSON/CSV 导出
  client/
    registry.ts           # 27 个操作的能力注册表（method 全为 null）
    signature.ts          # RequestSigner 端口；UNVERIFIED_SIGNER 默认拒绝
    limiter.ts            # 令牌桶（本地保护性限流，非平台配额）
    retry.ts              # 指数退避 + 抖动 + Retry-After；B/C 无幂等键不重试
    archive.ts            # 脱敏留档（header/URL query/body/手机号）
    client.ts             # plan() / execute()：查注册表 → 限流 → 签名 → 发送 → 分类 → 留档
    types.ts              # Transport/Clock/RandomSource；fetch 实现
  testing/
    fakes.ts              # FixedClock / SeededRandom / FakeTransport / 测试签名器
    fixtures.ts           # 录制/回放 transport、fixture 落盘与诚实性校验
```

## 三条安全默认值（不是缺陷）

1. **`execute()` 会拒绝**：注册表里所有真实操作的 `method/httpMethod/path/paramsIn/bodyFormat/
   signatureRequired` 均为 `null`，`verificationGaps()` 非空即抛 `CONTRACT_NOT_VERIFIED`；
2. **签名器会拒绝**：默认 `UNVERIFIED_SIGNER` 调用即抛错；测试用 `createTestSigner()` 只是
   HMAC 管线替身（`id=test-only/…`），**不是** 1688 的算法；
3. **上架包 `publishable=false`**：`CONTRACT_UNVERIFIED` 与 `PLAT-ATTR-002` 是恒定的阻断项，
   直到文档回填并把映射人工置为 `verified`。

## 领域规则（代码即口径）

### 阶梯价 / 起批价 / 区间价（`price-tiers.ts`）

| 规则 | 错误码 |
|---|---|
| 1–5 档、不允许空（1688 上架） | `PRICE_TIER_COUNT` |
| `min_qty` 严格递增 | `PRICE_TIER_ORDER` |
| `price_cents` 随量单调不增（可持平） | `PRICE_TIER_MONOTONIC` |
| 区间不重叠 / 不留空档 | `PRICE_TIER_OVERLAP` / `PRICE_TIER_GAP` |
| 首档 `min_qty == min_order_qty` | `PRICE_TIER_FIRST_MOQ` |
| `max_qty` 只有末档可为 `null` | `PRICE_TIER_OPEN_END` / `PRICE_TIER_CLOSED_LAST` |
| 金额/数量必须是整数 | `PRICE_TIER_PRICE` / `PRICE_TIER_MIN_QTY` / `PRICE_TIER_MAX_QTY` |

区间价不单独存储：`min = 末档价`、`max = 首档价`，推导前先校验单调（`computePriceRange`）。
按量取价用 `resolveTierPrice()`；低于起批量返回 `PRICE_TIER_BELOW_MOQ`，不会"悄悄按首档算"。

### 起批量（`moq.ts`）

`min_order_qty ≥ 1`、`step_qty ≥ 1`、单位受控（`piece|set|dozen`）、`max_order_qty ≥ min_order_qty`、
混批布尔；`orderableQty()` 把采购量向上取整到「起批量 + N×步进」，并显式标记 `belowMoq`。
**混批在 docs/06 没有承载列** → `TODO-1688-PERSIST-01`，导出映射行 `persisted=false`。

### 代发（`dropship.ts`）

启用时必须给代发价、0–60 天时效、库存口径与**引用键**形式的退货地址（`addr:`/`warehouse:`/`return:`，
拒绝明文地址与 URL）；未启用时代发字段必须全为 `null`（防止隐藏代发价）。
`DROPSHIP_FIELD_MAP` 逐项列出「内部字段 → 平台字段（`null`）+ TODO」，回填文档后逐行补齐。

### 规格（`spec.ts`）

尺码词表与别名归一（`2XL→XXL`、`均码/自由码/F→ONE`），明确拒绝 `6XL`/`FREE`/`均码加大`；
色卡编码 `XX-0000`，无连字符历史码只读兼容并告警；同一「颜色+尺码」重复直接阻断；
数字码（90/150/26）必须显式给 `size_order` —— docs/19 的「数字码 10,20,…」与 DB `smallint 0–99`
存在口径冲突，本包选择「显式给出 + 0–99」并在验收记录里登记。

### 尺码表 / 成分 / 洗护 / 资质

- 尺码表：仅 12 部位键、`0.5` 步进、按 `category_code` 校验必测部位（A0202 → 胸围/衣长）、
  建议区间成对且 `min < max`、`one_size` 仅 1 行、码集必须覆盖所有 active SKU；
- 成分：1–8 条、整数、合计 100、俗称（涤纶/尼龙/莱卡…）拦截、文本只由 `renderMaterialsText()` 生成；
- 洗护：五槽位齐全、码表外代码拒绝、「不可水洗 + 水温」冲突拒绝、`source` 不允许模型；
- 资质：`valid/expiring/expired/missing/unknown`；平台资质要求未核验时直接 `unknown` 并阻断（docs/02 H1）。

## 上架包

`buildListingPackage(input)` 输出**内部规范化包**（`1688-listing-package/v0`）：

- 商品 / 成分 / 尺码表 / 规格矩阵 / SKU（含档位与区间价）/ 起批量 / 代发 / 属性映射草稿 / 资质 / 洗护 / 素材；
- `checks.blockers` / `warnings` 逐项带错误码与修复提示；
- `packageHash = sha256(canonicalJson(除 generatedAt 外的全部字段))`，同输入同哈希，可做快照 diff；
- `renderListingPackageCsv()` 是**内部规范列**，不是 1688 后台模板（`templateVerified=false`）。

样例（可提交、可复现）：

```bash
pnpm --filter @dssaas/adapters-1688 sample
# docs/samples/1688-listing-package.sample.json
# docs/samples/1688-listing-package.sample.csv
# docs/samples/1688-attribute-mappings.sample.csv
# packages/adapters-1688/test/fixtures/1688/contract.probe/…json（合成 fixture）
```

## 客户端管线

```
plan()   → 只读：返回缺口（field → TODO id），不触网
execute()→ 注册表校验 → 令牌桶 → [重试循环: 签名 → transport → 留档 → 解析/分类] → 返回
```

- 限流：`ASSUMED_CLIENT_RATE_LIMIT` 只是**本地保护**（1 容量 / 0.2/s），平台配额未知（`TODO-1688-004`）；
- 重试：只重试 `retryable`（429/5xx/超时/网络），4xx 业务拒绝不重试；B/C 级或不可逆操作**没有幂等键时只发一次**；
- 留档：每次尝试一条，`appKey/sign/token/timestamp/nonce/手机号` 全部脱敏，响应体最多 64 KiB；
- 回放：`ReplayTransport` 按请求指纹匹配，匹配不到抛 `NO_FIXTURE`，且**没有任何网络通路**。

## 测试

```bash
pnpm --filter @dssaas/adapters-1688 test        # node:test（tsx），92 条，零依赖外部服务
pnpm --filter @dssaas/adapters-1688 typecheck   # src + test + scripts 全类型检查
```

测试覆盖：阶梯价 20 条（合法/越界/重叠/空档/单调/首档/区间价/指纹）、起批量与代发 12 条、
规格/尺码表/成分/洗护/资质 21 条、映射 7 条、上架包 10 条、客户端与录制回放 15 条、其余为构造器与工具。

## 未关闭的 TODO（按阻塞程度）

见 `src/todo.ts`。摘要：

| TODO | 阻塞 |
|---|---|
| 001 method 命名空间 | 全部 API 调用 |
| 002 请求协议（方法/路径/参数位置/body 格式） | 请求构造 |
| 003 签名算法与公共参数 | 真实签名 |
| 004 限流数字与错误码 | 配额与错误映射 |
| 005 价格档位字段结构 | 改价/发布报文 |
| 006 规格 moq / 混批字段 | 规格映射 |
| 007 代发接口与字段 | 代发履约 |
| 008 询盘/报价/订阅 | 询盘台与报价 |
| 009 类目属性字典 | 映射 `verified`、L2 预检 |
| 010 导入包模板 | 兜底导入 |
| 011 代发承诺与退货地址 | 代发合规展示 |
| 012 沙箱 | 真实契约录制 |
| PERSIST-01 混批/代发无 DB 列 | 持久化（需 docs/06 增补） |

## 边界

- 只被 `apps/api`（写入门）与 `apps/worker` 引用；**不得**被前端直接引用；
- 不读 `.jsonl`、不访问 DSH 存储根、不 import `@prisma/client`（`pnpm lint` 的 BD-01..BD-06 已覆盖）；
- 真实凭据不进入本包；签名可下沉到 `packages/edge-proxy`（docs/00 §8.2）。
