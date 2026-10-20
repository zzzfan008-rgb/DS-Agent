/**
 * 变更工单 frontmatter 的极简读写（只支持本仓库自产的 YAML 子集）。
 *
 * 支持：`key: "value"` / `key: 123` / `key: true` / `key: ["a","b"]`。
 * 不支持嵌套对象与多行字符串——工单结构由脚本生成，避免手写偏差。
 */

import { readFile } from 'node:fs/promises';
import { readTextIfExists, writeTextAtomic } from './common.mjs';

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      if (value.startsWith('[') && value.endsWith(']')) {
        return value
          .slice(1, -1)
          .split(',')
          .map((item) => parseScalar(item))
          .filter((item) => item !== '');
      }
      return value;
    }
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

/** @returns {{ data: Record<string, unknown>, body: string, hasFrontmatter: boolean }} */
export function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized, hasFrontmatter: false };
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return { data: {}, body: normalized, hasFrontmatter: false };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n/, '');
  const data = {};
  for (const line of header.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    data[key] = parseScalar(trimmed.slice(colon + 1));
  }
  return { data, body, hasFrontmatter: true };
}

function serializeValue(value) {
  if (Array.isArray(value) || (value !== null && typeof value === 'object')) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

export function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${serializeValue(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function replaceFrontmatter(text, data) {
  const parsed = parseFrontmatter(text);
  return `${serializeFrontmatter(data)}${parsed.body.replace(/^\n+/, '')}`;
}

export async function readTicket(file) {
  const text = await readTextIfExists(file);
  if (text === null) return null;
  return { file, text, ...parseFrontmatter(text) };
}

export async function writeTicket(file, data, body) {
  const text = `${serializeFrontmatter(data)}${body.replace(/^\n+/, '')}\n`;
  await writeTextAtomic(file, text);
  return text;
}

export async function appendTicketSection(file, heading, lines) {
  const text = await readFile(file, 'utf8');
  const parsed = parseFrontmatter(text);
  const suffix = `\n## ${heading}\n\n${lines.join('\n')}\n`;
  await writeTextAtomic(file, `${serializeFrontmatter(parsed.data)}${parsed.body.replace(/\n+$/, '')}\n${suffix}`);
}
