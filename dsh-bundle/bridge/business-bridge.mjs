/**
 * business-bridge.mjs —— 真实 DSH Host 内的桥接插件（t18 开发版）。
 *
 * 挂载方式（profile patch insert）：`file:///D:/DSSAAS/dsh-bundle/bridge/business-bridge.mjs`
 *
 * 契约（docs/17 §3.3、docs/21 §13）：
 *   GET  /internal/health   → 真实 Host 状态（version/preset/manifest_hash/mcp_tools）
 *   POST /internal/agent/run → Bearer + JSON 信封 → text/event-stream
 *
 * 安全：
 *   - 只接受配置的来源网段（默认 127.0.0.1）；方法/路径/Content-Type 不匹配 → 404；
 *   - Bearer 用常量时间比较；令牌文件每请求按 mtime 热读，Host 轮换令牌后旧令牌立即 401
 *     （t18 要求的「过期令牌 401」；生产按 docs/14 可把 authFailureStatus 配成 404）；
 *   - 每请求 createPeer({principal:{kind:'business-api'}, interactions:'none'})，结束 dispose；
 *   - remoteAccess policy 只放行 businessAgent/run，并校验 intent 白名单与 role × intent。
 */

import { readFileSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';

const DEFAULT_INTENTS = [
  'content.draft',
  'content.rewrite',
  'product.qa',
  'support.suggest',
  'inquiry.quote_draft',
  'listing.diagnose',
];

const INTENT_ROLES = {
  'content.draft': ['operator', 'admin'],
  'content.rewrite': ['operator', 'admin'],
  'product.qa': ['operator', 'admin'],
  'support.suggest': ['operator', 'admin'],
  'inquiry.quote_draft': ['operator', 'admin'],
  'listing.diagnose': ['admin'],
};

function constantTimeEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readTokenFile(path) {
  const stat = statSync(path);
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`bridge token file is empty: ${path}`);
  return { token: text, mtimeMs: stat.mtimeMs };
}

function isTrustedSource(address, cidrs) {
  const normalized = address?.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  for (const cidr of cidrs) {
    if (cidr === '127.0.0.1/32' && (normalized === '127.0.0.1' || normalized === '::1')) return true;
    if (cidr === '10.0.0.0/8' && normalized?.startsWith('10.')) return true;
    const match = /^(\d+)\.(\d+)\.0\.0\/16$/.exec(cidr);
    if (match) {
      const prefix = `${match[1]}.${match[2]}.`;
      if (normalized?.startsWith(prefix)) return true;
    }
    const match12 = /^172\.(1[6-9]|2\d|3[01])\.0\.0\/12$/.exec(cidr);
    if (match12) {
      const second = Number(normalized?.split('.')[1] ?? -1);
      if (normalized?.startsWith('172.') && second >= 16 && second <= 31) return true;
    }
  }
  return false;
}

function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
}

export function apply(ctx, config = {}) {
  const endpoint = config.endpoint ?? '/internal/agent/run';
  const healthEndpoint = config.healthEndpoint ?? '/internal/health';
  const tokenFile = config.tokenFile ?? process.env.DSH_BRIDGE_TOKEN_FILE;
  const authFailureStatus = config.authFailureStatus ?? 401;
  const allowedSourceCidrs = config.allowedSourceCidrs ?? ['127.0.0.1/32'];
  const allowedIntents = new Set(config.allowedIntents ?? DEFAULT_INTENTS);
  const principalKind = config.principal?.kind ?? 'business-api';
  const principalRole = config.principal?.role ?? 'agent-runner';
  const preset = config.preset ?? 'clothing-ops';
  const manifestFile = config.manifestFile ?? null;
  const startedAt = Date.now();

  if (!tokenFile) throw new Error('business-bridge: config.tokenFile is required');
  // 启动自检：令牌文件必须可读且非空；Host 起不来比带病运行好。
  let tokenCache = readTokenFile(tokenFile);
  const activeRuns = new Map();

  const currentToken = () => {
    try {
      const stat = statSync(tokenFile);
      if (stat.mtimeMs !== tokenCache.mtimeMs) tokenCache = readTokenFile(tokenFile);
      return tokenCache.token;
    } catch {
      return null;
    }
  };

  let manifestHash = null;
  if (manifestFile) {
    try {
      manifestHash = createHash('sha256').update(readFileSync(manifestFile)).digest('hex');
    } catch {
      manifestHash = null;
    }
  }

  ctx.remoteAccess.registerPolicy(principalKind, {
    bindings: () => [{
      role: { name: principalRole, resource: 'global', actions: ['businessAgent/run'] },
      resource: { kind: 'global' },
    }],
    explain: (request) => {
      if (request.action !== 'businessAgent/run') return `${principalKind} may only invoke businessAgent/run`;
      const env = request.args?.env;
      if (!env || !allowedIntents.has(env.intent)) return 'intent not allowed';
      const roles = INTENT_ROLES[env.intent] ?? [];
      if (!roles.includes(env.role)) return 'role × intent denied';
      return undefined;
    },
  });

  ctx.effect(() => () => {
    // 插件卸载时无需额外清理：Peer 与请求生命周期绑定。
  }, 'business-bridge.lifetime');

  ctx.webServer.register({
    kind: 'exact',
    path: healthEndpoint,
    handler: (req, res) => {
      if (req.method !== 'GET' || !isTrustedSource(req.socket.remoteAddress, allowedSourceCidrs)) {
        return json(res, 404, { code: 'not_found' });
      }
      if (!authorized(req)) return json(res, authFailureStatus, { code: 'unauthorized', message: 'invalid bridge token' });
      let mcpTools = 0;
      try {
        const catalogue = ctx.get('tools')?.list?.();
        if (Array.isArray(catalogue)) mcpTools = catalogue.length;
      } catch {
        mcpTools = 0;
      }
      return json(res, 200, {
        status: 'ok',
        version: config.version ?? process.env.DSH_VERSION ?? 'unknown',
        preset,
        manifest_hash: manifestHash,
        mcp_tools: mcpTools,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        active_runs: activeRuns.size,
        active_run_ids: [...activeRuns.keys()],
        bridge: { principal: principalKind, role: principalRole, auth_failure_status: authFailureStatus },
      });
    },
  });

  ctx.webServer.register({
    kind: 'exact',
    path: endpoint,
    handler: (req, res) => {
      void handleRun(req, res);
    },
  });

  function authorized(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const token = currentToken();
    if (!token) return false;
    return constantTimeEqual(header.slice('Bearer '.length), token);
  }

  async function handleRun(req, res) {
    if (req.method !== 'POST' || !isTrustedSource(req.socket.remoteAddress, allowedSourceCidrs)) {
      return json(res, 404, { code: 'not_found' });
    }
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      return json(res, 404, { code: 'not_found' });
    }
    if (!authorized(req)) {
      return json(res, authFailureStatus, { code: 'unauthorized', message: 'invalid or expired bridge token' });
    }

    let envelope;
    try {
      envelope = JSON.parse(await readBody(req));
    } catch (error) {
      return json(res, 422, { code: 'validation_failed', message: error instanceof Error ? error.message : 'invalid json' });
    }
    if (!envelope || typeof envelope.runId !== 'string' || typeof envelope.intent !== 'string') {
      return json(res, 422, { code: 'validation_failed', message: 'runId/intent required' });
    }

    activeRuns.set(envelope.runId, { startedAt: Date.now(), intent: envelope.intent });
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    res.on('close', () => controller.abort());

    const peer = ctx.connection.createPeer({
      principal: { kind: principalKind, role: principalRole },
      interactions: 'none',
    });

    let events;
    try {
      events = await ctx.typertGateway.stream({
        namespace: 'businessAgent',
        method: 'run',
        args: { env: envelope },
        peer,
        signal: controller.signal,
      });
    } catch (error) {
      await peer.dispose();
      const code = error?.code ?? 'gateway/internal';
      const status = code === 'remote-access/denied' ? 403 : code === 'gateway/input-invalid' ? 422 : 502;
      return json(res, status, { code: code === 'remote-access/denied' ? 'forbidden' : 'upstream_5xx', message: error?.message ?? String(error) });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-run-id': envelope.runId,
      'x-dsh-host': config.version ?? 'unknown',
    });

    let sawTerminal = false;
    try {
      for await (const event of events) {
        if (controller.signal.aborted) break;
        if (!event || typeof event.type !== 'string') continue;
        if (event.type === 'final' || event.type === 'error') sawTerminal = true;
        if (!writeSse(res, event.type, event)) break;
        if (sawTerminal) break;
      }
      if (!sawTerminal && !controller.signal.aborted) {
        writeSse(res, 'error', {
          code: 'dsh_unavailable',
          message: 'businessAgent stream ended without final/error',
          retryable: true,
          nextAction: 'retry_later',
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        writeSse(res, 'error', {
          code: 'upstream_5xx',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          nextAction: 'retry_later',
        });
      }
    } finally {
      activeRuns.delete(envelope.runId);
      controller.abort();
      await peer.dispose();
      if (!res.writableEnded) res.end();
    }
  }
}

export const name = 'business-bridge';
export const inject = ['webServer', 'connection', 'typertGateway', 'remoteAccess'];
