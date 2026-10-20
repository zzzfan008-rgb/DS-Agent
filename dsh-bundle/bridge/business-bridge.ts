/**
 * dsh-bundle/bridge/business-bridge.ts —— Host 内精确路由 + 非 owner Peer（**参考实现，M3 落地**）。
 *
 * 依据 docs/17 §3.3 / docs/21 §13：
 *   - 不用 `/connect`（owner Peer 会绕过 remoteAccess）；
 *   - `ctx.webServer.register({ kind:'exact', path, handler })` 直接拿 node req/res 写 SSE；
 *   - 每请求 `connection.createPeer({ principal:{kind:'business-api'}, interactions:'none' })`；
 *   - `typertGateway.stream({ namespace:'businessAgent', method:'run', args:[env], peer, signal })`；
 *   - `remoteAccess.registerPolicy('business-api', …)` 只放行 `businessAgent/run`。
 *
 * 本文件不属于 M1 编译范围；插件入口签名（name/inject/apply/Config）与 DSH 0.2.1-rc.2
 * 的 Loader 约定一致，M3 接入时以实际类型为准逐行核对（回归 R7：Typert 握手）。
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'business-bridge';
export const inject = ['webServer', 'connection', 'typertGateway', 'remoteAccess'];

export interface BridgeConfig {
  endpoint: string;
  healthEndpoint: string;
  tokenFile: string;
  allowedSourceCidrs: string[];
  principal: { kind: string; role: string };
  allowedIntents: string[];
  runTimeoutMaxMs: number;
}

const INTENT_ROLES: Record<string, string[]> = {
  'content.draft': ['operator', 'admin'],
  'content.rewrite': ['operator', 'admin'],
  'product.qa': ['operator', 'admin'],
  'support.suggest': ['operator', 'admin'],
  'inquiry.quote_draft': ['operator', 'admin'],
  'listing.diagnose': ['admin'],
};

export function apply(ctx: Context, config: BridgeConfig): void {
  const token = readFileSync(config.tokenFile, 'utf8').trim();

  // ── policy（字段名以 @deepseek-ai/dsh-api-remote-access 类型为准）──────────
  ctx.remoteAccess.registerPolicy(config.principal.kind, {
    bindings: () => [
      {
        role: config.principal.role,
        resource: { kind: 'global' },
      },
    ],
    explain: (request: { action?: string; args?: Readonly<Record<string, unknown>> }) => {
      if (request.action !== 'businessAgent/run') {
        return `${config.principal.kind} may only invoke businessAgent/run`;
      }
      const env = request.args?.env as { intent?: string; role?: string } | undefined;
      if (!env?.intent || !config.allowedIntents.includes(env.intent)) return 'intent not allowed';
      const roles = INTENT_ROLES[env.intent];
      if (!roles || !env.role || !roles.includes(env.role)) return 'role × intent denied';
      return undefined;
    },
  });

  // ── health（精确路由；由 api 的 /ready 与 POST 前置检查调用）───────────────
  ctx.webServer.register({
    kind: 'exact',
    path: config.healthEndpoint,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      if (!isTrusted(req, config) || !authorized(req, token) || req.method !== 'GET') {
        return notFound(res);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: process.env.DSH_VERSION ?? '0.2.1-rc.2',
          preset: 'clothing-ops',
          manifest_hash: process.env.DSH_BUNDLE_MANIFEST_HASH ?? null,
          mcp_tools: Number(process.env.DSH_MCP_TOOL_COUNT ?? 0),
          uptime_s: Math.round(process.uptime()),
        }),
      );
    },
  });

  // ── agent run（POST + SSE）────────────────────────────────────────────────
  ctx.webServer.register({
    kind: 'exact',
    path: config.endpoint,
    handler: (req: IncomingMessage, res: ServerResponse) => {
      void handleRun(req, res, ctx, config, token);
    },
  });
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  config: BridgeConfig,
  token: string,
): Promise<void> {
  if (
    !isTrusted(req, config) ||
    !authorized(req, token) ||
    req.method !== 'POST' ||
    !(req.headers['content-type'] ?? '').includes('application/json')
  ) {
    return notFound(res);
  }

  const envelope = JSON.parse(await readBody(req)) as { runId?: string; intent?: string; role?: string };
  if (!envelope.runId) return notFound(res);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // 每请求一个非 owner Peer；interactions:'none' 防越权接收 $events。
  const peer = ctx.connection.createPeer({
    principal: { kind: config.principal.kind, role: config.principal.role },
    interactions: 'none',
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  try {
    const events = await ctx.typertGateway.stream({
      namespace: 'businessAgent',
      method: 'run',
      // gateway 的 args 形态以实际 API 为准（docs/17 §3.3 示意为 args:[env]）；
      // M3 用类型定义核对后固定，变更需升 bridge 版本。
      args: [envelope],
      peer,
      signal: controller.signal,
    });
    for await (const event of events) {
      if (controller.signal.aborted) break;
      const typed = event as { type?: string };
      if (!typed?.type) continue;
      res.write(`event: ${typed.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (typed.type === 'final' || typed.type === 'error') break;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      res.write(
        `event: error\ndata: ${JSON.stringify({
          code: 'upstream_5xx',
          message,
          retryable: true,
          nextAction: 'retry_later',
        })}\n\n`,
      );
    }
  } finally {
    await peer.dispose();
    if (!res.writableEnded) res.end();
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isTrusted(req: IncomingMessage, config: BridgeConfig): boolean {
  // 真实实现用 ipaddr.js / net.BlockList 做 CIDR 判断（docs/17 §3.3）。
  const address = req.socket.remoteAddress ?? '';
  return config.allowedSourceCidrs.some((cidr) => {
    if (cidr === '127.0.0.1/32') return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
    if (cidr === '10.0.0.0/8') return address.startsWith('10.');
    if (cidr === '172.16.0.0/12') return /^172\.(1[6-9]|2\d|3[01])\./.test(address);
    return false;
  });
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 'not_found' }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
