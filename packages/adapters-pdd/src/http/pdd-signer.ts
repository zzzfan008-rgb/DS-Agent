/**
 * 拼多多开放平台真实签名实现（MD5）。
 *
 * 依据（官方文档原文，2026-10-21 从 open.pinduoduo.com 抓取）：
 *   基础文档 → 开发文档 → API调用详解
 *   https://open.pinduoduo.com/application/document/browse?idStr=8EC06C399636041E
 *
 * 原文算法四步：
 *   1) 本次请求中所有请求参数（包含公共参数与业务参数）进行首字母以 ASCII 方式
 *      升序排列（ASCII ASC），对于相同字母则使用下个字母做二次排序，字母序为从
 *      左到右，以此类推；
 *   2) 排序后的结果按照参数名（key）参数值（value）的次序进行字符串拼接，
 *      拼接处不包含任何字符；
 *   3) 拼接完成的字符串做进一步拼接成 1 个字符串（包含所有 kv 字符串的长串），
 *      并在该长串的头部及尾部分别拼接 client_secret，完成签名字符串的组装；
 *   4) 最后对签名字符串，使用 MD5 算法加密后，得到的 MD5 加密密文后转为大写，
 *      即为 sign 值。
 *
 * 官方示例（本文件测试逐字节断言）：
 *   client_secret = testSecret
 *   参数 access_token=asd78172s8ds9a921j9qqwda12312w1w21211, client_id=1,
 *        data_type=XML, order_status=1, page=1, page_size=10,
 *        timestamp=1480411125, type=pdd.order.number.list.get
 *   → sign = E4DE3ED21002510DED352819E7AE6775
 *
 * 网关：https://gw-api.pinduoduo.com/api/router（POST，content-type: application/json，
 * 所有参数（含 sign）放在 JSON body 里）。
 */

import { createHash } from 'node:crypto';

/** 拼多多开放平台正式环境网关（官方文档「请求地址」一节）。 */
export const PDD_GATEWAY = 'https://gw-api.pinduoduo.com/api/router';

/** 签名方案标识：核验后由占位方案升级到此方案。 */
export const PDD_SIGNATURE_SCHEME = 'pdd-md5-v1';

/**
 * 参与签名的参数值类型。
 *
 * 官方文档未细化「数字是否按原样参与拼接」，但示例里 client_id=1（数字）在签名串中
 * 呈现为 `client_id1`、timestamp=1480411125 呈现为 `timestamp1480411125`——即数字按
 * 十进制原样拼接，不做补零或引号包裹。对象/数组必须先由调用方序列化为字符串。
 */
export type PddSignableValue = string | number | boolean | null | undefined;

/**
 * 计算拼多多 sign。
 *
 * @param params 参与签名的全部参数（公共 + 业务）。值为 `null`/`undefined`/空串的
 *               参数会被跳过——官方文档示例与常见 SDK 行为一致：空值不参与签名。
 *               **注意**：是否跳过空串属于实现细节，若真实调用出现签名不符，
 *               首要怀疑点就在这里（见 docs/验收记录 中的排查顺序）。
 * @param clientSecret 应用密钥（官方称 client_secret）
 * @returns 32 位大写十六进制 MD5
 */
export function computePddSign(
  params: Record<string, PddSignableValue>,
  clientSecret: string,
): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [key, String(value)] as const)
    // ASCII 升序：默认 sort 对字符串按 UTF-16 码元比较，与 ASCII 升序在
    // 纯 ASCII 参数名下等价（拼多多参数名均为小写字母/下划线/数字）。
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const joined = entries.map(([key, value]) => `${key}${value}`).join('');
  const material = `${clientSecret}${joined}${clientSecret}`;
  return createHash('md5').update(material, 'utf8').digest('hex').toUpperCase();
}

/**
 * 组装一次真实 API 调用的完整请求体（含 sign）。
 *
 * 公共参数按官方文档「公共参数」一节注入：
 *   type(必填) client_id(必填) timestamp(必填, UNIX 秒) sign(必填)
 *   data_type(可选, 默认 JSON) access_token(可选, 需授权的接口才传) version(可选)
 *
 * @param apiType 接口名，形如 `pdd.order.number.list.get`
 * @param business 业务参数
 * @param options clientId / clientSecret / accessToken / timestamp（秒）/ version
 */
export function buildPddRequestBody(
  apiType: string,
  business: Record<string, PddSignableValue>,
  options: {
    clientId: string;
    clientSecret: string;
    accessToken?: string | null;
    /** UNIX 秒；不传则取当前时间。测试可注入固定值。 */
    timestamp?: number;
    version?: string;
  },
): { body: Record<string, string | number>; sign: string; timestamp: number } {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);

  const params: Record<string, PddSignableValue> = {
    type: apiType,
    client_id: options.clientId,
    timestamp,
    data_type: 'JSON',
    ...(options.accessToken ? { access_token: options.accessToken } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...business,
  };

  const sign = computePddSign(params, options.clientSecret);

  // body 里数字保持数字类型（官方示例 body 中 client_id/page/timestamp 是数字），
  // 但 sign 计算用的是它们的十进制字符串形式——两者由 String() 保持一致。
  const body: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    body[key] = typeof value === 'number' ? value : String(value);
  }
  body.sign = sign;

  return { body, sign, timestamp };
}
