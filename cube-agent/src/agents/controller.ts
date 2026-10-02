import { Agent } from "@mastra/core/agent";
import { CubeConfig, HomeManager, WorkspaceManager } from "@cube/workspace";
import { AgentController, type AgentControllerConfig } from "@mastra/core/agent-controller";
import type { MastraModelGatewayInterface } from "@mastra/core/llm";
import { createMastraWorkspace } from "../workspace.js";
import { resolveCubeToolCategory } from "../permission.js";
import { cubeAskUserTool } from "../tools/ask-user.tool.js";
import { createMemory } from "../memory.js";
import type { CubeSkills } from "../skills.js";

export const createCubeController = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  agent: Agent,
  gateways: MastraModelGatewayInterface[] = [],
  skills?: CubeSkills,
  threadLock?: AgentControllerConfig["threadLock"],
) => {
  const mastraWorkspace = await createMastraWorkspace(workspace, skills, config.permissions.workspace_only);

  return new AgentController({
    id: "cube-controller",
    agent,
    memory: createMemory(config, home),
    modes: [{ id: "default", name: "Default", metadata: { default: true } }],
    tools: { ask_user: cubeAskUserTool },
    disableBuiltinTools: [
      "ask_user",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "submit_plan",
    ],
    workspace: mastraWorkspace,
    toolCategoryResolver: resolveCubeToolCategory,
    gateways,
    threadLock,
  });
};
