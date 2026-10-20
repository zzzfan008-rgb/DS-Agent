/**
 * t4 测试脚手架：合成注册表、假传输、假时钟、临时目录。
 *
 * 合成注册表只存在于测试：它不代表任何拼多多接口，endpoint 名以 `synthetic.` 前缀标识。
 * 生产代码永远使用 `pddRegistry`（全未核验），因此这些 method 不会进入产品路径。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PddConfig } from '../src/config.js';
import { createInterfaceRegistry, type InterfaceRegistry } from '../src/registry/index.js';
import type { PddInterfaceSpec } from '../src/registry/types.js';
import type { HttpTransport, TransportRequest, TransportResponse } from '../src/http/transport.js';

function synthetic(partial: Partial<PddInterfaceSpec> & Pick<PddInterfaceSpec, 'key' | 'title' | 'purpose'>): PddInterfaceSpec {
  return {
    section: '2.1',
    row: 1,
    doc_ref: 'test-only synthetic interface（不是 docs/01 接口）',
    write: true,
    operation_level: 'A',
    action_code: null,
    fallback: 'none',
    conclusion: 'automation',
    conclusion_raw: 'test-only',
    verification: 'verified',
    platform_method: 'POST',
    platform_version: 'synthetic-v0',
    path_template: `/synthetic/${partial.key.replace(/\./g, '/')}`,
    todos: {
      method: 'synthetic',
      permission: 'synthetic',
      rate_limit: 'synthetic',
      sandbox: 'synthetic',
      fields: 'synthetic',
    },
    last_verified_at: null,
    verified_by: 't4-test',
    ...partial,
  };
}

export const TEST_INTERFACES: readonly PddInterfaceSpec[] = [
  synthetic({ key: 'test.echo', title: '测试回声', purpose: '回放/成功路径' }),
  synthetic({ key: 'test.retry', title: '测试重试', purpose: '429/5xx 重试' }),
  synthetic({ key: 'test.reject', title: '测试平台拒绝', purpose: '业务拒绝不重试' }),
  synthetic({ key: 'test.rate_limited', title: '测试限流', purpose: '429 分类' }),
];

export function createTestRegistry(): InterfaceRegistry {
  return createInterfaceRegistry(TEST_INTERFACES);
}

export interface TestConfigOverrides extends Partial<PddConfig> {}

export function testConfig(overrides: TestConfigOverrides = {}): PddConfig {
  return {
    mode: 'live',
    dryRun: false,
    dryRunReason: null,
    warnings: [],
    appKey: 'test-app-key',
    appSecret: 'test-app-secret',
    accessToken: 'test-access-token',
    baseUrl: 'https://api.example.invalid',
    environment: 'sandbox',
    timeoutMs: 1000,
    maxAttempts: 3,
    maxResponseBytes: 1024 * 1024,
    internalQps: 100,
    clockSkewWindowMs: 5 * 60_000,
    archiveDir: path.join(os.tmpdir(), 'pdd-test-archive-unused'),
    ...overrides,
  };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    headers,
    bodyText: body === undefined ? '' : JSON.stringify(body),
    body,
    receivedAtMs: 1_700_000_000_000,
    truncated: false,
  };
}

export type FakeResponse = TransportResponse | Error | ((request: TransportRequest) => TransportResponse | Error);

export class FakeTransport implements HttpTransport {
  readonly requests: TransportRequest[] = [];
  private readonly responses: FakeResponse[];

  constructor(responses: FakeResponse[]) {
    this.responses = [...responses];
  }

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error('FakeTransport 没有更多响应');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') {
      const result = next(request);
      if (result instanceof Error) throw result;
      return result;
    }
    return next;
  }
}

export class FakeClock {
  current = 1_700_000_000_000;
  readonly waits: number[] = [];

  now = (): number => this.current;

  advance = (ms: number): void => {
    this.current += ms;
  };

  sleep = async (ms: number): Promise<void> => {
    this.waits.push(ms);
    this.current += ms;
  };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dssaas-pdd-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 静态回放夹具目录（包内自包含；格式与 tests/contract/lib/fixtures.mjs 一致）。 */
export const REPLAY_FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/replay');
