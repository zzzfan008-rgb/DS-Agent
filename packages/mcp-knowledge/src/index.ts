/**
 * @dssaas/mcp-knowledge —— 知识库 MCP server（M1 空壳）。
 *
 * 工具：混合召回检索、文档读取、引用溯源。每次返回必须带 document_id + chunk + version。
 * 向量不可用时降级为关键词检索并在结果里标注低置信。
 */
export const MCP_KNOWLEDGE_PACKAGE = '@dssaas/mcp-knowledge';
