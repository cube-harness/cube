import { Mastra } from "@mastra/core";
import { randomUUID } from "node:crypto";
import type { RequestContext } from "@mastra/core/request-context";
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import {
  AuthStore,
  ModelManager,
  createMemoryStore,
  INHERIT_MODEL,
  type GatewayId,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { buildModelConfig, createCubeAgent } from "./agents/default.agent.js";
import { createSummarizerAgent } from "./agents/summarizer.agent.js";
import { createDurableMemory, type DurableMemory } from "./durable-memory.js";
import { createMemoryRecall } from "./tools/memory-recall.tool.js";
import { redactMemoryText } from "./memory-evidence.js";
import { formatMemorySnapshot } from "./processors/memory.processor.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import { createCubeGateways, type CubeGatewayComposition } from "./gateways/factory.js";
import { toMastraRouterId, getCanonicalModelId, gatewayDescriptors } from "./gateways/types.js";
import { createCubeTools, type CubeTools } from "./tools/cube-tools.js";
import { CubeContext, estimateTokens } from "./context.js";
import { COMPACT_SYSTEM_PROMPT } from "./prompts/compact.prompt.js";

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
  context: CubeContext;
  skills: Awaited<ReturnType<typeof createCubeAgent>>["cubeSkills"];
  durableMemory: DurableMemory;
  setMemoryNotice: (handler: (message: string) => void) => void;
  drain: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export const createCubeMastra = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  options: { gateways?: CubeGatewayComposition; deferInstructions?: boolean } = {},
): Promise<CubeMastraComposition> => {
  const root = (await workspace.getPaths()).root;
  const logging = await createCubeLogger(home);
  const tools = createCubeTools(root, config.permissions.workspace_only);
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
    let mastra!: Mastra;
    const catalog = new ModelManager(home);
    const memoryStore = createMemoryStore(home, root);
    const runtimeId = randomUUID();
    const ownedThreads = new Set<string>();
    const pendingNotices: string[] = [];
    let notify: ((message: string) => void) | undefined;
    const notice = (message: string) => {
      const bounded = message.slice(0, 500);
      if (notify) notify(bounded);
      else pendingNotices.push(bounded);
    };
    const storage = async () => {
      const store = await mastra.getStorage()?.getStore("memory");
      if (!store) throw new Error("Context storage is unavailable");
      return store;
    };
    const secrets = async () => {
      const credentials = await auth.read();
      return [
        ...Object.values(credentials.api_keys).map(value => value!.api_key),
        ...Object.values(credentials.oauth).flatMap(value => [value.access_token, value.refresh_token]),
      ];
    };
    const modelGateway = (modelId: string) =>
      Object.entries(gatewayDescriptors).find(([, descriptor]) =>
        modelId.startsWith(`${descriptor.internalId}/${descriptor.providerId}/`),
      )?.[0] as GatewayId | undefined;
    const readModel = async (modelId: string) => {
      const gateway = modelGateway(modelId);
      const models = gateway ? await catalog.getCatalog(gateway) : undefined;
      const model = Object.values(models?.providers ?? {})
        .flatMap(provider => provider.models)
        .find(candidate => candidate.modelId === getCanonicalModelId(modelId));
      return { limits: model?.limit ?? {}, model, gateway };
    };
    const resolveAuxiliaryModel = async (selection: string, requestContext?: RequestContext) => {
      const active = agent.getActiveModelId();
      const modelId = selection === INHERIT_MODEL ? active : toMastraRouterId(modelGateway(active) ?? config.gateway, selection);
      // Capture the model before catalog I/O: /model may change during a background job.
      const [found, model] = await Promise.all([
        readModel(modelId),
        agent.getModel({ requestContext, ...(selection === INHERIT_MODEL ? {} : { modelConfig: [buildModelConfig(modelId) as any] }) }),
      ]);
      if (!found.model) throw new Error(`Auxiliary model is unavailable in the current gateway catalog: ${getCanonicalModelId(modelId)}`);
      return { model, limits: found.limits };
    };
    const recall = config.memory.durable.enabled ? createMemoryRecall({ store: memoryStore, storage, secrets }) : undefined;
    const context = new CubeContext({
      policy: config.memory.compaction,
      storage,
      protectedTools: new Set(["skill", "skill_read"]),
      summarize: async ({ text, signal, maxOutputTokens, requestContext }) => {
        const resolved = await resolveAuxiliaryModel(config.memory.compaction.model, requestContext);
        const { context: capacity, output: outputLimit, input } = resolved.limits;
        if (!capacity || !outputLimit || !Number.isFinite(capacity) || !Number.isFinite(outputLimit)) throw new Error("Summarizer has no known context/output limits");
        const outputTokens = Math.min(maxOutputTokens, outputLimit, capacity - 1024);
        if (outputTokens < 128 || (estimateTokens([COMPACT_SYSTEM_PROMPT, text]) ?? Infinity) > Math.min(input ?? Infinity, capacity - outputTokens - 1024))
          throw new Error("Selected summarizer cannot fit the compact request; existing checkpoint preserved");
        const summarizer = createSummarizerAgent(resolved.model, logging.logger);
        const output = await summarizer.generate(text, {
          abortSignal: signal,
          requestContext,
          maxSteps: 1,
          modelSettings: { maxOutputTokens: outputTokens },
        });
        return {
          text: output.text,
          finishReason: output.finishReason,
          toolCalls: output.toolCalls,
        };
      },
    });
    const agent = await createCubeAgent(
      home,
      workspace,
      routedConfig,
      logging.logger,
      tools,
      {
        context,
        readModel,
        ...(recall ? { recallTool: recall.tool, readMemory: async () => {
          try {
            const snapshot = await memoryStore.snapshot();
            formatMemorySnapshot(snapshot);
            return snapshot;
          }
          catch (error) {
            const message = redactMemoryText(error instanceof Error ? error.message : "Memory snapshot unavailable", await secrets()).slice(0, 500);
            logging.logger.warn("Memory snapshot unavailable", { message });
            notice(`Memory snapshot unavailable: ${message}`);
            return null;
          }
        } } : {}),
      },
      options.deferInstructions,
    );
    const summarizer = createSummarizerAgent(async ({ requestContext }) =>
      (await resolveAuxiliaryModel(config.memory.compaction.model, requestContext)).model, logging.logger);
    const durableMemory = createDurableMemory({
      store: memoryStore, storage, projectRoot: root, config: config.memory.durable,
      runtimeId, logger: logging.logger, secrets,
      resolveWriter: () => resolveAuxiliaryModel(config.memory.durable.model),
      notice: event => notice(`Memory ${event.stage}${event.threadId ? ` (${event.threadId})` : ""}: ${event.message}`),
    });
    const pendingStreams = new Set<Promise<void>>();
    // Session emits agent_end on abort before the native stream finishes DB cleanup.
    // Keep its public completion promise so shutdown cannot close SQLite too early.
    for (const method of ["stream", "resumeStream"] as const) {
      const stream = agent[method].bind(agent) as (
        ...args: any[]
      ) => Promise<{ consumeStream(): Promise<void> }>;
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
      agent.cubeSkills,
      {
        acquire: async threadId => {
          try { await memoryStore.registerThread(threadId, runtimeId); ownedThreads.add(threadId); }
          catch (error) { notice(`Memory presence unavailable: ${redactMemoryText(error instanceof Error ? error.message : "Coordination failed").slice(0, 500)}`); }
        },
        release: async threadId => {
          try { await memoryStore.releaseThread(threadId, runtimeId); ownedThreads.delete(threadId); }
          catch (error) { notice(`Memory presence release failed: ${redactMemoryText(error instanceof Error ? error.message : "Coordination failed").slice(0, 500)}`); }
        },
      },
    );
    const mcpServer = createMcpServer();

    mastra = new Mastra({
      agents: { cubeAgent: agent, cubeCompactor: summarizer },
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
      context,
      skills: agent.cubeSkills,
      durableMemory,
      setMemoryNotice: handler => { notify = handler; for (const message of pendingNotices.splice(0)) handler(message); },
      drain: async () => {
        await Promise.allSettled([...pendingStreams]);
      },
      shutdown: () => {
        shutdownPromise ??= (async () => {
          durableMemory.cancel();
          await durableMemory.drain();
          context.cancel();
          await context.drain();
          try {
            await tools.dispose();
          } finally {
            try {
              await Promise.allSettled([...pendingStreams]);
              // Mastra 1.63 closes storage before observability; drain exporters first.
              await mastra.observability.shutdown();
              await shutdownMastra();
            } finally {
              await Promise.allSettled([...ownedThreads].map(threadId => memoryStore.releaseThread(threadId, runtimeId)));
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
