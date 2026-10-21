'use client';

/**
 * 平台连接页浏览器侧读写封装（docs/13c §8）。
 *
 * 全部走同源 `/api/*`，沿用 m3-api 的 CSRF 双提交 + Idempotency-Key + If-Match。
 * 失败一律返回 `ApiFailure`（不吞错），由组件区分 401 / 403 / 404 / 409 / 400。
 */
import { getJson, mutateJson } from './m3-api';
import type {
  Platform,
  PlatformAccountCreateInput,
  PlatformAccountList,
  PlatformAccountMutation,
  PlatformAccountPatchInput,
  TestConnectivityResult,
} from './platform-types';

export async function fetchPlatformAccounts(platform?: Platform): Promise<PlatformAccountList> {
  const query = platform ? `?platform=${platform}` : '';
  const data = await getJson<PlatformAccountList>(`/api/platform-accounts${query}`);
  return { items: Array.isArray(data.items) ? data.items : [] };
}

export async function createPlatformAccount(
  input: PlatformAccountCreateInput,
): Promise<PlatformAccountMutation> {
  const result = await mutateJson<PlatformAccountMutation>('/api/platform-accounts', { body: input });
  if (!result.ok) throw result;
  return result.data;
}

/** 乐观锁：`If-Match: <version>`；版本不符后端回 409 conflict。 */
export async function patchPlatformAccount(
  id: string,
  input: PlatformAccountPatchInput,
  version: number,
): Promise<PlatformAccountMutation> {
  const result = await mutateJson<PlatformAccountMutation>(
    `/api/platform-accounts/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input, headers: { 'if-match': String(version) } },
  );
  if (!result.ok) throw result;
  return result.data;
}

/**
 * 测试连通。注意：**HTTP 200 + `ok:false` 是正常业务结果**（接口未核验），
 * 只有 HTTP 层失败才会走到 `throw`。调用方必须区分这两件事。
 */
export async function testPlatformAccount(id: string): Promise<TestConnectivityResult> {
  const result = await mutateJson<TestConnectivityResult>(
    `/api/platform-accounts/${encodeURIComponent(id)}/test`,
    {},
  );
  if (!result.ok) throw result;
  return result.data;
}

export async function archivePlatformAccount(id: string): Promise<{ id: string; archived: boolean }> {
  const result = await mutateJson<{ id: string; archived: boolean }>(
    `/api/platform-accounts/${encodeURIComponent(id)}/archive`,
    {},
  );
  if (!result.ok) throw result;
  return result.data;
}
