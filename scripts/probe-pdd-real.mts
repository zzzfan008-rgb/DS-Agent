/**
 * 真实网关连通性验证（手工执行，不进 CI）。
 *
 * 目的：证明探针确实能打到 gw-api.pinduoduo.com，且能把平台的真实错误
 * 分类成可诊断的结论——而不是"我们以为它应该返回什么"。
 *
 * 用法：
 *   npx tsx scripts/probe-pdd-real.mts                # 用无效凭据，验证签名错误路径可达
 *   PDD_CLIENT_ID=xx PDD_CLIENT_SECRET=yy PDD_ACCESS_TOKEN=zz \
 *     npx tsx scripts/probe-pdd-real.mts             # 用真实凭据，验证能否连上
 */
import { probePddConnection } from '../packages/adapters-pdd/src/http/pdd-probe.js';

const clientId = process.env.PDD_CLIENT_ID ?? 'invalid_client_id_for_probe';
const clientSecret = process.env.PDD_CLIENT_SECRET ?? 'invalid_secret_for_probe';
const accessToken = process.env.PDD_ACCESS_TOKEN ?? null;
const hasRealCreds = Boolean(process.env.PDD_CLIENT_ID && process.env.PDD_CLIENT_SECRET);

console.log(
  hasRealCreds
    ? '[probe] 使用环境变量中的真实凭据'
    : '[probe] 未提供真实凭据，使用无效值验证「签名/凭据错误」路径是否真实可达',
);

const result = await probePddConnection({
  clientId,
  clientSecret,
  accessToken,
  timeoutMs: 15_000,
});

console.log(
  JSON.stringify(
    {
      outcome: result.outcome,
      ok: result.ok,
      http_status: result.httpStatus,
      elapsed_ms: result.elapsedMs,
      gateway: result.gateway,
      api_type: result.apiType,
      error_code: result.errorCode,
      error_sub_code: result.errorSubCode,
      error_message: result.errorMessage,
      message: result.message,
      next_action: result.nextAction,
      raw_response: result.rawResponse,
    },
    null,
    2,
  ),
);
