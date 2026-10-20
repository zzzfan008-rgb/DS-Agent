/**
 * 黄金集数据集哈希（generator 与 validator 共用，防止口径漂移）。
 *
 * 对 skus/、expected/、negative/ 下的文件按路径排序，逐个内容拼接后 sha256。
 * 不包含 golden.lock.json 自身。
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const HASH_DIRS = ['skus', 'expected', 'negative'];

async function walk(base, relDir = '') {
  let entries;
  try {
    entries = await readdir(path.join(base, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await walk(base, rel)));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

export async function datasetFiles(root) {
  const files = [];
  for (const dir of HASH_DIRS) {
    for (const rel of await walk(root, dir)) files.push(rel);
  }
  return files.sort();
}

export async function datasetHash(root) {
  const hash = createHash('sha256');
  for (const rel of await datasetFiles(root)) {
    const content = await readFile(path.join(root, rel), 'utf8');
    hash.update(rel.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
