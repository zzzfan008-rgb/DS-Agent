/**
 * @dssaas/mcp-erp —— 只读 ERP MCP server（M1 空壳）。
 *
 * 工具全部只读：商品主数据查询、库存查询、成本查询；不提供任何写工具。
 * 由中心 DSH Host 作为 MCP client 接入，供 agent 取事实（价格/库存/成分/尺码）。
 */
export const MCP_ERP_PACKAGE = '@dssaas/mcp-erp';
