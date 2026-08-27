import { Agent } from "@mastra/core/agent";
import { WorkspaceManager } from "@cube/workspace";
import { AgentController } from "@mastra/core/agent-controller";
import { createMastraWorkspace } from "../workspace.js";

export const createCubeController = async (agent: Agent, workspace: WorkspaceManager) => {
  const mastraWorkspace = await createMastraWorkspace(workspace);

  return new AgentController({
    id: "cube-controller",
    agent,
    modes: [{ id: "build", name: "Build", metadata: { default: true } }],
    workspace: mastraWorkspace,
  });
};
