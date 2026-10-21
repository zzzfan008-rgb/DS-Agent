# 验收记录 · 平台账号 API（t54）

| 项 | 内容 |
|---|---|
| 任务 | t54 —— 平台账号 API：增改查 / 测试连接 / 归档（脱敏 + 审计 + 诚实失败） |
| 依赖 | t53（`platform_account` 表，第 16 条迁移 `20261021150000_platform_account`） |
| 依据 | `docs/12` §3.9a（本次新增）、`docs/13` §3.9「平台连接」页、`docs/14` §6 审计、`docs/20` 存储边界 |
| 代码 | `apps/api/src/services/platform-accounts.ts`、`apps/api/src/routes/platform-accounts.ts`、`apps/api/src/app.ts`（注册） |
| 测试 | `apps/api/test/platform-account.test.ts`（7 条）；全量 API 套件 **160/160** |
| 状态 | **通过** |

---

## 0. 结论先行

1. **6 个端点全部落地**（列表/详情/新建/修改/测试/归档），权限与既有 providers 一致：读 viewer、写 admin。
2. **响应里没有任何密钥实值**：只有 `app_key_masked`（如 `pdd****ey`）与 `*_ref`（变量名本身）。
   服务层**没有解析凭据的能力**，所以结构上就不可能泄漏。
3. **误传明文被拦在 400**：引用名形状与"≥24 位连续长串"双校验，返回"请传引用名，实值配在环境变量或 Vault"，
   而不是让 DB 的 23514 冒成 500。这是本任务最容易被忽略的一条 —— 用户误操作时手里正拿着密钥，必须告诉他该放哪。
4. **测试连通是诚实失败**：平台 55 个接口的 method 全部未核验，端点固定返回
   `{ok:false, connectivity:'unknown', reason:'interfaces_unverified'}`，并写回 `last_tested_at/last_test_error`。
   **任何情况下不返回 `ok:true`** —— 伪造成功会让运维以为链路通了，比报错危险得多。
5. **归档而非删除**：`uq_platform_account_shop` 是 `archived_at IS NULL` 部分唯一索引，归档后可重新接入同一店铺。
6. 全量 160/160、`pnpm lint` 0 违规、typecheck 通过；未改前端、未改既有表。

---

## 1. 端点

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/api/platform-accounts` | viewer | 列表；`?platform=pdd\|1688` 可选过滤 |
| GET | `/api/platform-accounts/:id` | viewer | 详情 |
| POST | `/api/platform-accounts` | admin | 新建（引用名，不收明文） |
| PATCH | `/api/platform-accounts/:id` | admin | 修改，需 `If-Match: version` |
| POST | `/api/platform-accounts/:id/test` | admin | 测试连通（诚实失败） |
| POST | `/api/platform-accounts/:id/archive` | admin | 归档 |

契约已写入 `docs/12` §3.9a（含请求/响应字段、错误码、幂等要求）。

### 1.1 响应形状

```json
{
  "id": "019a...",
  "platform": "pdd",
  "shop_id": "SHOP-001",
  "shop_name": "拼多多旗舰店",
  "app_key_masked": "pdd****ey",
  "app_secret_ref": "PDD_APP_SECRET",
  "access_token_ref": "PDD_ACCESS_TOKEN",
  "refresh_token_ref": null,
  "token_expires_at": null,
  "status": "active",
  "connectivity": "unknown",
  "last_tested_at": null,
  "last_test_error": null,
  "contract_version": 2,
  "extra": { "region": "cn-east" },
  "version": 1,
  "created_at": "...",
  "updated_at": "..."
}
```

**没有** `app_secret` / `access_token` / `refresh_token` 字段，也**没有**它们的解析值 —— 只有 `*_ref`。

---

## 2. 三层安全边界

### 2.1 存储层（t53 负责，本任务复核）

真库核对 `platform_account` 的 21 列：

```text
id, org_id, platform, shop_id, shop_name, app_key, app_secret_ref, access_token_ref,
refresh_token_ref, token_expires_at, status, connectivity, last_tested_at, last_test_error,
contract_version, extra, created_at, updated_at, created_by, version, archived_at
明文列数量： 0
CHECK 约束（16）： ck_platform_account_app_secret_ref, ck_platform_account_no_inline_secret,
  ck_platform_account_access_token_ref, ck_platform_account_refresh_token_ref, ...
```

### 2.2 服务层（本任务）

`assertCredentialRef()` 与 DB 同口径做两次判断：

| 检查 | 正则/规则 | 拒绝时 |
|---|---|---|
| 引用名形状 | `^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$` | 400 "必须是引用名…请传引用名，实值配在环境变量或 Vault" |
| 防明文兜底 | `[A-Za-z0-9+/=_-]{24,}` 命中即拒 | 400 "看起来像密钥明文（含 ≥24 位连续长串）…" |

**为什么服务层要重复 DB 的校验**：让误操作得到可读的 400 与下一步指引，而不是 23514 → 500。
用户此时手里正拿着密钥，只说"格式不对"帮不上忙。

### 2.3 审计层

所有写操作（create/update/test/archive）都进 `audit_log`，且：

- `before`/`after` 里的引用名**也脱敏**（`credentialMask`），审计表会被更多人看到，没必要留完整变量名；
- `app_key` 一律 `app_key_masked`；
- 测试断言：审计序列化结果**不含**明文密钥、**不含**完整引用名、**含** `****`。

---

## 3. 测试与真实输出

```console
$ TEST_ONLY=platform-account pnpm --filter @dssaas/api test
✔ 权限：viewer 可 GET；viewer 写 → 403；operator 写 → 403（仅 admin） (700.1104ms)
✔ 新建 pdd 账号 → 201；响应与列表只给脱敏 app_key，绝无 secret 实值 (15.7372ms)
✔ 传明文 secret → 400，且提示"请传引用名"（不是 DB 500） (17.8734ms)
✔ PATCH：正确 If-Match → 200；旧 version → 409；缺 If-Match → 422 (36.7925ms)
✔ 测试连通：必须诚实返回 ok:false + interfaces_unverified，绝不伪造成功 (44.2854ms)
✔ 归档：归档后不出现在列表，且可重新接入同一店铺 (49.7662ms)
✔ 审计：写操作有记录，且记录里无密钥明文 (45.748ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

全量：

```console
$ pnpm --filter @dssaas/api test
ℹ tests 160
ℹ pass 160
ℹ fail 0
ℹ duration_ms 41587.7806

$ pnpm lint
扫描范围：contracts 747 文件 · business 319 文件 · sql 32 文件 · package.json 11 个
✔ 通过：0 处违规

$ npx tsc -p apps/api/tsconfig.json --noEmit
# EXIT=0（无输出）
```

### 3.1 七条用例覆盖

| # | 用例 | 关键断言 |
|---|---|---|
| 1 | 权限矩阵 | viewer GET 200；viewer/operator POST → 403（凭据配置仅 admin） |
| 2 | 新建 + 脱敏 | 201、`status=active`、`connectivity=unknown`；`app_key_masked` 匹配 `^\w{3}\*{4}\w{2}$` 且**不含**完整 key；响应体不含 `app_secret:`/`access_token:` |
| 3 | 明文拒绝 | 传 `sk_live_...` → **400**（非 500），message 含"引用名"与"环境变量/Vault"，`detail.field=app_secret_ref`；非法形状同样 400；**两条都未落库** |
| 4 | 乐观锁 | 正确 If-Match → 200 且 version+1；旧 version → 409；缺 If-Match → 422；PATCH 传明文 → 400 |
| 5 | 诚实失败 | `ok===false`、`connectivity==='unknown'`、`reason==='interfaces_unverified'`；库中 `last_tested_at` 有值、`connectivity` **仍是 unknown**、`last_test_error` 含 reason；列表可见 |
| 6 | 归档 | 归档后列表与详情都查不到（详情 404）；同店铺可**重新接入**（部分唯一索引）；未归档时重复 → 409 |
| 7 | 审计 | 四条 action 齐全、actor 正确；序列化后不含明文、不含完整引用名、含 `****` |

---

## 4. 为什么"测试连通"必须诚实失败

平台接口核验状态（`docs/02` §4）：

- 1688：`TODO-1688-001…012` 全部未关闭（method/协议/签名/限流/类目字典/沙箱）；
- PDD：`TODO-PDD-CONTRACT-VERIFY` 未关闭。

也就是说 **55 个平台接口的 method 都还是 null**。此时若"发一个真实请求试试"：

- 猜对了 → 返回 `ok:true`，运维以为链路通了，实际只是撞对了；
- 猜错了 → 返回 `auth_invalid` 或 `upstream_5xx`，运维去查凭据，方向完全错。

两种结果都在制造虚假信号。所以端点固定返回 `interfaces_unverified`，
并把这次尝试**写回库**（`last_tested_at` + `last_test_error` + `connectivity=unknown`）——
"试过了、还是不通"在列表里长期可见，而不是只存在于一次 HTTP 响应里。

代码里留了 `interfacesVerified` 开关（当前 `false`）：接口核验后改成 `true`，
返回的 reason 会变成 `probe_not_implemented`（仍需实现真实探针），**不会**直接变 `ok:true`。

---

## 5. 偏差与遗留

| # | 事项 | 影响 | 处置 |
|---|---|---|---|
| D1 | 真实连通探针未实现 | 测试按钮只能给出"未核验"，不能给出真实延迟/错误码 | 依赖 adapter 契约核验（`TODO-1688-*` / `TODO-PDD-*`）；届时实现 `interfacesVerified=true` 分支 |
| D2 | 未做 `credential_ref` 元数据联动 | providers 会在 `credential_ref` 表登记引用名，平台账号暂未登记 | 平台凭据走 env/Vault 直接解析，与 provider 的凭据表不是同一套；若后续统一，再补登记 |
| D3 | `app_key` 也脱敏 | 前端无法从列表看出完整 key | `app_key` 是应用标识不是密钥，但列表场景只需要区分是哪把 key，脱敏足够；需要完整值时走新建时的返回 |
| D4 | 多店铺 `shop_id` 为空时唯一键行为 | `(org_id, platform, NULL)` 只允许一条未归档记录 | 与 t53 设计一致（PG 中 NULL 在唯一索引里不相等，但部分唯一索引 + 单条约定）；多店铺必须填 shop_id |
| D5 | 未做批量导入 | 双平台各多店时要逐个建 | 非本任务范围；如需要可加 `POST /platform-accounts/import` |
