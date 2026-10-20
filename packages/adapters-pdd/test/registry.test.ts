import assert from 'node:assert/strict';
import test from 'node:test';
import { isPddError } from '../src/errors.js';
import { pddRegistry } from '../src/registry/index.js';
import { PDD_INTERFACES } from '../src/registry/pdd-interfaces.js';

test('注册表覆盖 docs/01 §2.1–§2.6 全部 28 条能力', () => {
  const stats = pddRegistry.stats();
  assert.equal(stats.total, 28);
  assert.deepEqual(stats.by_section, { '2.1': 6, '2.2': 3, '2.3': 3, '2.4': 6, '2.5': 5, '2.6': 5 });
  assert.equal(stats.write, 14);
  assert.equal(stats.read, 14);
  assert.equal(new Set(PDD_INTERFACES.map((entry) => entry.key)).size, 28);
});

test('全部接口未核验：method/version/path 为 null，禁止编造平台事实', () => {
  for (const entry of PDD_INTERFACES) {
    assert.equal(entry.verification, 'unverified', entry.key);
    assert.equal(entry.platform_method, null, entry.key);
    assert.equal(entry.platform_version, null, entry.key);
    assert.equal(entry.path_template, null, entry.key);
    assert.equal(entry.last_verified_at, null, entry.key);
    assert.equal(entry.verified_by, null, entry.key);
  }
  const stats = pddRegistry.stats();
  assert.equal(stats.verified, 0);
  assert.equal(stats.unverified, 28);
});

test('每条 TODO 非空且能指回 docs/01 行号', () => {
  for (const entry of PDD_INTERFACES) {
    assert.match(entry.doc_ref, /^docs\/01 §2\.\d 第\d+行$/, entry.key);
    assert.equal(entry.todos.method.startsWith('待填：'), true, entry.key);
    for (const [field, value] of Object.entries(entry.todos)) {
      assert.equal(typeof value === 'string' && value.trim().length > 0, true, `${entry.key}.${field}`);
    }
    assert.equal(entry.conclusion_raw.trim().length > 0, true, entry.key);
  }
});

test('未核验接口调用被拒绝，错误带 fallback 与 doc_ref', () => {
  assert.throws(
    () => pddRegistry.requireCallable('product.publish'),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      const pddError = error as { code: string; detail: Record<string, unknown> };
      assert.equal(pddError.code, 'unverified_interface');
      assert.equal(pddError.detail.fallback, 'listing_package');
      assert.equal(pddError.detail.doc_ref, 'docs/01 §2.1 第1行');
      assert.deepEqual(pddError.detail.missing, ['verification', 'platform_method', 'platform_version', 'path_template']);
      return true;
    },
  );
});

test('未注册接口给出 interface_not_registered', () => {
  assert.throws(
    () => pddRegistry.require('product.not_exists'),
    (error: unknown) => isPddError(error) && error.code === 'interface_not_registered',
  );
});

test('未自动化接口清单是一等交付物：28 条全部列出，写接口有导入包兜底', () => {
  const rows = pddRegistry.unverifiedReport();
  assert.equal(rows.length, 28);
  for (const row of rows) {
    assert.equal(row.reason, 'method_unverified');
    assert.equal(row.review_date, null);
    assert.ok(row.owner.includes('平台接入负责人'));
    assert.ok(row.todo.startsWith('待填：'));
  }
  const publish = rows.find((row) => row.key === 'product.publish');
  assert.ok(publish);
  assert.equal(publish.fallback, 'listing_package');
  const send = rows.find((row) => row.key === 'message.send');
  assert.ok(send);
  assert.equal(send.fallback, 'manual_workbench');
});

test('危险写操作级别来自 docs/11 动作注册表', () => {
  const price = pddRegistry.require('price.sku_update');
  assert.equal(price.operation_level, 'C');
  assert.equal(price.action_code, 'listing.update_price');
  const stock = pddRegistry.require('stock.update');
  assert.equal(stock.operation_level, 'A');
  const publish = pddRegistry.require('product.publish');
  assert.equal(publish.operation_level, 'B');
  assert.equal(publish.action_code, 'listing.create');
});
