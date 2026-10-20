/**
 * 本地 DSH Host 协议桩（t3 验收/测试用）——**只实现桥接契约**，不冒充真实 DSH。
 *
 * 真实 Host 侧的 `business-bridge` 插件属于 M3（docs/17 状态行：M3 前完成桥接与流式链路）；
 * M1 的 api 驱动层需要一条可复现的、与 docs/17 §3.3 完全一致的 wire：
 *
 *   POST /internal/agent/run  （Bearer + JSON 信封 → text/event-stream）
 *   GET  /internal/health     （版本 / preset / manifest_hash / MCP 工具数）
 *
 * 安全语义与真实 Host 对齐：只接受 127.0.0.1/::1、精确路径、POST、application/json、
 * 常量时间 Bearer 比较；任一不满足返回 404（不暴露存在性）。
 *
 * 事件序列（docs/17 §3.2 左列）：
 *   meta → step(running) → tool_call → tool_result → step(done) → delta×N → usage → final
 * 或 error（`--scenario error`）；`--scenario slow|hang` 用于超时/取消用例。
 *
 * 用法：
 *   pnpm --filter @dssaas/api exec tsx test/support/dsh-host-stub-cli.ts \
 *     --port 43180 --token-file .tmp/bridge-token --scenario echo
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface StubEnvelope {
  runId: string;
  requestId: string;
  userId: string;
  role: string;
  intent: string;
  context: { page: string; objectType?: string; objectId?: string };
  input: { text?: string; params?: Record<string, unknown> };
  facts: { snapshotId: string | null; hash: string | null; version: number };
  bundle: { preset: string; skills: string[]; manifestHash: string };
  toolsAllow?: string[];
  limits: { timeoutMs: number; maxOutputTokens: number; maxToolCalls: number; maxCostCents: number };
}

export type StubScenario = 'echo' | 'error' | 'slow' | 'hang';

export interface StubOptions {
  /** 0 = 随机端口。 */
  port?: number;
  host?: string;
  /** 桥接令牌；必填。 */
  token: string;
  /** 写入令牌文件（POSIX 下 0600），便于 api 以 DSH_BRIDGE_TOKEN_FILE 读取。 */
  tokenFile?: string;
  scenario?: StubScenario;
  /** 健康检查/请求前置失败模拟。 */
  failMode?: 'none' | 'unavailable' | 'http500' | 'reject-token';
  emitQueued?: boolean;
  deltaCount?: number;
  /** 每个 delta 的间隔（ms）。 */
  deltaDelayMs?: number;
  /** 首个 delta 之前额外延迟（ms），用于首 token 超时。 */
  firstTokenDelayMs?: number;
  preset?: string;
  /** 从 dsh-bundle/manifest.json 计算；缺省用固定串。 */
  manifestFile?: string;
  version?: string;
  mcpTools?: number;
  /** 静默（测试内使用）。 */
  quiet?: boolean;
}

export interface StubState {
  requests: number;
  runs: number;
  /** 最近一次收到的信封（测试断言 tools_allow 收窄）。 */
  lastEnvelope: StubEnvelope | null;
  /** 最近一次运行是否被客户端取消（连接断开）。 */
  lastCancelled: boolean;
  /** 最近一次运行实际发出的事件名序列。 */
  lastEventSequence: string[];
  /** 所有 run 的事件序列（按 runId）。 */
  eventSequences: Record<string, string[]>;
  healthChecks: number;
}

export interface StubHandle {
  url: string;
  port: number;
  token: string;
  state: StubState;
  close(): Promise<void>;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function writeSse(res: ServerResponse, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

function isTrustedSource(req: IncomingMessage, trusted: string): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === trusted || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function loadManifestHash(file: string | undefined): string {
  if (!file) return 'stub-manifest-hash';
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'stub-manifest-hash';
  }
}

export async function startDshHostStub(options: StubOptions): Promise<StubHandle> {
  const scenario = options.scenario ?? 'echo';
  const failMode = options.failMode ?? 'none';
  const deltaCount = options.deltaCount ?? 4;
  const deltaDelayMs = options.deltaDelayMs ?? 25;
  const firstTokenDelayMs = options.firstTokenDelayMs ?? 0;
  const preset = options.preset ?? 'clothing-ops';
  const manifestHash = loadManifestHash(options.manifestFile);
  const version = options.version ?? '0.2.1-rc.2-stub';
  const mcpTools = options.mcpTools ?? 2;
  const startedAt = Date.now();

  if (options.tokenFile) {
    writeFileSync(options.tokenFile, `${options.token}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  const state: StubState = {
    requests: 0,
    runs: 0,
    lastEnvelope: null,
    lastCancelled: false,
    lastEventSequence: [],
    eventSequences: {},
    healthChecks: 0,
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function notFound(res: ServerResponse): Promise<void> {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 'not_found' }));
  }

  function authorized(req: IncomingMessage): boolean {
    if (failMode === 'reject-token') return false;
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    return constantTimeEqual(header.slice('Bearer '.length), options.token);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    state.requests += 1;
    if (!isTrustedSource(req, options.host ?? '127.0.0.1')) return notFound(res);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/internal/health' && req.method === 'GET') {
      if (!authorized(req)) return notFound(res);
      state.healthChecks += 1;
      if (failMode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 'dsh_unavailable', message: 'Host 未就绪（stub fail-mode）' }));
        return;
      }
      if (failMode === 'http500') {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ code: 'upstream_5xx', message: 'stub 500' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version,
          preset,
          manifest_hash: manifestHash,
          mcp_tools: mcpTools,
          uptime_s: Math.round((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }

    if (url.pathname !== '/internal/agent/run' || req.method !== 'POST') return notFound(res);
    if (!authorized(req)) return notFound(res);
    if (!(req.headers['content-type'] ?? '').includes('application/json')) return notFound(res);
    if (failMode === 'unavailable') {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'dsh_unavailable', message: 'Host 未就绪（stub fail-mode）' }));
      return;
    }
    if (failMode === 'http500') {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'upstream_5xx', message: 'stub 500' }));
      return;
    }

    let envelope: StubEnvelope;
    try {
      envelope = JSON.parse(await readBody(req)) as StubEnvelope;
    } catch {
      res.writeHead(422, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'validation_failed', message: '信封不是合法 JSON' }));
      return;
    }
    const intents = new Set([
      'content.draft',
      'content.rewrite',
      'product.qa',
      'support.suggest',
      'inquiry.quote_draft',
      'listing.diagnose',
    ]);
    if (!envelope.runId || !intents.has(envelope.intent)) {
      res.writeHead(422, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'validation_failed', message: 'runId/intent 非法' }));
      return;
    }

    state.lastEnvelope = envelope;
    state.runs += 1;
    state.lastCancelled = false;
    // 每个 run 可用 input.params 覆盖场景，便于一个桩覆盖超时/错误/慢速用例。
    const params = envelope.input?.params ?? {};
    const paramScenario = params.stub_scenario;
    const runScenario: StubScenario =
      paramScenario === 'error' || paramScenario === 'slow' || paramScenario === 'hang' || paramScenario === 'echo'
        ? paramScenario
        : scenario;
    const paramNumber = (key: string, fallback: number): number => {
      const value = params[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    const runFirstTokenDelay = paramNumber('stub_first_token_delay_ms', firstTokenDelayMs);
    const runDeltaDelay = paramNumber('stub_delta_delay_ms', deltaDelayMs);
    const runDeltaCount = paramNumber('stub_delta_count', deltaCount);
    const sequence: string[] = [];
    state.lastEventSequence = sequence;
    state.eventSequences[envelope.runId] = sequence;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-run-id': envelope.runId,
      'x-stub-version': version,
    });

    let aborted = false;
    let finished = false;
    const onClose = (): void => {
      if (finished) return;
      aborted = true;
      state.lastCancelled = true;
      sequence.push('client_closed');
    };
    req.on('close', onClose);
    res.on('close', onClose);

    const emit = (event: string, data: unknown): boolean => {
      if (aborted || res.writableEnded) return false;
      sequence.push(event);
      return writeSse(res, event, data);
    };

    try {
      if (options.emitQueued) emit('queued', { position: 0 });
      if (!emit('meta', {
        runId: envelope.runId,
        sessionId: `stub-session-${envelope.runId.slice(0, 8)}`,
        bundleVersion: '1.0.0',
        modelId: 'stub-echo-1',
      })) return;
      emit('step', { seq: 1, name: 'kb.search', status: 'running' });
      emit('tool_call', { tool: 'kb.search', argsSummary: `intent=${envelope.intent} q=<facts>` });

      if (runFirstTokenDelay > 0) await sleep(runFirstTokenDelay);
      if (aborted) return;
      if (runScenario === 'hang') {
        // 不产出 token，也不结束：用于整次运行超时/取消用例。
        await sleep(Math.min(envelope.limits?.timeoutMs ?? 60_000, 60_000));
        return;
      }
      emit('tool_result', { tool: 'kb.search', ok: true, summary: '3 hits（stub）' });
      emit('step', { seq: 1, name: 'kb.search', status: 'done', summary: '命中 3 条知识片段' });

      const replyText = buildReply(envelope);
      const chunkSize = Math.max(1, Math.ceil(replyText.length / Math.max(1, runDeltaCount)));
      const chunks: string[] = [];
      for (let index = 0; index < replyText.length; index += chunkSize) {
        chunks.push(replyText.slice(index, index + chunkSize));
      }
      const take = chunks.slice(0, Math.max(1, runDeltaCount));
      for (const text of take) {
        if (aborted) return;
        if (!emit('delta', { text })) return;
        if (runScenario === 'error' && sequence.filter((name) => name === 'delta').length >= 2) break;
        await sleep(runDeltaDelay);
      }
      if (aborted) return;
      if (runScenario === 'error') {
        emit('error', {
          code: 'upstream_5xx',
          message: '模型供应商 502（stub 模拟）',
          retryable: true,
          nextAction: 'retry_later',
        });
        finished = true;
        res.end();
        return;
      }
      emit('usage', {
        inputTokens: 120 + (envelope.input?.text?.length ?? 0),
        outputTokens: replyText.length,
        costCents: 2,
      });
      emit('final', { output: { text: replyText, artifacts: [] }, durationMs: 420 });
      finished = true;
      res.end();
    } catch {
      if (!res.writableEnded) res.end();
    } finally {
      finished = true;
      req.off('close', onClose);
      res.off('close', onClose);
    }
  }

  function buildReply(envelope: StubEnvelope): string {
    const input = envelope.input?.text ?? '(无输入)';
    const platform = (envelope.input?.params?.platform as string | undefined) ?? 'pdd';
    return `【本地 Host 桩】intent=${envelope.intent}；平台=${platform}；任务=${input}。这是用于验证 api→Host 流式链路的确定性输出，不代表真实模型结果。`;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 0);
  const url = `http://${options.host ?? '127.0.0.1'}:${port}`;
  if (!options.quiet) {
    console.log(`[dsh-host-stub] ready ${url} scenario=${scenario} failMode=${failMode} tokenFile=${options.tokenFile ?? '(inline)'}`);
  }

  return {
    url,
    port,
    token: options.token,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** 判断一个 server 是否在监听（测试/运维排障用）。 */
export function isListening(server: Server): boolean {
  return server.listening;
}
