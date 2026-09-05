import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import {
  AuthStore,
  ModelManager,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { createCubeAgent } from "./agents/main.agent.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import { createMemory } from "./memory.js";
import {
  createCubeGateways,
  type CubeGatewayComposition,
} from "./gateways/factory.js";
import { toMastraRouterId } from "./gateways/types.js";

export interface CubeMastraComposition {
  agent: Awaited<ReturnType<typeof createCubeAgent>>;
  controller: Awaited<ReturnType<typeof createCubeController>>;
  mastra: Mastra;
  logger: Awaited<ReturnType<typeof createCubeLogger>>["logger"];
  gateways: CubeGatewayComposition;
  shutdown: () => Promise<void>;
}

export const createCubeMastra = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  options: { gateways?: CubeGatewayComposition } = {},
): Promise<CubeMastraComposition> => {
  const logging = await createCubeLogger(home);
  const auth = new AuthStore(home);
  const gateways = options.gateways ?? createCubeGateways({
    auth,
    openAISubscription: {
      getValidCredential: async () => {
        const credential = await auth.getOpenAISubscription();
        if (!credential || credential.expires_at <= Date.now()) {
          throw new Error("OpenAI subscription is unavailable. Run Cube and use /gateway.");
        }
        return credential;
      },
    },
    openAISubscriptionModelIds:
      (await new ModelManager(home).getCatalog()).providers.openai?.models
        .map((model) => model.modelId) ?? [],
    gatewayOptions: config.gateway_options,
  });
  const routedConfig = {
    ...config,
    model: toMastraRouterId(config.gateway, config.model),
  };
  const agent = await createCubeAgent(home, workspace, routedConfig, logging.logger);
  const controller = await createCubeController(
    home,
    workspace,
    routedConfig,
    agent,
    gateways.ordered,
  );
  const memory = createMemory(routedConfig, home);
  const mcpServer = createMcpServer();

  const mastra = new Mastra({
    agents: { cubeAgent: agent },
    agentControllers: { cubeController: controller },
    logger: logging.logger,
    loggerOptions: {
      correlation: true,
      export: false,
    },
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
    gateways: gateways.record,
  });

  let shutdownPromise: Promise<void> | undefined;

  return {
    agent,
    controller,
    mastra,
    logger: logging.logger,
    gateways,
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
