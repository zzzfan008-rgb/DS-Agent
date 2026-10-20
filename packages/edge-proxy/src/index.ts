/**
 * @dssaas/edge-proxy —— 按需部署在指定机房的薄代理（M1 空壳）。
 *
 * 只做四件事：转发、平台请求签名、时间戳防重放、报文留档。
 * 中心 ↔ edge 走 HTTPS + 双向证书 + HMAC，不使用 SSH 隧道。
 * 注：包名 DSH 无关；这是平台网络约束的绕行组件，不是 agent 代理。
 */
export const EDGE_PROXY_PACKAGE = '@dssaas/edge-proxy';
