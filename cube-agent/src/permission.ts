import type { ToolCategory } from "@mastra/core/agent-controller";
import type { CubeConfig } from "@cube/workspace";
import type { Session } from "@mastra/core/agent-controller";

export const resolveCubeToolCategory = (_toolName: string): ToolCategory =>
  "other";

export const configureCubePermissions = async (
  session: Session,
  permissions: CubeConfig["permissions"],
): Promise<string[]> => {
  await session.permissions.setForCategory({
    category: "other",
    policy: "allow",
  });

  const mutations = ["edit_file", "write_file", "apply_patch"];
  const names = new Set(permissions.require_approval_for);
  const retired = [...names].filter((name) => name.startsWith("mastra_workspace_") || ["list_file", "create_file", "delete_file", "file_stat"].includes(name));
  if (mutations.some((name) => names.has(name))) mutations.forEach((name) => names.add(name));
  // config.yaml owns these rules. Clear a previous fail-closed block after correction.
  for (const toolName of [...mutations, "execute_command"]) {
    if (!names.has(toolName)) await session.permissions.setForTool({ toolName, policy: "allow" });
  }
  for (const configuredName of names) {
    await session.permissions.setForTool({
      toolName: configuredName,
      policy: "ask",
    });
  }
  if (!retired.length) return [];
  for (const toolName of [...mutations, "execute_command"]) {
    await session.permissions.setForTool({ toolName, policy: "deny" });
  }
  return [`Unknown retired tool names in permissions.require_approval_for: ${retired.join(", ")}. File mutations and commands are blocked. Update config.yaml to current tool names and restart Cube.`];
};
