/** t2 测试辅助：真实 Postgres + Fastify inject，不 mock 数据库。 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { PrismaClient } from '@dssaas/db';
import type { Role } from '@dssaas/core';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { hashPassword } from '../src/lib/password.js';

export const prisma = new PrismaClient();

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '',
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    AUTH_LOGIN_RATE_WINDOW_MS: '60000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

export async function buildTestApp(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
  return buildApp(testConfig(overrides), { prisma, disconnectOnClose: false });
}

export interface CreateUserInput {
  email: string;
  password: string;
  role: Role;
  displayName?: string;
  totpEnabled?: boolean;
  totpSecretRef?: string;
}

export async function createUser(input: CreateUserInput): Promise<{ id: string; email: string }> {
  const role = await prisma.role.findFirstOrThrow({
    where: { code: input.role, archivedAt: null },
    select: { id: true },
  });
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.create({
    data: {
      orgId: 1n,
      email,
      displayName: input.displayName ?? input.email,
      passwordHash: await hashPassword(input.password),
      status: 'active',
      totpEnabled: input.totpEnabled ?? false,
      totpSecretRef: input.totpSecretRef ?? null,
    },
    select: { id: true, email: true },
  });
  await prisma.membership.create({
    data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' },
  });
  return user;
}

const KNOWN_COOKIES = new Set(['dssaas_sid', 'dssaas_csrf', '__Host-dssaas_sid', '__Host-dssaas_csrf']);

/** 从 Set-Cookie 头里取会话/CSRF cookie（兼容 string 与 string[]）。 */
export function cookiesFrom(response: LightMyRequestResponse): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const joined = Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
  const cookies: Record<string, string> = {};
  for (const match of joined.matchAll(/([A-Za-z0-9_-]+)=([^;,\s]+)/g)) {
    const name = match[1]!;
    const value = match[2]!;
    if (KNOWN_COOKIES.has(name)) cookies[name] = value;
  }
  return cookies;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function sessionHeaders(
  cookies: Record<string, string>,
  csrfToken?: string,
): Record<string, string> {
  return {
    cookie: cookieHeader(cookies),
    ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
  totpCode?: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { email, password, ...(totpCode ? { totp_code: totpCode } : {}) },
  });
}

export function csrfFrom(response: LightMyRequestResponse): string {
  const body = JSON.parse(response.body) as { data?: { csrf_token?: string } };
  return body.data?.csrf_token ?? '';
}
