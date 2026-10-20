/**
 * 口令哈希：Argon2id（m=64MiB, t=3, p=1，docs/14 §3.1）。
 * DB 侧 `ck_users_password_argon2` 强制 `$argon2id$` 前缀，因此不能换算法。
 */
import { Algorithm, hash, verify } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * 用户不存在时也执行一次 Argon2 校验，避免"响应快=账号不存在"的枚举侧信道。
 * 返回恒为 false。
 */
export async function verifyPasswordOrDummy(
  passwordHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!passwordHash) {
    dummyHashPromise ??= hashPassword('dssaas-dummy-password-for-timing-equalization');
    await verifyPassword(await dummyHashPromise, password);
    return false;
  }
  return verifyPassword(passwordHash, password);
}

/** 管理员口令最小长度（docs/14 §3.1：普通 12、管理员 16）。 */
export const PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MIN_LENGTH = 16;

export function assertPasswordPolicy(password: string, role: 'viewer' | 'operator' | 'admin'): void {
  const minimum = role === 'admin' ? ADMIN_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
  if ([...password].length < minimum) {
    throw new Error(`口令至少 ${minimum} 个字符（${role}）`);
  }
}
