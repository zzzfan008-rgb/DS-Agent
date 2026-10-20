/** L3 契约回放（骨架）：fixture 结构/脱敏/回放/Schema/错误映射。 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadFixtures,
  loadFixtureSchema,
  fixtureHash,
  validateFixture,
} from './lib/fixtures.mjs';
import { validateSchema } from './lib/schema.mjs';
import { startReplayServer, replayFixture } from './lib/replay.mjs';
import { loadErrorMap, resolveError } from './lib/error-map.mjs';
import { loadDocErrorCodes } from './lib/doc-codes.mjs';

let fixtures;
let server;

before(async () => {
  fixtures = await loadFixtures();
  server = await startReplayServer(fixtures);
});

after(async () => {
  await server.close();
});

test('fixture 数量与平台覆盖', () => {
  assert.ok(fixtures.length >= 5, `fixture 至少 5 条，实际 ${fixtures.length}`);
  const platforms = new Set(fixtures.map(({ fixture }) => fixture.meta.platform));
  assert.deepEqual([...platforms].sort(), ['1688', 'pdd']);
});

test('fixture 结构合法且敏感字段已脱敏', () => {
  const errors = fixtures.flatMap(({ file, fixture }) => validateFixture(fixture, { file }));
  assert.deepEqual(errors, []);
});

test('未脱敏的敏感字段会被拒绝', () => {
  const bad = structuredClone(fixtures[0].fixture);
  bad.request.query.sign = 'raw-secret-signature';
  const errors = validateFixture(bad, { file: 'bad.json' });
  assert.ok(errors.some((error) => error.includes('sign') && error.includes('未脱敏')));
});

test('fixture 哈希稳定且可复算', () => {
  const [first] = fixtures;
  assert.equal(fixtureHash(first.fixture), fixtureHash(structuredClone(first.fixture)));
  const mutated = structuredClone(first.fixture);
  mutated.response.body.success = false;
  assert.notEqual(fixtureHash(first.fixture), fixtureHash(mutated));
});

test('每条 fixture 都能在本地回放服务器上回放（禁止真实网络）', async () => {
  assert.equal(new URL(server.baseUrl).hostname, '127.0.0.1');
  for (const { file, fixture } of fixtures) {
    const replay = await replayFixture(fixture, server);
    assert.equal(replay.status, fixture.response.status, `${file}: status 不一致`);
    assert.deepEqual(replay.body, fixture.response.body, `${file}: body 不一致`);
  }
  assert.deepEqual(server.unmatched, []);
});

test('成功响应通过 JSON Schema 校验', async () => {
  for (const { file, fixture } of fixtures) {
    const loaded = await loadFixtureSchema(fixture);
    if (!loaded) continue;
    const errors = validateSchema(fixture.response.body, loaded.schema);
    assert.deepEqual(errors, [], `${file}: ${errors.join('; ')}`);
  }
});

test('Schema 能发现字段漂移（缺字段 / 类型变化）', async () => {
  const success = fixtures.find(({ fixture }) => fixture.meta.endpoint === 'item.add');
  const { schema } = await loadFixtureSchema(success.fixture);

  const missing = structuredClone(success.fixture.response.body);
  delete missing.result.goods_id;
  assert.ok(validateSchema(missing, schema).some((error) => error.includes('goods_id')));

  const wrongType = structuredClone(success.fixture.response.body);
  wrongType.result.goods_id = 12345;
  assert.ok(validateSchema(wrongType, schema).some((error) => error.includes('期望类型 string')));
});

test('未知路由不被回放（防止夹具缺失时误连真实平台）', async () => {
  const before = server.unmatched.length;
  const ghost = {
    request: { method: 'GET', path: '/unmatched', query: {}, headers: {} },
    response: { status: 200, headers: {}, body: {} },
  };
  const replay = await replayFixture(ghost, server);
  assert.equal(replay.status, 501);
  assert.equal(server.unmatched.length, before + 1);
});

test('错误 fixture 全部能映射，且 external code 在 docs/12 §4 词表内', async () => {
  const errorMap = await loadErrorMap();
  const docCodes = await loadDocErrorCodes();
  assert.ok(docCodes.size >= 22, `docs/12 错误码应 ≥22，实际 ${docCodes.size}`);

  const errorFixtures = fixtures.filter(({ fixture }) => fixture.expected_error);
  assert.ok(errorFixtures.length >= 3, '错误 fixture 至少 3 条');

  for (const { file, fixture } of errorFixtures) {
    const resolved = resolveError(errorMap, fixture.meta.platform, fixture.response);
    assert.ok(resolved, `${file}: error-map 未覆盖`);
    assert.equal(resolved.entry.internal, fixture.expected_error.internal, `${file}: internal 不一致`);
    assert.equal(resolved.entry.external, fixture.expected_error.external, `${file}: external 不一致`);
    assert.ok(docCodes.has(resolved.entry.external), `${file}: ${resolved.entry.external} 不在 docs/12 §4`);
  }
});

test('error-map 不含 docs/12 之外的对外 code', async () => {
  const errorMap = await loadErrorMap();
  const docCodes = await loadDocErrorCodes();
  for (const [platform, entries] of Object.entries(errorMap.platforms)) {
    for (const entry of entries) {
      assert.ok(docCodes.has(entry.external), `${platform}/${entry.id}: ${entry.external} 不在 docs/12 §4`);
      const doc = docCodes.get(entry.external);
      if (entry.id.includes('upstream_5xx')) assert.equal(doc.retryable, '是');
    }
  }
});
