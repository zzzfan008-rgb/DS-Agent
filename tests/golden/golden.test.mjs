/** 黄金集校验器自测：基线通过 + 三类篡改可被发现。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateGolden } from '../../scripts/qa/golden-check.mjs';
import { datasetHash } from './lib/dataset-hash.mjs';

const GOLDEN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.');

async function withCopy(fn) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dssaas-golden-'));
  await cp(GOLDEN_ROOT, temp, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}tools`) && !source.includes(`${path.sep}lib`),
  });
  try {
    return await fn(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function mutateJson(file, mutate) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  mutate(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function refreshLock(temp) {
  const lockFile = path.join(temp, 'golden.lock.json');
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  lock.dataset_sha256 = await datasetHash(temp);
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

test('当前黄金集基线通过', async () => {
  const summary = await validateGolden();
  assert.equal(summary.ok, true, summary.errors.join('\n'));
  assert.ok(summary.skus >= 10);
  assert.ok(summary.negatives >= 3);
  assert.ok(summary.expected_files >= 20);
});

test('篡改预期价格：版本锁第一时间发现', async () => {
  await withCopy(async (temp) => {
    await mutateJson(path.join(temp, 'expected/pdd/GOLDEN-001/copy.json'), (copy) => {
      copy.facts.price_cents += 100;
    });
    const summary = await validateGolden(temp);
    assert.equal(summary.ok, false);
    assert.ok(summary.errors.some((error) => error.includes('dataset_sha256')));
  });
});

test('篡改后同步更新版本锁：硬事实比对仍能发现', async () => {
  await withCopy(async (temp) => {
    await mutateJson(path.join(temp, 'expected/pdd/GOLDEN-001/copy.json'), (copy) => {
      copy.facts.stock_qty += 1;
    });
    await refreshLock(temp);
    const summary = await validateGolden(temp);
    assert.equal(summary.ok, false);
    assert.ok(summary.errors.some((error) => error.includes('facts.stock_qty')));
  });
});

test('负例规则失效（成分改回 100%）会被发现', async () => {
  await withCopy(async (temp) => {
    await mutateJson(path.join(temp, 'negative/NEG-001.json'), (negative) => {
      negative.sku.fabric.materials = [{ material: '棉', percent: 100 }];
    });
    await refreshLock(temp);
    const summary = await validateGolden(temp);
    assert.equal(summary.ok, false);
    assert.ok(summary.errors.some((error) => error.includes('负例成分合计')));
  });
});
