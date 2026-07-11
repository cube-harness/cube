import { StructuredTool } from "@langchain/core/tools";

/**
 * Middleware phân quyền Tool (Dynamic Tool Binding theo LangGraph Docs):
 * Lọc danh sách tool hợp lệ dựa trên vai trò người dùng (userRole) truyền từ context.
 */
export function filterAllowedTools<T extends StructuredTool>(
  tools: T[],
  userRole?: string
): T[] {
  // Quyền Admin được dùng tất cả các tools
  if (userRole === "admin") {
    return tools;
  }

  // Danh sách tên tool hạn chế chỉ dành cho Admin
  const adminOnlyTools = ["delete_user_data", "reset_database", "admin_config"];

  return tools.filter((t) => !adminOnlyTools.includes(t.name));
}
