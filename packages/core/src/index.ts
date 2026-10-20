/**
 * @dssaas/core —— 领域模型与规则（M1 空壳）。
 *
 * 后续承载：
 * - 服装强类型校验：尺码表 measurements、面料成分合计 100、平台属性映射；
 * - 写操作 A/B/C 分级策略与不可逆动作判定；
 * - 判断层 L1 规则结果的数据结构（与 packages/judge-rules 配合）。
 *
 * 约定：这里不出现 Prisma 类型，也不直接读写数据库。
 */
export const CORE_PACKAGE = '@dssaas/core';
