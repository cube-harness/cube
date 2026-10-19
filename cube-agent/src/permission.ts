import type { Session, ToolCategory } from "@mastra/core/agent-controller";
import { resolveToolPermission, type CubeConfig } from "@cube/workspace";

export const resolveCubeToolCategory = (_toolName: string): ToolCategory =>
  "other";

type Permissions = Pick<CubeConfig["permissions"], "require_approval_for"> &
  Partial<Pick<CubeConfig["permissions"], "deny_for" | "allow_for">>;
const mutations = ["write_file", "edit_file", "apply_patch", "execute_command"];
const retiredNames = (permissions: Permissions) =>
  [...permissions.require_approval_for, ...(permissions.deny_for ?? [])].filter(name =>
    name.startsWith("mastra_workspace_") || ["list_file", "create_file", "delete_file", "file_stat"].includes(name));

export const resolveCubeToolPermission = (toolName: string, permissions: Permissions, fallback: "allow" | "ask" = "allow") =>
  mutations.includes(toolName) && retiredNames(permissions).length ? "deny" : resolveToolPermission(toolName, permissions, fallback);

export const configureCubePermissions = async (
  session: Session,
  permissions: Permissions,
  mcpToolNames: readonly string[] = [],
): Promise<string[]> => {
  await session.permissions.setForCategory({
    category: "other",
    policy: "allow",
  });

  const names = new Set(permissions.require_approval_for);
  const denied = new Set(permissions.deny_for ?? []);
  const retired = retiredNames(permissions);
  // permission.json owns these rules, including rules saved on a resumed session.
  const tools = new Set([
    ...Object.keys(session.permissions.getRules().tools),
    ...mutations, "execute_command", ...names, ...denied, ...(permissions.allow_for ?? []), ...mcpToolNames,
  ]);
  for (const toolName of tools) {
    await session.permissions.setForTool({ toolName,
      policy: resolveCubeToolPermission(toolName, permissions, mcpToolNames.includes(toolName) ? "ask" : "allow") });
  }
  if (!retired.length) return [];
  return [`Unknown retired tool names in permissions: ${retired.join(", ")}. File mutations and commands are blocked. Update this workspace's permission.json entry to current tool names and apply /permissions or restart Cube.`];
};
