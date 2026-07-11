import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StructuredTool } from "@langchain/core/tools";

export interface ToolNodeOptions {
  maxRetries?: number;
}

/**
 * Middleware khởi tạo ToolNode tích hợp sẵn:
 * Bắt lỗi (handleToolErrors: true) đóng gói ToolMessage cho LLM tự khắc phục.
 */
export function createSafeToolNode(tools: StructuredTool[], options: ToolNodeOptions = {}) {
  return new ToolNode(tools, {
    handleToolErrors: true,
  });
}
