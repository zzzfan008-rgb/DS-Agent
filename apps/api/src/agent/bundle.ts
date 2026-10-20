/**
 * dsh-bundle 描述（seed 配置）读取。
 *
 * - 生产：`dsh-bundle/` 由镜像/卷只读挂载，api 启动时计算 manifest 哈希并核对 Host
 *   `/internal/health.manifest_hash`（docs/17 §9.1）。
 * - 开发/测试：找不到文件时退回固定种子值，不阻塞 API 启动；调用 `bundleDescriptor()`
 *   会带上 `verified=false` 供审计与排障。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundleSkill {
  name: string;
  version: string;
}

export interface BundleIntentConfig {
  bundle: string;
  skills: string[];
  modelRoute: string;
}

export interface BundleDescriptor {
  preset: string;
  bundleVersion: string;
  skills: BundleSkill[];
  manifestHash: string;
  /** true = 从真实 manifest.json 计算；false = 内置兜底常量。 */
  verified: boolean;
  path: string | null;
}

const FALLBACK: BundleDescriptor = {
  preset: 'clothing-ops',
  bundleVersion: '1.0.0',
  skills: [
    { name: 'brand-tone', version: '2.1.0' },
    { name: 'size-guide', version: '3.0.1' },
    { name: 'care', version: '1.1.0' },
    { name: 'return-policy', version: '1.3.0' },
  ],
  manifestHash: 'unverified',
  verified: false,
  path: null,
};

function candidateRoots(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots: string[] = [];
  if (process.env.DSH_BUNDLE_DIR) roots.push(resolve(process.env.DSH_BUNDLE_DIR));
  // apps/api/src/agent → repo root（开发源码运行）
  roots.push(resolve(here, '../../../..'));
  roots.push(resolve(process.cwd()));
  roots.push(resolve(process.cwd(), '../..'));
  return roots;
}

let cached: BundleDescriptor | null = null;

/** 读取 dsh-bundle 描述；同一进程内缓存。 */
export function bundleDescriptor(): BundleDescriptor {
  if (cached) return cached;
  for (const root of candidateRoots()) {
    const manifestPath = join(root, 'dsh-bundle', 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = readFileSync(manifestPath);
      const manifest = JSON.parse(raw.toString('utf8')) as {
        preset?: unknown;
        skillCatalog?: Array<{ name?: unknown; version?: unknown }>;
        intents?: Record<string, { bundle?: unknown }>;
      };
      const preset = typeof manifest.preset === 'string' ? manifest.preset : FALLBACK.preset;
      const firstIntent = manifest.intents ? Object.values(manifest.intents)[0] : undefined;
      const bundleVersion =
        typeof firstIntent?.bundle === 'string' ? firstIntent.bundle : FALLBACK.bundleVersion;
      const skills = Array.isArray(manifest.skillCatalog)
        ? manifest.skillCatalog
            .filter(
              (item): item is { name: string; version: string } =>
                typeof item?.name === 'string' && typeof item?.version === 'string',
            )
            .map((item) => ({ name: item.name, version: item.version }))
        : FALLBACK.skills;
      cached = {
        preset,
        bundleVersion,
        skills,
        manifestHash: createHash('sha256').update(raw).digest('hex'),
        verified: true,
        path: manifestPath,
      };
      return cached;
    } catch {
      // manifest 非法：继续找下一个根，最终回退常量；健康检查会暴露 unverified。
    }
  }
  cached = { ...FALLBACK };
  return cached;
}

/** 测试用：清除缓存。 */
export function resetBundleDescriptorForTests(): void {
  cached = null;
}

/** 按 intent 取 bundle 内的 skill 列表（manifest 未配置时返回该 intent 的默认 skill）。 */
export function skillsForIntent(intent: string): string[] {
  const descriptor = bundleDescriptor();
  try {
    for (const root of candidateRoots()) {
      const manifestPath = join(root, 'dsh-bundle', 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        intents?: Record<string, { skills?: unknown }>;
      };
      const entry = manifest.intents?.[intent];
      if (Array.isArray(entry?.skills)) {
        return entry.skills.filter((item): item is string => typeof item === 'string');
      }
      break;
    }
  } catch {
    // 回退下面
  }
  return descriptor.skills.map((skill) => `${skill.name}@${skill.version}`);
}
