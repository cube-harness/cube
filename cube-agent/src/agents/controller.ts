import { Agent } from "@mastra/core/agent";
import { Home, WorkspaceManager } from "@cube/workspace";
import { AgentController } from "@mastra/core/agent-controller";
import { LibSQLStore } from "@mastra/libsql";
import { createMastraWorkspace } from "../workspace.js";

export const createCubeController = async (
  home: Home,
  agent: Agent,
  workspace: WorkspaceManager,
) => {
  const mastraWorkspace = await createMastraWorkspace(workspace);

  return new AgentController({
    id: "cube-controller",
    agent,
    modes: [{ id: "build", name: "Build", metadata: { default: true } }],
    workspace: mastraWorkspace,
    storage: new LibSQLStore({
      id: "cube-controller-storage",
      url: `file:${home.getMemoryDbPath()}`,
    }),
  });
};
