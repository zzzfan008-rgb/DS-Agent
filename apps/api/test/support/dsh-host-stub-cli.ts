/**
 * 本地 DSH Host 协议桩 CLI（t3 验收用）。
 *
 *   pnpm --filter @dssaas/api exec tsx test/support/dsh-host-stub-cli.ts \
 *     --port 43180 --token-file .tmp/bridge-token --scenario echo
 *
 * 输出一行 `[dsh-host-stub] ready …` 后常驻；SIGINT/SIGTERM 退出。
 */
import { parseArgs } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { startDshHostStub, type StubScenario } from './dsh-host-stub.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '43180' },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    'token-file': { type: 'string' },
    scenario: { type: 'string', default: 'echo' },
    'fail-mode': { type: 'string', default: 'none' },
    'delta-count': { type: 'string', default: '4' },
    'delta-delay': { type: 'string', default: '25' },
    'first-token-delay': { type: 'string', default: '0' },
    'manifest-file': { type: 'string' },
    'emit-queued': { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const token = values.token ?? 'dev-bridge-token-0123456789abcdef';
const tokenFile = values['token-file'];
if (tokenFile) {
  mkdirSync(dirname(tokenFile), { recursive: true });
}

const handle = await startDshHostStub({
  host: values.host,
  port: Number(values.port),
  token,
  tokenFile,
  scenario: values.scenario as StubScenario,
  failMode: values['fail-mode'] as 'none' | 'unavailable' | 'http500' | 'reject-token',
  emitQueued: values['emit-queued'],
  deltaCount: Number(values['delta-count']),
  deltaDelayMs: Number(values['delta-delay']),
  firstTokenDelayMs: Number(values['first-token-delay']),
  manifestFile: values['manifest-file'],
  quiet: values.quiet,
});

console.log(`[dsh-host-stub] liveness pid=${process.pid} url=${handle.url}`);
if (!tokenFile) console.log(`[dsh-host-stub] token=${token}`);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[dsh-host-stub] ${signal} received, closing`);
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
