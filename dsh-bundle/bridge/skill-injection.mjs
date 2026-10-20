/**
 * skill 前置注入（t23 F1）：把 intent 需要的 skill 正文直接拼进 Host prompt，
 * 省掉 `tool-skill` 的两次工具往返（真实 Host 实测约 7s）。
 *
 * 设计：
 * - 映射来源优先 `skillInjection.intentSkills`（bridge 配置），否则读 dsh-bundle/manifest.json
 *   的 `intents[intent].skills`（`name@version`），避免两处漂移；
 * - `enabledIntents` 控制哪些意图开启，默认只开 `support.suggest`（reply_draft）；
 * - 可整体 `enabled:false` 回退到工具加载；
 * - 只读工作区文件，路径必须落在 skillRoot 内；支持热更新（按 mtime/size 缓存）；
 * - 注入文本只含 SKILL.md 正文（去 frontmatter），每 skill / 总字节可配上限。
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_INTENTS = ['support.suggest'];
const DEFAULT_MAX_SKILL_BYTES = 20_000;
const DEFAULT_MAX_TOTAL_BYTES = 30_000;

const cache = new Map();

function bridgeDir() {
  return fileURLToPath(new URL('.', import.meta.url));
}

function readCached(path) {
  const stat = statSync(path);
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const raw = readFileSync(path, 'utf8');
  cache.set(key, raw);
  return raw;
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function estimateTokens(text) {
  // 与 apps/api 的工程口径一致：中文约 1.6 字/token；仅用于观测，不用于计费。
  return Math.max(1, Math.ceil([...text].length / 1.6));
}

function normalizeRoot(config) {
  const root = config.skillRoot
    ? resolve(config.skillRoot)
    : resolve(bridgeDir(), '..', 'skills');
  return root;
}

function parseSkillRef(ref) {
  const trimmed = String(ref).trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) throw new Error(`skill 引用应为 name@version：${trimmed}`);
  return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) };
}

function loadManifest(config) {
  const path = config.manifestFile
    ? resolve(config.manifestFile)
    : resolve(bridgeDir(), '..', 'manifest.json');
  const raw = readCached(path);
  return { path, manifest: JSON.parse(raw) };
}

function resolveIntentSkills(intent, config, manifest) {
  const direct = config.intentSkills?.[intent];
  if (Array.isArray(direct)) return direct;
  return manifest?.intents?.[intent]?.skills ?? [];
}

/**
 * 读取某 intent 需要前置注入的 skill。
 * 返回 null 表示不注入（未开启 / 意图不在白名单 / 无映射）。
 */
export function loadInjectedSkills(intent, config = {}) {
  if (!config || config.enabled === false) return null;
  const enabledIntents = Array.isArray(config.enabledIntents) ? config.enabledIntents : DEFAULT_INTENTS;
  if (!enabledIntents.includes(intent)) return null;

  const { manifest, path: manifestPath } = loadManifest(config);
  const refs = resolveIntentSkills(intent, config, manifest);
  if (!Array.isArray(refs) || refs.length === 0) return null;

  const root = normalizeRoot(config);
  const maxSkillBytes = Number.isFinite(config.maxSkillBytes)
    ? config.maxSkillBytes
    : DEFAULT_MAX_SKILL_BYTES;
  const maxTotalBytes = Number.isFinite(config.maxTotalBytes)
    ? config.maxTotalBytes
    : DEFAULT_MAX_TOTAL_BYTES;

  const skills = [];
  let totalBytes = 0;
  for (const ref of refs) {
    const { name, version } = parseSkillRef(ref);
    const path = resolve(root, name, version, 'SKILL.md');
    if (!path.startsWith(root + sep) && path !== root) {
      throw new Error(`skill 路径越界：${path}`);
    }
    const body = stripFrontmatter(readCached(path));
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxSkillBytes) {
      throw new Error(`skill ${ref} 超过单文件上限 ${maxSkillBytes} bytes（实际 ${bytes}）`);
    }
    if (totalBytes + bytes > maxTotalBytes) {
      throw new Error(`前置注入超过总上限 ${maxTotalBytes} bytes`);
    }
    totalBytes += bytes;
    skills.push({ ref, name, version, path, body, bytes, tokensEstimate: estimateTokens(body) });
  }

  const heading =
    '\n\n## 已预加载 Skills（系统注入，直接遵循）\n' +
    '以下 skill 正文已完整注入，不需要再调用 skill 工具加载这些 skill；只有需要未列出的 skill 时才调用工具。\n' +
    `manifest: ${manifestPath}\n`;
  const text =
    heading +
    skills
      .map((skill) => `\n### ${skill.name}@${skill.version}\n${skill.body}\n`)
      .join('');
  return {
    intent,
    skills: skills.map(({ ref, name, version, path, bytes, tokensEstimate }) => ({
      ref,
      name,
      version,
      path,
      bytes,
      tokens_estimate: tokensEstimate,
    })),
    text,
    bytes: totalBytes,
    tokens_estimate: estimateTokens(text),
    source: 'preinjected',
  };
}

/** 测试/观测辅助：清空文件缓存。 */
export function clearSkillInjectionCache() {
  cache.clear();
}
