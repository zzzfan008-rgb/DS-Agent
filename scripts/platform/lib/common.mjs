/**
 * 契约漂移监测脚本的公共工具（零依赖，Node >= 22）。
 *
 * 只做文件、哈希、时间与参数解析；不 import 业务代码，避免脚本与 adapter 双向耦合。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DATA_DIR = path.join(REPO_ROOT, 'data');
export const NOTICES_DIR = path.join(DATA_DIR, 'notices');
export const TICKETS_DIR = path.join(REPO_ROOT, 'docs', '变更工单');
export const TICKET_INDEX_FILE = path.join(TICKETS_DIR, 'index.json');
export const INTERFACE_TEST_MAP_FILE = path.join(REPO_ROOT, 'scripts', 'platform', 'interface-test-map.json');

/** 上海时区固定偏移（无夏令时）。公告时间未带时区，按 +08:00 解释。 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function nowIso(clock = Date.now) {
  return new Date(clock()).toISOString();
}

export function relToRepo(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

/** 解析公告时间：支持 "YYYY-MM-DD HH:mm:ss"（按 +08:00）、ISO 带 Z/偏移、date-only。 */
export function toShanghaiIso(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00+08:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return `${value}+08:00`;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return formatShanghaiIso(parsed);
}

export function formatShanghaiIso(ms) {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function displayShanghai(iso) {
  if (typeof iso !== 'string' || iso.length < 19) return '';
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export function dateOf(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

export function addDaysIso(iso, days) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`非法时间：${iso}`);
  return new Date(ms + days * 86_400_000).toISOString();
}

export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readJsonIfExists(file) {
  const text = await readTextIfExists(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 解析失败：${relToRepo(file)}（${/** @type {Error} */ (error).message}）`);
  }
}

export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

export async function writeJson(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeSha256(file, hash, targetName) {
  await writeTextAtomic(file, `${hash}  ${targetName}\n`);
}

/** 简单参数解析：`--key value`、`--key=value`、布尔开关。 */
export function parseArgs(argv, { booleans = [] } = {}) {
  const flags = Object.create(null);
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey.trim();
    if (booleans.includes(key)) {
      flags[key] = inlineValue === undefined ? true : !['0', 'false', 'no'].includes(inlineValue);
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (next === undefined || (inlineValue === undefined && next.startsWith('--'))) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    flags[key] = next;
    if (inlineValue === undefined) index += 1;
  }
  return { flags, positional };
}

export function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, name = '参数' } = {}) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 的整数，实际 ${value}`);
  }
  return number;
}

export function fail(message, exitCode = 1) {
  console.error(`[error] ${message}`);
  process.exitCode = exitCode;
  return null;
}
