# 验收记录 · M1 API 骨架（身份 / 审计 / 统一约定）

| 项 | 内容 |
|---|---|
| 任务 | t2 · API 骨架：身份、审计、统一约定（backend-api） |
| 日期 | 2026-10-20 |
| 依据 | `docs/14-安全与权限设计.md`、`docs/12-接口契约与数据模型.md`（v2，对齐 docs/21）、`docs/06-领域模型与数据字典.md`、`docs/21-接口契约裁决.md` |
| 结论 | **PASS**：19 条自动化用例全绿；登录/登出/越权拒绝/审计落库四类验收全部通过；`GET /health`、`GET /metrics`、`Idempotency-Key` 中间件、配置校验可用；审计哈希链复算通过且 UPDATE/DELETE 被 DB 拒绝 |

> 口径提醒：本任务按 docs/21 执行（金额 `*_cents`、`workflow_run.state+stage`、`judgment.verdict` 四值、`content_type` 等）。t2 只实现身份/审计/横切约定，不涉及商品、模型、写入门业务表。

---

## 1. 交付物

```text
apps/api/
├ package.json / tsconfig.json                 # 新增依赖：@fastify/cookie、@node-rs/argon2、otpauth、zod
├ src/
│  ├ index.ts                                  # 入口：loadEnvFiles → loadConfig → buildApp → listen → 优雅退出
│  ├ app.ts                                    # Fastify 装配（钩子顺序、装饰器、路由注册）
│  ├ config.ts                                 # zod 配置校验；生产默认 Secure + __Host- cookie
│  ├ types.ts                                  # request/instance 类型增强（request_id、auth、session、路由 config）
│  ├ lib/{ids,errors,password,totp,cursor,response}.ts
│  ├ services/{sessions,audit,identity,metrics,login-rate-limit}.ts
│  ├ plugins/{auth,error-handler,idempotency}.ts
│  ├ routes/{auth,audit,health,metrics}.ts
│  ├ seed.ts                                   # 最小 admin seed（幂等、只写 Argon2id 哈希）
│  └ scripts/verify-audit.ts                   # 审计链复算脚本
├ test/
│  ├ run.ts                                    # 测试库守卫 + 重置 schema + migrate deploy + 串行跑测试
│  ├ helpers.ts / auth.test.ts / health.test.ts / config.test.ts / idempotency.test.ts
│  └ smoke-http.ts                             # 真实 HTTP（listen + fetch）冒烟
└ test/{last-run.log,seed.out.log,smoke.out.json,audit-verify.out.log}   # 验收命令的真实输出留档

packages/core/src/authz/matrix.ts              # viewer/operator/admin 权限矩阵（docs/14 §2.5 指定位置）
docs/验收记录-M1-API.md                        # 本文件
```

依赖改动仅 `apps/api/package.json` 与根 `pnpm-lock.yaml`；未改 schema、未建表、未改迁移。

---

## 2. 接口清单（本任务落地部分）

| 端点 | 角色 | 行为 |
|---|---|---|
| `POST /api/auth/login` | 公开 | `{email,password,totp_code?}` → `{user{id,name,role}, csrf_token, expires_at, must_change_password}`；Set-Cookie 会话 + CSRF；写 `auth.login` 审计 |
| `POST /api/auth/logout` | viewer+ | CSRF 校验 → 删会话 + 清 Cookie + 写 `auth.logout` 审计 |
| `GET /api/me` | viewer+ | `{id,name,role,org_id,permissions[],delegations[],quotas{}}` |
| `GET /api/audit` | admin | 过滤 `actor/action/resource_type/resource_id/irreversible/from/to`，游标分页，`with_total=1` 出 `X-Total-Count` |
| `GET /api/health` | 公开（内网） | `{status,checks{db,redis,minio,dsh_host,platforms[]},version,build,uptime_s}`；DB 不可达时 503 |
| `GET /api/metrics` | admin 或 `METRICS_TOKEN` | Prometheus 文本：HTTP 计数/耗时、登录结果、审计写入、up/uptime/build_info |

统一约定：
- 成功 `{request_id,data,meta?}`；失败 `{request_id,error{code,message,retryable,next_action,detail?}}`（docs/12 §1.1、§4）；
- 所有响应回显 `X-Request-Id`、`X-Contract-Version: 2`、`X-Content-Type-Options: nosniff`；
- 写操作默认必须带 `Idempotency-Key`（16–128 位，`[A-Za-z0-9._:-]`）；同键同 payload 回放并加 `Idempotent-Replayed: true`，同键不同 payload → `409 idempotency_conflict`，同键 in-flight → `409 conflict` + `Retry-After: 2`；
- 非 GET 请求强制 CSRF 双提交（`X-CSRF-Token` 与 `dssaas_csrf` Cookie 一致）；生产默认额外校验 Origin/Host 同源；
- 所有异常（Zod / Fastify / 业务）统一映射到 docs/12 §4 错误码；未知异常落 `internal_error` 500。

---

## 3. 验证命令与真实输出

### 3.1 安装与全 workspace 类型检查

```console
$ pnpm install --frozen-lockfile
Scope: all 13 workspace projects
✓ Lockfile passes supply-chain policies
Lockfile is up to date, resolution step is skipped
Already up to date
EXIT_CODE=0

$ pnpm -r --if-present typecheck
… packages/* typecheck: Done
apps/api typecheck: Done
apps/worker typecheck: Done
EXIT_CODE=0
```

### 3.2 自动化验收用例（19/19）

```console
$ TEST_DATABASE_URL='postgresql://dssaas:***@<test-host>:55434/dssaas_test?schema=public' \
  pnpm --filter @dssaas/api test
[test] schema reset
[test] migrations applied          # 4 条迁移（t1 初始 + t12 期间新增的 3 条支撑表迁移）
✔ 登录成功：返回 user/csrf/expires_at，Set-Cookie 可访问 /me
✔ 登出后旧会话立即失效
✔ 越权拒绝：未登录 401、角色不足 403、CSRF 缺失/错误 403
✔ 错误口令 5 次锁定，第 6 次返回 423 locked
✔ TOTP：缺 code 401、错误 code 401、正确 code 通过、重放被拒
✔ 审计落库：登录/登出事件存在、哈希链完整、UPDATE 被拒
✔ GET /audit：admin 可按 action 过滤并游标翻页，viewer 不可见
✔ 错误响应使用统一信封并回显 request_id
✔ 缺少 DATABASE_URL 时抛 ConfigError 且带字段名
✔ 生产默认 Secure + __Host- cookie；开发默认非 Secure
✔ TOTP secrets JSON 解析容错
✔ ID 工具：UUIDv7 格式、ULID 长度、request_id 校验、稳定 JSON
✔ DATABASE_URL 日志脱敏
✔ GET /health 公开且返回 db=ok
✔ GET /metrics：未登录 401、viewer 403、admin 200、bearer token 200
✔ 缺少 Idempotency-Key → 422 validation_failed
✔ 同键同 payload 回放缓存响应，不重复执行 handler
✔ 同键不同 payload → 409 idempotency_conflict
✔ 同键 in_flight → 409 conflict + Retry-After
ℹ tests 19  ℹ pass 19  ℹ fail 0  ℹ duration_ms 4195.9
EXIT_CODE=0
```

完整输出见 `apps/api/test/last-run.log`。测试库由 `test/run.ts` 每次 `DROP SCHEMA public CASCADE; CREATE SCHEMA public` 后 `prisma migrate deploy`，**不用** `migrate dev`；库名不以 `_test` 结尾时拒绝执行。

### 3.3 seed（幂等；只落 Argon2id 哈希）

```console
$ DATABASE_URL='…' SEED_ADMIN_EMAIL='seed.admin@test.local' \
  SEED_ADMIN_PASSWORD='SeedAdminPassword!2026' SEED_ADMIN_NAME='种子管理员' \
  pnpm --filter @dssaas/api seed
{
  "ok": true,
  "created": true,
  "password_reset": false,
  "user_id": "01a15800-40dc-7aa0-bc29-98ddd431fa2e",
  "email": "seed.admin@test.local",
  "role": "admin",
  "display_name": "种子管理员",
  "totp_enabled": false,
  "note": "TOTP 未启用（M1 seed 默认关闭；生产 admin 必须启用 TOTP）"
}
EXIT_CODE=0
# 第二次执行：created=false，无重复用户/成员关系（幂等）
```

管理员口令策略 16 位：短口令直接退出 2，输出“口令至少 16 个字符（admin）”，不写库。

### 3.4 真实 HTTP 冒烟（listen + fetch，非 inject）

```console
$ node --import tsx test/smoke-http.ts   # 完整 JSON 见 apps/api/test/smoke.out.json
{
  "health": { "status": 200, "data": { "status": "ok", "checks": { "db": "ok" } } },
  "login": { "status": 200, "request_id": "req_01M5C00G…", "role": "admin",
             "cookie_names": ["dssaas_sid", "dssaas_csrf"] },
  "me": { "status": 200, "data": { "role": "admin", "org_id": 1, "permissions": [ … ] } },
  "audit": { "status": 200, "actions": ["auth.login", "auth.login", "auth.login"] },
  "logout": { "status": 200, "data": { "ok": true } },
  "me_after_logout": { "status": 401 }
}
EXIT_CODE=0
```

### 3.5 审计哈希链复算

```console
$ pnpm --filter @dssaas/api audit:verify
{
  "ok": true,
  "checked": 29,
  "brokenAtSeq": null,
  "reason": null
}
EXIT_CODE=0
```

审计写入实现：
- `chain_hash = sha256((chain_prev ?? '') + canonical(row))`，`canonical` 为键排序 JSON（不含 `seq/chain_prev/chain_hash`）；
- 同一事务内 `pg_advisory_xact_lock(hashtext('dssaas.audit_log.chain'))` 串行化链尾读取，避免并发分叉；
- 只 INSERT；DB 触发器 `trg_audit_no_update` 对 UPDATE/DELETE 抛 `42501`，测试已验证。
- 审计不写明文凭据：登录/登出 meta 只写 `session_id_hash`，失败登录只写 `email_hash`。

---

## 4. 验收四类用例对照

| 验收项 | 用例 | 结果 |
|---|---|---|
| 登录 | 正确口令 → 200 + 会话/CSRF Cookie；`/me` 返回角色与权限；TOTP 用户缺 code/错 code/重放均拒 | PASS |
| 登出 | 带 CSRF 登出 → 200；旧 Cookie 再访问 `/me` → 401 | PASS |
| 越权拒绝 | 未登录 401；viewer/operator 访问 `/audit` 403；缺/错 CSRF 403；连续失败 5 次锁 15 分钟，第 6 次 423 | PASS |
| 审计落库 | `auth.login` / `auth.logout` / `auth.login_failed` / `auth.account_locked` 均落库；哈希链复算通过；UPDATE/DELETE 被拒 | PASS |

---

## 5. 契约实现说明与偏差（需后续里程碑收口）

| # | 项 | 本实现 | 后续 |
|---|---|---|---|
| D1 | 会话存储 | docs/14 §4.1 终态是 Redis；M1 用 `SessionStore` 接口 + 进程内实现（重启即失效，单实例） | M2+ 换 `RedisSessionStore`（AOF + `sess:user:<uid>` 撤销集合），路由/中间件不改 |
| D2 | TOTP 密钥 | 只落 `users.totp_secret_ref` 名称；真值由 `DSSAAS_TOTP_SECRETS`（JSON）解析，仅为 M1/PoC | 接 DSH/Vault 解析器；管理员的强制 TOTP 由账号管理任务启用 |
| D3 | TOTP 重放防护 | 进程内记录每个用户已用 step（±1 窗口） | 按 docs/14 写 Redis `auth:totp:last:<uid>` |
| D4 | 登录流程 | 单步 `POST /auth/login`（docs/12 v2 契约，`totp_code?`） | docs/14 的两步 `challenge_id` 流程若前端需要，另加端点；当前以 12 为准 |
| D5 | `must_change_password` | 固定 `false`（schema 无该列；先满足 12 的响应字段） | 账号管理任务补列与改密流程 |
| D6 | 幂等存储 | 进程内 `MemoryIdempotencyStore`，接口窄化；**未建 `idempotency_key` 表**（遵守 t2 约束） | t12 支撑表已出现：把实现换成 Postgres/Redis 版本，接口不变 |
| D7 | 登录限流 | 单 IP 5 次/分钟（进程内滑动窗口，可配） | 多实例用 Redis 令牌桶；登录失败审计已带 reason |
| D8 | CSRF Origin | 非 GET 校验 `X-CSRF-Token`；Origin/Host 同源仅生产默认开启（开发可关，便于 curl/测试） | 上线前确认 Caddy 传 `X-Forwarded-Proto`，Fastify `trustProxy` 按部署调整 |
| D9 | 健康检查 | 仅 DB 真实探测；Redis/MinIO/DSH Host 明确 `not_configured` | M2/M4 接真实探针；/metrics 由 admin 或 `METRICS_TOKEN` 抓取 |
| D10 | 审计游标 | `base64url({seq})`，按 `seq` 倒序；`GET /audit` 的 `actor` 支持 uuid 或 email | 若前端要求 `(occurred_at,id)` 游标，可替换 `lib/cursor.ts` 的载荷，契约不变 |
| D11 | 错误码 | 采用 docs/12 §4 全表，额外补 `internal_error` 500（表未列但工程必需） | 文档方可在 12 补该行 |
| D12 | 权限矩阵 | `packages/core/src/authz/matrix.ts` 按 docs/14 §2.2 落 viewer/operator/admin；DB `roles.permissions` 为空时回落到矩阵 | 角色管理任务可把矩阵同步进 DB；矩阵变更走 docs/14 §2.5 流程 |
| D13 | cookie 名称 | 生产 `__Host-dssaas_sid`（Secure）；开发 `dssaas_sid`。CSRF Cookie 固定 `dssaas_csrf`（可读） | 同 D8 |

---

## 6. 给 t7/t8/t9 的接入约定

1. **路由声明即授权**：`config: { minRole: 'viewer'|'operator'|'admin' }`；公开端点用 `config.public=true`；写路由默认强制 `Idempotency-Key`，仅“天然幂等”的端点可 `config.idempotency=false`。
2. **审计**：业务写操作在 handler 内 `await app.audit.record({ action, resourceType, resourceId, requestId, before, after, irreversible, meta })`，并设 `request.auditLogged = true`；通用钩子只兜底，不重复写。`action` 必须匹配 `^[a-z_]+\.[a-z_]+$`。
3. **不可逆动作**：`irreversible=true` 时 `after` 必须带 `operation_level`（DB CHECK）；审批/工单字段进 `meta`（docs/14 §6.1）。
4. **金额**：按 docs/21 用 `*_cents`（int4 / JS number），聚合在 SQL `SUM(...)::numeric`；不要 `BigInt`。
5. **平台类目**：商品只有 `category_code`；平台类目在 `listing.platform_category_id`（t12 迁移已加），上架时校验 `platform_category` 资质。
6. **schema 约束**：Prisma 无 relation/include，查关联用显式两次查询或 SQL join；不要写 `include`。迁移只用 `prisma migrate deploy`。
7. **request_id**：`request.requestId` 已贯穿日志与审计；平台/模型调用要带入。

---

## 7. 复现步骤

```bash
# 1) 一次性测试库（Windows 侧 Docker CLI 不可用时走 WSL；端口可换）
wsl -e bash -lc 'docker run -d --name dssaas-api-test-pg \
  -e POSTGRES_USER=dssaas -e POSTGRES_PASSWORD=dssaas_dev_pw \
  -e POSTGRES_DB=dssaas_test -p 55434:5432 pgvector/pgvector:pg16'

# 2) 若 Windows 的 localhost 未转发到 WSL，用 `wsl hostname -I` 的地址
export TEST_DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@<host>:55434/dssaas_test?schema=public'

# 3) 验收
pnpm install --frozen-lockfile
pnpm -r --if-present typecheck
pnpm --filter @dssaas/api test

# 4) seed + 真实 HTTP + 审计链
DATABASE_URL="$TEST_DATABASE_URL" SEED_ADMIN_EMAIL='seed.admin@test.local' \
  SEED_ADMIN_PASSWORD='SeedAdminPassword!2026' pnpm --filter @dssaas/api seed
cd apps/api && DATABASE_URL="$TEST_DATABASE_URL" SEED_ADMIN_EMAIL='seed.admin@test.local' \
  SEED_ADMIN_PASSWORD='SeedAdminPassword!2026' node --import tsx test/smoke-http.ts
pnpm --filter @dssaas/api audit:verify
```

运行服务（开发）：

```bash
API_PORT=3001 DATABASE_URL='postgresql://…/dssaas' pnpm --filter @dssaas/api dev
```

---

## 8. 已知限制（不阻塞 t2 验收）

1. 单进程会话与幂等存储：多实例/重启后需重新登录、幂等窗口丢失（D1/D6）。
2. Redis 未接入（现有容器需要认证，未使用他任务的 Redis）；健康检查如实报 `not_configured`。
3. 未实现账号管理端点（`GET/POST /users` 等，属治理面后续任务）；当前最小 seed 只保证有一个 admin。
4. 未实现“登出所有设备/改密撤销会话”，但 `SessionStore.deleteAllForUser` 接口已留好。
5. 未做 CORS：生产同源经 Caddy；前端开发建议用 Next 代理转发 `/api`。
