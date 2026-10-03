import type { Session, ToolCategory } from "@mastra/core/agent-controller";
import type { CubeConfig } from "@cube/workspace";

export const resolveCubeToolCategory = (_toolName: string): ToolCategory =>
  "other";

export const configureCubePermissions = async (
  session: Session,
  permissions: Pick<CubeConfig["permissions"], "require_approval_for"> &
    Partial<Pick<CubeConfig["permissions"], "deny_for">>,
): Promise<string[]> => {
  await session.permissions.setForCategory({
    category: "other",
    policy: "allow",
  });

  const mutations = ["edit_file", "write_file", "apply_patch"];
  const names = new Set(permissions.require_approval_for);
  const denied = new Set(permissions.deny_for ?? []);
  const retired = [...names, ...denied].filter((name) => name.startsWith("mastra_workspace_") || ["list_file", "create_file", "delete_file", "file_stat"].includes(name));
  // permission.json owns these rules, including rules saved on a resumed session.
  const tools = new Set([
    ...Object.keys(session.permissions.getRules().tools),
    ...mutations, "execute_command", ...names, ...denied,
  ]);
  for (const toolName of tools) {
    await session.permissions.setForTool({ toolName,
      policy: denied.has(toolName) ? "deny" : names.has(toolName) ? "ask" : "allow" });
  }
  if (!retired.length) return [];
  for (const toolName of [...mutations, "execute_command"]) {
    await session.permissions.setForTool({ toolName, policy: "deny" });
  }
  return [`Unknown retired tool names in permissions: ${retired.join(", ")}. File mutations and commands are blocked. Update this workspace's permission.json entry to current tool names and apply /permissions or restart Cube.`];
};
