/**
 * t53 真实库行为验证：platform_account
 *
 * 用法（从仓库根，绕开 with-db.mjs 的 Windows pnpm 路径缺陷）：
 *   DATABASE_URL='postgresql://dssaas:dssaas_dev_pw@172.23.33.92:55434/dssaas_local?schema=public' \
 *     node scripts/qa/verify-platform-account.mjs
 *
 * 断言（全部走真实 PostgreSQL，错误以 SQLSTATE 判定而不是字符串）：
 *   1) 插入 pdd / 1688 成功；
 *   2) platform='taobao' → 23514（CHECK ck_platform_account_platform）；
 *   3) 同 (org_id, platform, shop_id) 重复插入 → 23505（uq_platform_account_shop 部分唯一索引）；
 *   4) 归档（archived_at）后可再插同店铺 → 成功；
 *   5) status / connectivity 非法值 → 23514；
 *   6) *_ref 存明文形态长串 → 23514（ck_platform_account_no_inline_secret）；
 *   7) connectivity != 'unknown' 但 last_tested_at 为空 → 23514；
 *   8) extra 非 object → 23514；
 *   9) updated_at 触发器刷新 + version 自增（trg_set_updated_at / trg_bump_version）；
 *  10) 表结构：无明文凭据列 / 索引与触发器落库形态。
 *
 * 幂等：单个连接、单事务 + SAVEPOINT，结束时 ROLLBACK，不留残行。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(REPO_ROOT, 'packages/db/package.json'));
const { PrismaClient } = require('@prisma/client');

const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const INSERT = `INSERT INTO platform_account
  (id, org_id, platform, shop_id, shop_name, app_key, app_secret_ref, access_token_ref,
   refresh_token_ref, token_expires_at, status, connectivity, last_tested_at, contract_version, extra)
  VALUES ($1::uuid, 1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::timestamptz, $13, $14::jsonb)
  RETURNING id, platform, shop_id, status, connectivity, contract_version`;

const uuid = (n) => `0192f3c4-0000-7000-8000-${String(n).padStart(12, '0')}`;

// 引用名（环境变量名形态）——只存名字，不存明文
const REF_PDD_SECRET = 'PDD_APP_SECRET';
const REF_PDD_TOKEN = 'PDD_ACCESS_TOKEN';
const REF_PDD_REFRESH = 'PDD_REFRESH_TOKEN';
const REF_1688_SECRET = 'ALI1688_APP_SECRET';

function sqlState(error) {
  return error?.meta?.code ?? error?.code ?? 'n/a';
}

function sqlMessage(error) {
  return String(error?.meta?.message ?? error?.message ?? error).replace(/\s+/g, ' ').slice(0, 220);
}

/**
 * 事务内单步：SAVEPOINT 包裹。PostgreSQL 遇 CHECK/唯一冲突会把整个事务置为 aborted，
 * 后续语句全部 25P02，所以每个预期失败用例先 ROLLBACK TO SAVEPOINT 再继续。
 */
async function stepSql(db, sp, name, sql, params, { expectCode, expectSuccess = false } = {}) {
  await db.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    const rows = await db.$queryRawUnsafe(sql, ...params);
    if (expectSuccess) record(name, true, 'SUCCESS');
    else record(name, false, `期望失败(${expectCode})但成功：${JSON.stringify(rows).slice(0, 200)}`);
    await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
  } catch (error) {
    const code = sqlState(error);
    const message = sqlMessage(error);
    await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    await db.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    if (expectSuccess) {
      record(name, false, `期望成功但失败 SQLSTATE=${code} :: ${message}`);
    } else {
      record(name, code === expectCode,
        `SQLSTATE=${code}${code === expectCode ? '' : ` (期望 ${expectCode})`} :: ${message}`);
    }
  }
}

/** 断言某个 count(*) 等于期望值（用于「归档不计入唯一」这类结果验证）。 */
async function stepCount(db, name, sql, expected) {
  const rows = await db.$queryRawUnsafe(sql);
  const n = Number(rows[0]?.n ?? NaN);
  record(name, n === expected, `n=${n}`);
}

async function main() {
  console.log('[verify] platform_account 行为验证开始');
  const prisma = new PrismaClient({ log: [] });

  try {
    // 0. 表结构：不存在明文凭据列
    const cols = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'platform_account' ORDER BY ordinal_position`,
    );
    const colNames = cols.map((c) => c.column_name);
    record('列清单（21 列）', colNames.length === 21, colNames.join(','));
    const forbidden = ['app_secret', 'access_token', 'refresh_token', 'secret', 'password', 'token'];
    const leaked = colNames.filter((c) => forbidden.includes(c));
    record('无明文凭据列（app_secret/access_token/refresh_token…）', leaked.length === 0,
      leaked.length ? `发现明文列：${leaked.join(',')}` : '凭据字段全部为 *_ref 引用名列');

    await prisma.$executeRawUnsafe('BEGIN');

    // 1. 插入 pdd / 1688 成功
    await stepSql(prisma, 'sp01', '插入 platform=pdd 成功', INSERT, [
      uuid(1), 'pdd', 'PDD_SHOP_001', '拼多多旗舰店', 'pdd1234567890', REF_PDD_SECRET,
      REF_PDD_TOKEN, REF_PDD_REFRESH, '2026-12-31T00:00:00Z', 'active', 'unknown', null, 2, '{}',
    ], { expectSuccess: true });
    await stepSql(prisma, 'sp02', '插入 platform=1688 成功', INSERT, [
      uuid(2), '1688', 'ALI_SHOP_001', '1688 批发店', 'ali8800123456', REF_1688_SECRET,
      null, null, null, 'active', 'unknown', null, 2,
      '{"deploy":"public_ip_whitelist","edge_proxy":"ok"}',
    ], { expectSuccess: true });

    // 2. platform 枚举：taobao → 23514
    await stepSql(prisma, 'sp03', "platform='taobao' 被拒（23514）", INSERT, [
      uuid(3), 'taobao', 'TB_SHOP', '淘宝店', 'tb12345', 'TB_APP_SECRET',
      null, null, null, 'active', 'unknown', null, 2, '{}',
    ], { expectCode: '23514' });

    // 3. 部分唯一索引：同 org+platform+shop 重复 → 23505
    await stepSql(prisma, 'sp04', '同 (org,pdd,PDD_SHOP_001) 重复插入被拒（23505）', INSERT, [
      uuid(4), 'pdd', 'PDD_SHOP_001', '拼多多旗舰店(重复)', 'pdd9999', REF_PDD_SECRET,
      null, null, null, 'active', 'unknown', null, 2, '{}',
    ], { expectCode: '23505' });

    // 4. 归档后可再插同店铺
    await prisma.$executeRawUnsafe(
      `UPDATE platform_account SET archived_at = now() WHERE id = $1::uuid`, uuid(1),
    );
    await stepSql(prisma, 'sp05', '归档 pdd/PDD_SHOP_001 后可再插同店铺', INSERT, [
      uuid(5), 'pdd', 'PDD_SHOP_001', '拼多多旗舰店(重接)', 'pdd1234567890', REF_PDD_SECRET,
      null, null, null, 'active', 'unknown', null, 2, '{}',
    ], { expectSuccess: true });
    await stepCount(prisma, '活跃记录恰好 1 条（归档不计入唯一）',
      `SELECT count(*)::int AS n FROM platform_account
       WHERE org_id = 1 AND platform = 'pdd' AND shop_id = 'PDD_SHOP_001' AND archived_at IS NULL`, 1);

    // 5. status / connectivity 枚举
    await stepSql(prisma, 'sp06', "status='paused' 被拒（23514）", INSERT, [
      uuid(6), 'pdd', 'PDD_SHOP_X', null, 'k1', REF_PDD_SECRET,
      null, null, null, 'paused', 'unknown', null, 2, '{}',
    ], { expectCode: '23514' });
    await stepSql(prisma, 'sp07', "connectivity='failed' 被拒（23514）", INSERT, [
      uuid(7), 'pdd', 'PDD_SHOP_Y', null, 'k1', REF_PDD_SECRET,
      null, null, null, 'active', 'failed', null, 2, '{}',
    ], { expectCode: '23514' });

    // 6. *_ref 塞明文长串 → 23514（安全兜底）
    await stepSql(prisma, 'sp08', 'app_secret_ref 存明文长串被拒（23514）', INSERT, [
      uuid(8), 'pdd', 'PDD_SHOP_Z', null, 'k1', 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      null, null, null, 'active', 'unknown', null, 2, '{}',
    ], { expectCode: '23514' });

    // 7. connectivity != unknown 但无 last_tested_at → 23514
    await stepSql(prisma, 'sp09', "connectivity='ok' 但 last_tested_at 为空被拒（23514）", INSERT, [
      uuid(9), 'pdd', 'PDD_SHOP_W', null, 'k1', REF_PDD_SECRET,
      null, null, null, 'active', 'ok', null, 2, '{}',
    ], { expectCode: '23514' });

    // 8. extra 非 object → 23514
    await stepSql(prisma, 'sp10', 'extra 非 object 被拒（23514）', INSERT, [
      uuid(10), 'pdd', 'PDD_SHOP_V', null, 'k1', REF_PDD_SECRET,
      null, null, null, 'active', 'unknown', null, 2, '[]',
    ], { expectCode: '23514' });

    // 9. version 触发器（updated_at 见下方 autocommit 段：PostgreSQL 的 now() 是
    //    事务开始时间，整段包在一个事务里时两次 UPDATE 会拿到同一时间戳，测不出前进）
    const before = await prisma.$queryRawUnsafe(
      `SELECT version FROM platform_account WHERE id = $1::uuid`, uuid(2),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform_account SET connectivity = 'ok', last_tested_at = now() WHERE id = $1::uuid`, uuid(2),
    );
    const after = await prisma.$queryRawUnsafe(
      `SELECT version, connectivity FROM platform_account WHERE id = $1::uuid`, uuid(2),
    );
    record('trg_bump_version 自增 version',
      Number(after[0].version) === Number(before[0].version) + 1,
      `${before[0].version} → ${after[0].version}`);
    record('合法 connectivity=ok 且 last_tested_at 非空可写入', after[0].connectivity === 'ok',
      `connectivity=${after[0].connectivity}`);

    // 10. 索引与触发器的落库形态
    const idx = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'platform_account' ORDER BY indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    record('索引清单（platform_account_pkey + uq_platform_account_shop + ix_platform_account_org_platform）',
      idxNames.length === 3, idxNames.join(','));

    const trg = await prisma.$queryRawUnsafe(
      `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relname = 'platform_account' AND NOT t.tgisinternal ORDER BY tgname`,
    );
    record('触发器（trg_bump_version + trg_set_updated_at）', trg.length === 2,
      trg.map((r) => r.tgname).join(','));
  } finally {
    await prisma.$executeRawUnsafe('ROLLBACK').catch(() => {});
  }

  // 事务回滚后不留残行
  const leftover = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM platform_account WHERE org_id = 1 AND shop_id LIKE 'PDD_SHOP_%'`,
  );
  record('验证数据已回滚（无残留）', Number(leftover[0].n) === 0, `n=${leftover[0].n}`);

  // 11. trg_set_updated_at：必须在 autocommit（每次语句独立事务，与真实写入一致）下验证，
  //     否则 now()（= 事务开始时间）恒定，updated_at 不会前进。用临时行，测完即删。
  const diagId = '0192f3c4-0000-7000-8000-0000000dd0a1';
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform_account (id, platform, shop_id, app_key, app_secret_ref)
       VALUES ($1::uuid, 'pdd', 'DIAG_UPDATED_AT', 'k', 'PDD_APP_SECRET')`, diagId,
    );
    const b = await prisma.$queryRawUnsafe(
      `SELECT updated_at::text AS u FROM platform_account WHERE id = $1::uuid`, diagId,
    );
    await new Promise((r) => setTimeout(r, 30));
    await prisma.$executeRawUnsafe(
      `UPDATE platform_account SET shop_name = 'autocommit-check' WHERE id = $1::uuid`, diagId,
    );
    const a = await prisma.$queryRawUnsafe(
      `SELECT updated_at::text AS u FROM platform_account WHERE id = $1::uuid`, diagId,
    );
    record('trg_set_updated_at 刷新 updated_at（autocommit）', b[0].u !== a[0].u, `${b[0].u} → ${a[0].u}`);
  } finally {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform_account WHERE id = $1::uuid`, diagId,
    ).catch(() => {});
  }
  await prisma.$disconnect();

  console.log('');
  const passed = results.length - failures;
  console.log(`[verify] ${passed}/${results.length} 通过${failures ? `，${failures} 失败` : '，全部通过'}`);
  return failures === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[verify] ✖ 运行失败：', error);
    process.exit(2);
  });
