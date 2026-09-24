import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import {
  AuthStore,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { createCubeAgent } from "./agents/default.agent.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import { createCubeGateways, type CubeGatewayComposition } from "./gateways/factory.js";
import { toMastraRouterId } from "./gateways/types.js";
import { createCubeTools, type CubeTools } from "./tools/cube-tools.js";

// Mastra 1.17.4 does not await in-flight storage writes on shutdown.
export class DrainingStorageExporter extends MastraStorageExporter {
  private pendingFlush: Promise<void> = Promise.resolve();
  private shutdownPromise?: Promise<void>;

  constructor() {
    super({ strategy: "realtime" });
  }

  override _exportTracingEvent(
    ...args: Parameters<MastraStorageExporter["_exportTracingEvent"]>
  ): Promise<void> {
    if (this.shutdownPromise) return Promise.resolve();
    this.pendingFlush = this.pendingFlush.then(() => super._exportTracingEvent(...args));
    return this.pendingFlush;
  }

  override shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      await this.pendingFlush;
      await super.shutdown();
    })();
    return this.shutdownPromise;
  }
}

export interface CubeMastraComposition {
  agent: Awaited<ReturnType<typeof createCubeAgent>>;
  controller: Awaited<ReturnType<typeof createCubeController>>;
  mastra: Mastra;
  logger: Awaited<ReturnType<typeof createCubeLogger>>["logger"];
  gateways: CubeGatewayComposition;
  tools: CubeTools;
  shutdown: () => Promise<void>;
}

export const createCubeMastra = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  options: { gateways?: CubeGatewayComposition; } = {},
): Promise<CubeMastraComposition> => {
  const root = (await workspace.getPaths()).root;
  const logging = await createCubeLogger(home);
  const tools = createCubeTools(root);
  try {
    const auth = new AuthStore(home);
    const gateways =
      options.gateways ??
      createCubeGateways({
        auth,
        oauth: {
          openai: {
            getValidCredential: async () => {
              const credential = await auth.getOpenAIOAuth();
              if (!credential || credential.expires_at <= Date.now()) {
                throw new Error("OpenAI OAuth is unavailable. Run Cube and use /gateway.");
              }
              return credential;
            },
          },
          xai: {
            getValidCredential: async () => {
              const credential = (await auth.read()).oauth.xai;
              if (!credential || credential.expires_at <= Date.now())
                throw new Error("Grok Build OAuth is unavailable. Run Cube and use /gateway.");
              return credential;
            },
          },
        },
        gatewayOptions: config.gateway_options,
      });
    const routedConfig = {
      ...config,
      model: toMastraRouterId(config.gateway, config.model),
    };
    const agent = await createCubeAgent(home, workspace, routedConfig, logging.logger, tools);
    const pendingStreams = new Set<Promise<void>>();
    // Session emits agent_end on abort before the native stream finishes DB cleanup.
    // Keep its public completion promise so shutdown cannot close SQLite too early.
    for (const method of ["stream", "resumeStream"] as const) {
      const stream = agent[method].bind(agent) as (
        ...args: any[]
      ) => Promise<{ consumeStream(): Promise<void>; }>;
      agent[method] = ((...args: any[]) => {
        const output = stream(...args);
        const completion = output.then((result) => result.consumeStream());
        pendingStreams.add(completion);
        void completion.finally(() => pendingStreams.delete(completion)).catch(() => undefined);
        return output;
      }) as typeof agent.stream & typeof agent.resumeStream;
    }
    const controller = await createCubeController(
      home,
      workspace,
      routedConfig,
      agent,
      gateways.ordered,
    );
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
      observability: config.telemetry
        ? new Observability({
          configs: {
            default: {
              serviceName: "cube-agent",
              exporters: [new DrainingStorageExporter()],
            },
          },
        })
        : undefined,
      gateways: gateways.record,
    });

    const shutdownMastra = mastra.shutdown.bind(mastra);
    let shutdownPromise: Promise<void> | undefined;

    return {
      agent,
      controller,
      mastra,
      logger: logging.logger,
      gateways,
      tools,
      shutdown: () => {
        shutdownPromise ??= (async () => {
          try {
            await tools.dispose();
          } finally {
            try {
              await Promise.allSettled([...pendingStreams]);
              // Mastra 1.63 closes storage before observability; drain exporters first.
              await mastra.observability.shutdown();
              await shutdownMastra();
            } finally {
              await logging.close();
            }
          }
        })();
        return shutdownPromise;
      },
    };
  } catch (error) {
    await tools.dispose().catch(() => undefined);
    await logging.close();
    throw error;
  }
};
