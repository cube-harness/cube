import { Agent } from "@mastra/core/agent";
import { CubeConfig, HomeManager, WorkspaceManager } from "@cube/workspace";
import { AgentController } from "@mastra/core/agent-controller";
import { createMastraWorkspace } from "../workspace.js";
import { resolveCubeToolCategory } from "../permission.js";
import { cubeAskUserTool } from "../tools/ask-user.tool.js";
import { createMemory } from "../memory.js";

export const createCubeController = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  agent: Agent,
) => {
  const mastraWorkspace = await createMastraWorkspace(home, workspace);

  return new AgentController({
    id: "cube-controller",
    agent,
    memory: createMemory(config, home),
    modes: [{ id: "build", name: "Build", metadata: { default: true } }],
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
  });
};
