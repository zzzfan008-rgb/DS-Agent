/**
 * 契约录制 / 回放（docs/15 §4）—— 无网络、秒级、可进 Git。
 *
 * 当前状态（必须说清楚）：
 * - 1688 的接口文档与沙箱均未核验（`TODO-1688-001/012`），**没有任何真实录制**；
 * - 本模块提供的是「录制/回放机制」本身，并自带一个 `synthetic: true, verified: false`
 *   的形状样例（`test/fixtures/1688/contract.probe/…`），用来证明：
 *   ① 请求指纹能稳定匹配；② 回放期禁止真实网络；③ 脱敏后的 fixture 仍可复现。
 * - 平台文档回填后，用 `scripts/generate-sample.ts` 之外的录制流程产出 `verified: true`
 *   的 fixture，并单独提 PR（docs/15 §生成规则 6）。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AdapterError } from '../errors.js';
import {
  REDACTION_PLACEHOLDER,
  archiveRequest,
  archiveResponse,
  type ArchivedRequest,
  type ArchivedResponse,
} from '../client/archive.js';
import { requestFingerprint } from '../client/signature.js';
import type { HttpRequest, HttpResponse, Transport } from '../client/types.js';

export interface FixtureMeta {
  platform: '1688';
  /** 我方操作 id（不是平台 method —— method 未知）。 */
  operation: string;
  /** 录制时刻（固定值，docs/15 §4.2.4）。 */
  recordedAt: string;
  /** 平台文档版本/公告号；未核验为 null。 */
  docVersion: string | null;
  recorder: string;
  /** 是否为平台真实报文的录制（合成样例必须为 false）。 */
  verified: boolean;
  synthetic: boolean;
  note?: string;
}

export interface ContractFixture {
  meta: FixtureMeta;
  /** `requestFingerprint()`：不含 timestamp/nonce 等易变字段。 */
  matchKey: string;
  /** 已脱敏的请求（docs/15 §4.2.3）。 */
  request: ArchivedRequest;
  response: ArchivedResponse;
}

/** 由一次真实/合成的请求-响应对生成 fixture（请求在写入前脱敏）。 */
export function createFixture(request: HttpRequest, response: HttpResponse, meta: FixtureMeta): ContractFixture {
  return {
    meta,
    matchKey: requestFingerprint(request),
    request: archiveRequest(request),
    response: archiveResponse(response),
  };
}

/** 回放 transport：按指纹匹配；匹配不到抛 `NO_FIXTURE`，绝不触网。 */
export class ReplayTransport implements Transport {
  readonly requests: HttpRequest[] = [];
  readonly matchedKeys: string[] = [];
  private readonly used = new Set<number>();

  constructor(private readonly fixtures: readonly ContractFixture[]) {
    if (fixtures.length === 0) {
      throw new AdapterError({ code: 'NO_FIXTURE', message: '回放需要至少一个 fixture', retryable: false });
    }
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const key = requestFingerprint(request);
    const index = this.fixtures.findIndex(
      (fixture, position) => !this.used.has(position) && fixture.matchKey === key,
    );
    if (index < 0) {
      throw new AdapterError({
        code: 'NO_FIXTURE',
        message: `回放无匹配 fixture（matchKey=${key.slice(0, 12)}…）：请求构造可能已变更`,
        retryable: false,
        details: { matchKey: key, fixtures: this.fixtures.length },
      });
    }
    this.used.add(index);
    this.matchedKeys.push(key);
    const fixture = this.fixtures[index]!;
    return {
      status: fixture.response.status,
      headers: { ...fixture.response.headers },
      body: fixture.response.body,
    };
  }

  /** 未被消费的 fixture（用于断言「没有漏测」）。 */
  unmatchedCount(): number {
    return this.fixtures.length - this.used.size;
  }
}

/** 录制 transport：包住一个真实 transport，把每次成功响应落成 fixture。 */
export class RecordingTransport implements Transport {
  readonly fixtures: ContractFixture[] = [];

  constructor(
    private readonly inner: Transport,
    private readonly metaOf: (request: HttpRequest) => FixtureMeta,
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.inner.request(request);
    this.fixtures.push(createFixture(request, response, this.metaOf(request)));
    return response;
  }
}

/** 文件名安全化：`2026-10-20T02:00:00.000Z` → `2026-10-20T02-00-00-000Z`。 */
export function fixtureFileName(recordedAt: string): string {
  return `${recordedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`;
}

/** 路径规则：`<root>/1688/<operation>/<recordedAt>.json`（docs/15 §4.2）。 */
export function fixturePath(root: string, fixture: ContractFixture): string {
  return path.join(root, fixture.meta.platform, fixture.meta.operation, fixtureFileName(fixture.meta.recordedAt));
}

export async function saveFixture(root: string, fixture: ContractFixture): Promise<string> {
  const file = fixturePath(root, fixture);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return file;
}

/** 读取单个 fixture 文件（严格校验必要字段，避免坏 fixture 静默通过）。 */
export async function loadFixtureFile(file: string): Promise<ContractFixture> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ContractFixture>;
  if (!parsed.meta || !parsed.matchKey || !parsed.request || !parsed.response) {
    throw new AdapterError({
      code: 'FIXTURE_MISMATCH',
      message: `fixture 结构不完整：${file}`,
      retryable: false,
      details: { file },
    });
  }
  if (parsed.meta.platform !== '1688') {
    throw new AdapterError({
      code: 'FIXTURE_MISMATCH',
      message: `fixture 平台不是 1688：${file}`,
      retryable: false,
      details: { file, platform: String(parsed.meta.platform) },
    });
  }
  return parsed as ContractFixture;
}

/** 递归加载目录下所有 `.json` fixture。 */
export async function loadFixtures(root: string): Promise<ContractFixture[]> {
  const out: ContractFixture[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(await loadFixtureFile(full));
    }
  };
  await walk(root);
  return out;
}

/** 校验 fixture 的脱敏与真实性标记（文档回填时防止「合成 fixture 冒充真实」）。 */
export function assertFixtureHonesty(fixture: ContractFixture): string[] {
  const problems: string[] = [];
  if (!fixture.meta.synthetic && !fixture.meta.verified) {
    problems.push('非合成 fixture 必须 verified=true，否则无法判断来源');
  }
  if (fixture.meta.synthetic && fixture.meta.verified) {
    problems.push('合成 fixture 不得标记 verified=true（会把形状样例当成平台事实）');
  }
  if (fixture.meta.verified && fixture.meta.docVersion === null) {
    problems.push('verified fixture 必须记录平台文档版本/公告号（docs/15 §4.2.5）');
  }
  const sensitiveHeaders = ['authorization', 'cookie', 'app_key', 'sign', 'access_token'];
  for (const [key, value] of Object.entries(fixture.request.headers)) {
    if (sensitiveHeaders.includes(key.toLowerCase()) && value !== REDACTION_PLACEHOLDER) {
      problems.push(`header ${key} 未脱敏（真实凭据不得进入 fixture / Git）`);
    }
  }
  return problems;
}
