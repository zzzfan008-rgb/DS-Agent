import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  PlaceholderHmacSha256Signer,
  PLACEHOLDER_SIGNATURE_SCHEME,
  SIGNATURE_HEADERS,
  TimestampReplayGuard,
  buildPlaceholderSignatureMaterial,
  computePlaceholderSignature,
  computeSha256Hex,
  reserveOutboundNonce,
} from '../src/http/signer.js';

const context = {
  method: 'POST',
  path: '/synthetic/test/echo',
  bodyText: '{"message":"hello-pdd","n":1}',
  timestampMs: 1_700_000_000_000,
  nonce: 'nonce-0123456789abcdef',
  appKey: 'test-app-key',
  appSecret: 'test-app-secret',
  accessToken: 'test-access-token',
} as const;

test('占位签名的材料与 HMAC 可被独立复算（防实现漂移）', () => {
  const material = buildPlaceholderSignatureMaterial(context);
  assert.equal(
    material,
    [
      'POST',
      '/synthetic/test/echo',
      '1700000000000',
      'nonce-0123456789abcdef',
      computeSha256Hex(context.bodyText),
    ].join('\n'),
  );
  const expected = createHmac('sha256', context.appSecret).update(material, 'utf8').digest('hex');
  assert.equal(computePlaceholderSignature(context), expected);
  assert.equal(computePlaceholderSignature(context).length, 64);
});

test('签名头包含 app key/timestamp/nonce/signature，且不含 secret 明文', () => {
  const signer = new PlaceholderHmacSha256Signer();
  const headers = signer.sign(context);
  assert.equal(headers[SIGNATURE_HEADERS.appKey], 'test-app-key');
  assert.equal(headers[SIGNATURE_HEADERS.timestamp], '1700000000000');
  assert.equal(headers[SIGNATURE_HEADERS.nonce], context.nonce);
  assert.equal(headers[SIGNATURE_HEADERS.scheme], PLACEHOLDER_SIGNATURE_SCHEME);
  assert.equal(headers[SIGNATURE_HEADERS.accessToken], 'test-access-token');
  assert.equal(headers[SIGNATURE_HEADERS.signature], computePlaceholderSignature(context));
  assert.equal(JSON.stringify(headers).includes(context.appSecret), false);
});

test('时间戳窗口：过旧/未来都拒绝，窗口内通过', () => {
  let now = 1_700_000_000_000;
  const guard = new TimestampReplayGuard({ windowMs: 60_000, clock: () => now });
  assert.equal(guard.check(now, 'n1').ok, true);
  const expired = guard.check(now - 60_001, 'n2');
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false ? expired.reason : null, 'expired');
  const future = guard.check(now + 60_001, 'n3');
  assert.equal(future.ok, false);
  assert.equal(future.ok === false ? future.reason : null, 'future');

  now += 1_000;
  assert.equal(guard.check(now - 59_000, 'n4').ok, true);
});

test('nonce 在窗口内只能使用一次', () => {
  const now = 1_700_000_000_000;
  const guard = new TimestampReplayGuard({ windowMs: 60_000, clock: () => now });
  assert.equal(guard.check(now, 'dup-nonce').ok, true);
  const replay = guard.check(now, 'dup-nonce');
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false ? replay.reason : null, 'replayed');
  assert.equal(guard.check(now, '').ok, false);
});

test('过期 nonce 被清理后可再次使用；maxEntries 生效', () => {
  let now = 1_000;
  const guard = new TimestampReplayGuard({ windowMs: 1_000, clock: () => now });
  assert.equal(guard.check(now, 'a').ok, true);
  assert.equal(guard.size, 1);
  now += 1_001;
  assert.equal(guard.size, 0);
  assert.equal(guard.check(now, 'a').ok, true);

  const capped = new TimestampReplayGuard({ windowMs: 1_000_000, clock: () => now, maxEntries: 2 });
  assert.equal(capped.check(now, 'x1').ok, true);
  assert.equal(capped.check(now, 'x2').ok, true);
  assert.equal(capped.check(now, 'x3').ok, true);
  assert.equal(capped.size, 2);
});

test('出站 nonce 每次不同且时间戳来自注入时钟', () => {
  const clock = { now: 1_700_000_000_000 };
  const guard = new TimestampReplayGuard({ windowMs: 60_000, clock: () => clock.now });
  const first = reserveOutboundNonce(guard, () => clock.now);
  const second = reserveOutboundNonce(guard, () => clock.now);
  assert.equal(first.timestampMs, clock.now);
  assert.equal(second.timestampMs, clock.now);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(first.nonce.length, 32);
  assert.equal(guard.check(clock.now, first.nonce).ok, false);
});
