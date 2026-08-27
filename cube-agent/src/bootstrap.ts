import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import type { Home, WorkspaceManager } from "@cube/workspace";
import { createCubeAgent } from "./agents/main.agent.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";

export interface CubeMastraComposition {
  agent: Awaited<ReturnType<typeof createCubeAgent>>;
  controller: Awaited<ReturnType<typeof createCubeController>>;
  mastra: Mastra;
  logger: Awaited<ReturnType<typeof createCubeLogger>>["logger"];
  shutdown: () => Promise<void>;
}

export const createCubeMastra = async (
  home: Home,
  workspace: WorkspaceManager,
): Promise<CubeMastraComposition> => {
  const agent = await createCubeAgent(home, workspace);
  const controller = await createCubeController(agent, workspace);
  const logging = await createCubeLogger(home);
  const mcpServer = createMcpServer();

  const mastra = new Mastra({
    agents: { cubeAgent: agent },
    agentControllers: { cubeController: controller },
    logger: logging.logger,
    storage: new LibSQLStore({
      id: "cube-storage",
      url: `file:${home.getMemoryDbPath()}`,
    }),
    mcpServers: {
      myServer: mcpServer,
    },
    observability: new Observability({
      configs: {
        default: {
          serviceName: "cube-agent",
          exporters: [new MastraStorageExporter()],
        },
      },
    }),
  });

  let shutdownPromise: Promise<void> | undefined;

  return {
    agent,
    controller,
    mastra,
    logger: logging.logger,
    shutdown: () => {
      shutdownPromise ??= (async () => {
        try {
          await mastra.shutdown();
        } finally {
          await logging.close();
        }
      })();
      return shutdownPromise;
    },
  };
};
