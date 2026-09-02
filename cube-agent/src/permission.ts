import type { ToolCategory } from "@mastra/core/agent-controller";
import type { CubeConfig } from "@cube/workspace";
import type { Session } from "@mastra/core/agent-controller";

export const resolveCubeToolCategory = (_toolName: string): ToolCategory =>
  "other";

export const configureCubePermissions = async (
  session: Session,
  permissions: CubeConfig["permissions"],
): Promise<void> => {
  await session.permissions.setForCategory({
    category: "other",
    policy: "allow",
  });

  for (const configuredName of permissions.require_approval_for) {
    const exposedName = configuredName.startsWith("mastra_workspace_")
      ? configuredName
      : `mastra_workspace_${configuredName}`;
    await session.permissions.setForTool({
      toolName: configuredName,
      policy: "ask",
    });
    if (exposedName !== configuredName) {
      await session.permissions.setForTool({
        toolName: exposedName,
        policy: "ask",
      });
    }
  }
};
