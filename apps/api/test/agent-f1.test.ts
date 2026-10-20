/** t23 F1：按意图分档首 token 超时的纯单元测试（不需要 DB/Host）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { firstTokenTimeoutForIntent } from '../src/agent/intents.js';
import { RunRequestSchema } from '../src/agent/routes.js';

test('F1：首 token 默认分档 reply_draft=5000 / copy=8000 / 其他=8000，全局默认不变', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db?schema=public',
  });
  assert.equal(config.agentFirstTokenTimeoutMs, 8000);
  assert.equal(config.agentFirstTokenTimeoutReplyDraftMs, 5000);
  assert.equal(config.agentFirstTokenTimeoutCopyMs, 8000);
  const timeouts = {
    replyDraftMs: config.agentFirstTokenTimeoutReplyDraftMs,
    copyMs: config.agentFirstTokenTimeoutCopyMs,
    defaultMs: config.agentFirstTokenTimeoutMs,
  };
  assert.equal(firstTokenTimeoutForIntent('support.suggest', timeouts), 5000);
  assert.equal(firstTokenTimeoutForIntent('content.draft', timeouts), 8000);
  assert.equal(firstTokenTimeoutForIntent('content.rewrite', timeouts), 8000);
  assert.equal(firstTokenTimeoutForIntent('product.qa', timeouts), 8000);
  assert.equal(firstTokenTimeoutForIntent('inquiry.quote_draft', timeouts), 8000);
  assert.equal(firstTokenTimeoutForIntent('listing.diagnose', timeouts), 8000);
});

test('F1：请求字段 first_token_timeout_ms 只覆盖本次 run，并受 timeout_ms 约束', () => {
  const base = {
    intent: 'support.suggest',
    context: { page: 'inbox' },
    input: { text: '客户问退货怎么办' },
  };
  const parsed = RunRequestSchema.parse({ ...base, first_token_timeout_ms: 30000 });
  assert.equal(parsed.first_token_timeout_ms, 30000);
  assert.throws(() => RunRequestSchema.parse({ ...base, first_token_timeout_ms: 50 }));
  assert.throws(() => RunRequestSchema.parse({ ...base, first_token_timeout_ms: 90000 }));
});

test('F1：环境变量可覆盖 reply_draft / copy 档，全局默认仍独立', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db?schema=public',
    AGENT_FIRST_TOKEN_TIMEOUT_MS_REPLY_DRAFT: '6000',
    AGENT_FIRST_TOKEN_TIMEOUT_MS_COPY: '9000',
  });
  assert.equal(config.agentFirstTokenTimeoutReplyDraftMs, 6000);
  assert.equal(config.agentFirstTokenTimeoutCopyMs, 9000);
  assert.equal(config.agentFirstTokenTimeoutMs, 8000);
});
