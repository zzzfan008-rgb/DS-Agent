import assert from 'node:assert/strict';
import test from 'node:test';
import { isPddError } from '../src/errors.js';
import { TokenBucketLimiter } from '../src/http/rate-limiter.js';
import { FakeClock } from './helpers.js';

test('令牌桶：qps=2 burst=2，前两次立即，第三次等待 500ms', async () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketLimiter({ qps: 2, burst: 2, clock: clock.now, sleep: clock.sleep });
  assert.equal(await limiter.acquire('test.echo'), 0);
  assert.equal(await limiter.acquire('test.echo'), 0);
  assert.equal(await limiter.acquire('test.echo'), 500);
  assert.deepEqual(clock.waits, [500]);
});

test('令牌桶：qps=1 burst=1，第二次等待 1000ms，不同 key 互不影响', async () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketLimiter({ qps: 1, burst: 1, clock: clock.now, sleep: clock.sleep });
  assert.equal(await limiter.acquire('a'), 0);
  assert.equal(await limiter.acquire('a'), 1_000);
  assert.equal(await limiter.acquire('b'), 0);
  assert.deepEqual(clock.waits, [1_000]);
});

test('排队等待超过 maxQueueWaitMs 立即 rate_limited，并回滚预占', async () => {
  const clock = new FakeClock();
  const limiter = new TokenBucketLimiter({ qps: 1, burst: 1, maxQueueWaitMs: 500, clock: clock.now, sleep: clock.sleep });
  assert.equal(await limiter.acquire('x'), 0);
  await assert.rejects(
    () => limiter.acquire('x'),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      assert.equal((error as { code: string }).code, 'rate_limited');
      assert.equal((error as { retryAfterMs: number }).retryAfterMs, 1_000);
      return true;
    },
  );
  // 预占已回滚：把时钟推进 1s 后应可再次获取
  clock.advance(1_000);
  assert.equal(await limiter.acquire('x'), 0);
});

test('并发 3 个请求排队拉开，不会同时穿透', async () => {
  const clock = { current: 0 };
  const waits: number[] = [];
  const sleep = (ms: number): Promise<void> =>
    Promise.resolve().then(() => {
      waits.push(ms);
      clock.current += ms;
    });
  const limiter = new TokenBucketLimiter({ qps: 1, burst: 1, clock: () => clock.current, sleep });
  const results = await Promise.all([limiter.acquire('k'), limiter.acquire('k'), limiter.acquire('k')]);
  assert.equal(results[0], 0);
  assert.equal(waits.length, 2);
  assert.ok((waits[0] ?? 0) >= 1_000);
  assert.ok((waits[1] ?? 0) >= 2_000);
});
