/**
 * 最小 seed：创建一个 admin 账号（t2 验收用）。
 *
 * 用法：
 *   SEED_ADMIN_EMAIL=admin@dssaas.local \
 *   SEED_ADMIN_PASSWORD='至少16位口令' \
 *   SEED_ADMIN_NAME='平台管理员' \
 *   pnpm --filter @dssaas/api seed
 *
 * 约束：
 * - 口令只以 Argon2id 哈希落库；stdout 不回显明文；
 * - 已存在同 email 用户时不重置口令（除非显式带 --reset-password）；
 * - TOTP 真值不进 DB：只写 users.totp_secret_ref，真值由 DSSAAS_TOTP_SECRETS 提供。
 */
import { getPrisma, disconnectPrisma } from '@dssaas/db';
import { loadConfig, loadEnvFiles } from './config.js';
import { assertPasswordPolicy, hashPassword } from './lib/password.js';

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const email = config.seedAdminEmail?.trim().toLowerCase();
  const password = config.seedAdminPassword;
  const name = config.seedAdminName ?? '平台管理员';
  const resetPassword = process.argv.includes('--reset-password');

  if (!email || !password) {
    console.error('缺少 SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD，未做任何写入');
    process.exitCode = 2;
    return;
  }
  try {
    assertPasswordPolicy(password, 'admin');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const prisma = getPrisma();
  try {
    const adminRole = await prisma.role.findFirst({
      where: { code: 'admin', archivedAt: null },
      select: { id: true },
    });
    if (!adminRole) {
      console.error('roles 表没有 admin 角色；请先执行 pnpm --filter @dssaas/db run prisma:deploy');
      process.exitCode = 2;
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, archivedAt: null },
      select: { id: true, totpEnabled: true },
    });

    let userId: string;
    let created = false;
    if (existing) {
      userId = existing.id;
      if (resetPassword) {
        await prisma.user.update({
          where: { id: userId },
          data: { passwordHash: await hashPassword(password), failedAttempts: 0, lockedUntil: null },
        });
      }
    } else {
      const passwordHash = await hashPassword(password);
      const totpSecret = config.seedAdminTotpSecret?.trim();
      const user = await prisma.user.create({
        data: {
          orgId: 1n,
          email,
          displayName: name,
          passwordHash,
          status: 'active',
          ...(totpSecret
            ? { totpEnabled: true, totpSecretRef: 'admin_totp' }
            : { totpEnabled: false }),
        },
        select: { id: true },
      });
      userId = user.id;
      created = true;
    }

    const membership = await prisma.membership.findFirst({
      where: { userId, roleId: adminRole.id, status: 'active', archivedAt: null },
      select: { id: true },
    });
    if (!membership) {
      await prisma.membership.create({
        data: {
          orgId: 1n,
          userId,
          roleId: adminRole.id,
          status: 'active',
        },
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          created,
          password_reset: Boolean(existing && resetPassword),
          user_id: userId,
          email,
          role: 'admin',
          display_name: name,
          totp_enabled: Boolean(config.seedAdminTotpSecret),
          note: config.seedAdminTotpSecret
            ? '已设置 TOTP；请把同一 Base32 密钥放进 DSSAAS_TOTP_SECRETS={"admin_totp":"<BASE32>"}'
            : 'TOTP 未启用（M1 seed 默认关闭；生产 admin 必须启用 TOTP）',
        },
        null,
        2,
      ),
    );
  } finally {
    await disconnectPrisma();
  }
}

void main();
