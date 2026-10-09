import { Mastra } from "@mastra/core";
import type { ToolsInput } from "@mastra/core/agent";
import type { MemoryStorage } from "@mastra/core/storage";
import { randomUUID } from "node:crypto";
import type { ProcessRecord } from "./tools/command.tools.js";
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
import { createSummarizerAgent, summarizeConversation } from "./agents/summarizer.agent.js";
import { createStreamSignals, type ChildCompletion } from "./stream-signals.js";
import { createDurableMemory, type DurableMemory } from "./durable-memory.js";
import { createMemoryRecall } from "./tools/memory-recall.tool.js";
import { redactMemoryText } from "./memory-evidence.js";
import { formatMemorySnapshot } from "./processors/memory.processor.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { CubeMcp } from "./mcp/client.js";
import { createCubeGateways, type CubeGatewayComposition } from "./gateways/factory.js";
import { toMastraRouterId, getCanonicalModelId, gatewayDescriptors } from "./gateways/types.js";
import { createCubeTools, type CubeTools } from "./tools/cube-tools.js";
import { CubeContext } from "./context.js";
import {
  createSubagentChild,
  type CreateSubagentChildOptions,
  type SubagentChild,
} from "./agents/subagent.agent.js";

type ChildCreation = Pick<
  CreateSubagentChildOptions,
  | "id"
  | "projectRoot"
  | "executionRoot"
  | "cwd"
  | "definition"
  | "modelId"
  | "reasoningEffort"
  | "instructions"
  | "readPermissions"
>;

export interface CubeMastraComposition {
  agent: Awaited<ReturnType<typeof createCubeAgent>>;
  controller: Awaited<ReturnType<typeof createCubeController>>;
  mastra: Mastra;
  redact: (text: string) => Promise<string>;
  logger: Awaited<ReturnType<typeof createCubeLogger>>["logger"];
  gateways: CubeGatewayComposition;
  tools: CubeTools;
  mcp: CubeMcp;
  context: CubeContext;
  skills: Awaited<ReturnType<typeof createCubeAgent>>["cubeSkills"];
  durableMemory: DurableMemory;
  setMemoryNotice: (handler: (message: string) => void) => void;
  drain: (threadId?: string) => Promise<void>;
  continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>;
  createChild: (options: ChildCreation) => Promise<SubagentChild>;
  setSubagentTools: (read: () => ToolsInput) => void;
  deliverSubagentResult: (record: ChildCompletion, wake: boolean) => Promise<void>;
  shutdown: () => Promise<void>;
}

export const createCubeMastra = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  options: { gateways?: CubeGatewayComposition } = {},
): Promise<CubeMastraComposition> => {
  const root = (await workspace.getPaths()).root;
  const logging = await createCubeLogger(home);
  const tools = createCubeTools(
    root,
    () => config.permissions.workspace_only,
    config.background_tasks,
  );
  const mcp = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: root });
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
        ...Object.values(credentials.api_keys).map((value) => value!.api_key),
        ...Object.values(credentials.oauth).flatMap((value) => [
          value.access_token,
          value.refresh_token,
        ]),
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
        .flatMap((provider) => provider.models)
        .find((candidate) => candidate.modelId === getCanonicalModelId(modelId));
      return { limits: model?.limit ?? {}, model, gateway };
    };
    const resolveAuxiliaryModel = async (
      selection: string,
      requestContext?: RequestContext,
      modelAgent = agent,
    ) => {
      const active = modelAgent.getActiveModelId();
      const modelId =
        selection === INHERIT_MODEL
          ? active
          : toMastraRouterId(modelGateway(active) ?? config.gateway, selection);
      // Capture the model before catalog I/O: /model may change during a background job.
      const [found, model] = await Promise.all([
        readModel(modelId),
        modelAgent.getModel({
          requestContext,
          ...(selection === INHERIT_MODEL
            ? {}
            : { modelConfig: [buildModelConfig(modelId) as any] }),
        }),
      ]);
      if (!found.model)
        throw new Error(
          `Auxiliary model is unavailable in the current gateway catalog: ${getCanonicalModelId(modelId)}`,
        );
      return { model, limits: found.limits };
    };
    const recall = config.memory.durable.enabled
      ? createMemoryRecall({ store: memoryStore, storage, secrets })
      : undefined;
    const createContext = (
      getAgent: () => typeof agent,
      readStorage: () => Promise<MemoryStorage>,
    ): CubeContext =>
      new CubeContext({
        policy: config.memory.compaction,
        storage: readStorage,
        protectedTools: new Set(["skill", "skill_read"]),
        summarize: async (input) => {
          const resolved = await resolveAuxiliaryModel(
            config.memory.compaction.model,
            input.requestContext,
            getAgent(),
          );
          return summarizeConversation(resolved.model, resolved.limits, input, logging.logger);
        },
      });
    const context = createContext(() => agent, storage);
    let subagentTools: () => ToolsInput = () => ({});
    const agent = await createCubeAgent(
      home,
      workspace,
      routedConfig,
      logging.logger,
      tools,
      {
        context,
        readModel,
        ...(recall
          ? {
              recallTool: recall.tool,
              readMemory: async () => {
                try {
                  const snapshot = await memoryStore.snapshot();
                  formatMemorySnapshot(snapshot);
                  return snapshot;
                } catch (error) {
                  const message = redactMemoryText(
                    error instanceof Error ? error.message : "Memory snapshot unavailable",
                    await secrets(),
                  ).slice(0, 500);
                  logging.logger.warn("Memory snapshot unavailable", { message });
                  notice(`Memory snapshot unavailable: ${message}`);
                  return null;
                }
              },
            }
          : {}),
      },
      mcp,
      { extraTools: () => subagentTools() },
    );
    const summarizer = createSummarizerAgent(
      async ({ requestContext }) =>
        (await resolveAuxiliaryModel(config.memory.compaction.model, requestContext)).model,
      logging.logger,
    );
    const durableMemory = createDurableMemory({
      store: memoryStore,
      storage,
      projectRoot: root,
      config: config.memory.durable,
      runtimeId,
      logger: logging.logger,
      secrets,
      resolveWriter: () => resolveAuxiliaryModel(config.memory.durable.model),
      notice: (event) =>
        notice(
          `Memory ${event.stage}${event.threadId ? ` (${event.threadId})` : ""}: ${event.message}`,
        ),
    });
    const streamSignals = createStreamSignals(agent, storage);
    const controller = await createCubeController(
      home,
      workspace,
      routedConfig,
      agent,
      gateways.ordered,
      agent.cubeSkills,
      {
        acquire: async (threadId) => {
          try {
            await memoryStore.registerThread(threadId, runtimeId);
            ownedThreads.add(threadId);
          } catch (error) {
            notice(
              `Memory presence unavailable: ${redactMemoryText(error instanceof Error ? error.message : "Coordination failed").slice(0, 500)}`,
            );
          }
        },
        release: async (threadId) => {
          try {
            await memoryStore.releaseThread(threadId, runtimeId);
            ownedThreads.delete(threadId);
          } catch (error) {
            notice(
              `Memory presence release failed: ${redactMemoryText(error instanceof Error ? error.message : "Coordination failed").slice(0, 500)}`,
            );
          }
        },
      },
    );

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
      observability: config.telemetry
        ? new Observability({
            configs: {
              default: {
                serviceName: "cube-agent",
                exporters: [new MastraStorageExporter({ strategy: "realtime" })],
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
      continueProcess: streamSignals.continueProcess,
      setSubagentTools: (read) => {
        subagentTools = read;
      },
      createChild: (childOptions) =>
        createSubagentChild({
          ...childOptions,
          home,
          config,
          logger: logging.logger,
          gateways: gateways.ordered,
          skills: agent.cubeSkills,
          mcp,
          recall: recall?.tool,
          readModel,
          createContext: (getChild, childStorage) =>
            createContext(() => getChild() as typeof agent, childStorage),
        }),
      deliverSubagentResult: streamSignals.deliverSubagentResult,
      redact: async (text) => redactMemoryText(text, await secrets()),
      logger: logging.logger,
      gateways,
      tools,
      mcp,
      context,
      skills: agent.cubeSkills,
      durableMemory,
      setMemoryNotice: (handler) => {
        notify = handler;
        for (const message of pendingNotices.splice(0)) handler(message);
      },
      drain: streamSignals.drain,
      shutdown: () => {
        shutdownPromise ??= (async () => {
          durableMemory.cancel();
          await durableMemory.drain();
          context.cancel();
          await context.drain();
          try {
            await mcp.dispose();
            await tools.dispose();
          } finally {
            try {
              await streamSignals.drain();
              // Mastra 1.63 closes storage before observability; drain exporters first.
              await mastra.observability.shutdown();
              await shutdownMastra();
            } finally {
              await Promise.allSettled(
                [...ownedThreads].map((threadId) => memoryStore.releaseThread(threadId, runtimeId)),
              );
              await logging.close();
            }
          }
        })();
        return shutdownPromise;
      },
    };
  } catch (error) {
    await mcp.dispose().catch(() => undefined);
    await tools.dispose().catch(() => undefined);
    await logging.close();
    throw error;
  }
};
