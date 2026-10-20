/**
 * @dssaas/adapters-pdd —— 拼多多适配（中心侧，M1 空壳）。
 *
 * 只做业务逻辑、幂等、快照与审计；请求签名与网络出口可下沉到 packages/edge-proxy。
 * 写路径必须由 apps/api 的写入门调用，本包不得被页面直接引用。
 * 接口权限未获批时，走"上架包 + 后台导入"兜底路径。
 */
export const PDD_ADAPTER = '@dssaas/adapters-pdd';
