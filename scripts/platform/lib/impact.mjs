/**
 * 公告 → 影响面 / 回归测试映射。
 *
 * 规则来源：
 * - docs/01 §6.3 / docs/02 §6.3 的 P0/P1/P2 分级与关键词路由；
 * - `scripts/platform/interface-test-map.json` 的接口 → 文档条目 / 测试文件映射。
 *
 * 映射不到时**不静默**：使用平台默认接口与默认测试，并在工单里标注 `mapping_fallback=true`。
 */

import { readJsonIfExists, INTERFACE_TEST_MAP_FILE } from './common.mjs';

let cachedMap = null;

export async function loadInterfaceTestMap() {
  if (cachedMap === null) {
    cachedMap = await readJsonIfExists(INTERFACE_TEST_MAP_FILE);
    if (!cachedMap || !cachedMap.platforms) {
      throw new Error(`接口测试映射缺失或非法：${INTERFACE_TEST_MAP_FILE}`);
    }
  }
  return cachedMap;
}

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 };

function worse(a, b) {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/**
 * @param {{ platform: string, title: string, categoryCode?: number|string|null, category?: string|null }} input
 */
export async function resolveImpact(input) {
  const map = await loadInterfaceTestMap();
  const platform = map.platforms[input.platform];
  if (!platform) throw new Error(`interface-test-map 未配置平台：${input.platform}`);

  const interfaceDefs = platform.interfaces ?? {};
  const allInterfaces = Object.keys(interfaceDefs);
  const title = String(input.title ?? '');
  const categoryKey = String(input.categoryCode ?? '');
  let severity = platform.severity_by_category?.[categoryKey] ?? 'P1';

  const interfaces = new Set();
  const docRefs = new Set();
  const tests = new Set(platform.default_tests ?? []);
  const matchedRoutes = [];

  for (const route of platform.routes ?? []) {
    const hit = (route.match ?? []).some((keyword) => title.includes(keyword));
    if (!hit) continue;
    matchedRoutes.push(route.id);
    severity = worse(severity, route.severity ?? 'P1');
    for (const key of route.interfaces ?? []) {
      if (key === '__all__') {
        for (const item of allInterfaces) interfaces.add(item);
        continue;
      }
      interfaces.add(key);
    }
    for (const test of route.extra_tests ?? []) tests.add(test);
  }

  const fallback = interfaces.size === 0;
  if (fallback) {
    for (const key of platform.default_interfaces ?? allInterfaces.slice(0, 3)) interfaces.add(key);
  }

  for (const key of interfaces) {
    const def = interfaceDefs[key];
    if (def?.doc_ref) docRefs.add(def.doc_ref);
    for (const test of def?.tests ?? []) tests.add(test);
    if (!def) docRefs.add(`${platform.doc} §2（未登记接口，需人工确认）`);
  }

  const p0Hit = (platform.p0_keywords ?? []).find((keyword) => title.includes(keyword));
  if (p0Hit) severity = 'P0';
  else if (severity !== 'P0') {
    const p2Hit = (platform.p2_keywords ?? []).find((keyword) => title.includes(keyword));
    if (p2Hit) severity = 'P2';
  }

  return {
    platform: input.platform,
    package: platform.package,
    test_command: platform.test_command,
    severity,
    interfaces: [...interfaces],
    doc_refs: [...docRefs],
    tests: [...tests],
    matched_routes: matchedRoutes,
    fallback,
    mapping_source: 'scripts/platform/interface-test-map.json',
  };
}
