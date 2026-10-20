/**
 * @dssaas/registry —— Provider / Model / Route 三层注册表（M1 空壳）。
 *
 * 后续承载：
 * - 供应商与模型建档、连通性测试、发布；
 * - 前台可见性判定（auth_ref 已配置 + published + route 命中）；
 * - 用途路由与降级链、配额与计量；
 * - 文本侧对接 dsh-llm-pi-ai，图片/视频走异步任务。
 */
export const REGISTRY_PACKAGE = '@dssaas/registry';
