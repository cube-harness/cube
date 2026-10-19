import { Mastra } from "@mastra/core";
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
  createMemoryIndexStore,
  ConfigStore,
  INHERIT_MODEL,
  type GatewayId,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { createCubeAgent } from "./agents/default.agent.js";
import { resolveMemoryModel } from "./memory.js";
import { createSummarizerAgent, summarizeConversation } from "./agents/summarizer.agent.js";
import { createStreamSignals, type ChildCompletion } from "./stream-signals.js";
import { createDurableMemory, type DurableMemory } from "./durable-memory.js";
import { createMemoryRecall } from "./tools/memory-recall.tool.js";
import { createMemoryRetrieval, type MemoryRetrieval } from "./rag/retrieval.js";
import { resolveMemoryEmbedding } from "./rag/embedding.js";
import { redactMemoryText } from "./memory-evidence.js";
import { formatMemorySnapshot } from "./processors/memory.processor.js";
import { createCubeController } from "./agents/controller.js";
import { createCubeLogger } from "./logger.js";
import { CubeMcp } from "./mcp/client.js";
import { createCubeGateways, type CubeGatewayComposition } from "./gateways/factory.js";
import { toMastraRouterId, getCanonicalModelId, getModelGateway } from "./gateways/types.js";
import { createCubeTools, type CubeTools } from "./tools/cube-tools.js";
import { CubeContext } from "./context.js";
import { createNativeSubagents } from "./agents/subagent.agent.js";

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
  memoryRetrieval: MemoryRetrieval;
  setMemoryNotice: (handler: (message: string) => void) => void;
  drain: (threadId?: string) => Promise<void>;
  continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>;
  subagents: ReturnType<typeof createNativeSubagents>;
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
    root,
    undefined,
    { cacheDir: home.getToolOutputDir(), policy: config.truncation_policy.execute_command },
  );
  const mcp = new CubeMcp({ auth: new AuthStore(home), workspaceRoot: root });
  let memoryRetrieval: MemoryRetrieval | undefined;
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
    const readModel = async (modelId: string) => {
      const gateway = getModelGateway(modelId);
      const models = gateway ? await catalog.getCatalog(gateway) : undefined;
      const model = Object.values(models?.providers ?? {})
        .flatMap((provider) => provider.models)
        .find((candidate) => candidate.modelId === getCanonicalModelId(modelId));
      return { limits: model?.limit ?? {}, model, gateway };
    };
    const resolveAuxiliaryModel = async (
      selection: Pick<CubeConfig["memory"]["compaction"], "model" | "reasoning_effort">,
      requestContext?: RequestContext,
      modelAgent = agent,
    ) => {
      const active = modelAgent.getActiveModelId();
      const modelId =
        selection.model === INHERIT_MODEL
          ? active
          : toMastraRouterId(getModelGateway(active) ?? config.gateway, selection.model);
      // Capture the model before catalog I/O: /model may change during a background job.
      const [found, model] = await Promise.all([
        readModel(modelId),
        resolveMemoryModel(modelAgent, modelId, selection, requestContext),
      ]);
      if (!found.model)
        throw new Error(
          `Auxiliary model is unavailable in the current gateway catalog: ${getCanonicalModelId(modelId)}`,
        );
      return { model, limits: found.limits };
    };
    let retrievalConfig = config.memory.durable.retrieval;
    let retrievalLocalOptions = config.gateway_options;
    let initialRetrievalLoad = true;
    memoryRetrieval = createMemoryRetrieval({
      store: memoryStore, indexStore: createMemoryIndexStore(home, memoryStore.projectId),
      cacheDir: home.getMemoryRetrievalDir(), runtimeId, secrets,
      registerVector: vector => mastra.addVector(vector, "cubeMemoryRetrieval"),
      resolveEmbedding: async () => {
        if (!initialRetrievalLoad) {
          const updated = await ConfigStore(home).read();
          // /reload applies retrieval/endpoint edits only, not unrelated chat settings.
          retrievalConfig = updated.memory.durable.retrieval;
          retrievalLocalOptions = updated.gateway_options;
        }
        initialRetrievalLoad = false;
        if (!config.memory.durable.enabled || !retrievalConfig.enabled) return undefined;
        return resolveMemoryEmbedding({ config: retrievalConfig, auth, localOptions: retrievalLocalOptions });
      },
      notice: message => { logging.logger.warn("Memory retrieval unavailable", { message }); notice(message); },
    });
    const recall = config.memory.durable.enabled
      ? createMemoryRecall({ store: memoryStore, storage, secrets, retrieval: memoryRetrieval })
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
            config.memory.compaction,
            input.requestContext,
            getAgent(),
          );
          return summarizeConversation(resolved.model, resolved.limits, input, logging.logger);
        },
      });
    const context = createContext(() => agent, storage);
    let nativeSubagents: ReturnType<typeof createNativeSubagents> | undefined;
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
      { agents: context => nativeSubagents?.readAgents(context) ?? {}, toolHooks: () => nativeSubagents?.hooks },
    );
    const summarizer = createSummarizerAgent(
      async ({ requestContext }) =>
        (await resolveAuxiliaryModel(config.memory.compaction, requestContext)).model,
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
      onPublished: () => memoryRetrieval!.check(),
      resolveWriter: () => resolveAuxiliaryModel(config.memory.durable),
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

    nativeSubagents = createNativeSubagents({ home, config, projectRoot: root, storage: mastra.getStorage()!, parent: agent,
      skills: agent.cubeSkills, mcp, readPermissions: () => config.permissions,
      commandOutput: { store: tools.outputStore, policy: config.truncation_policy.execute_command } });
    const shutdownMastra = mastra.shutdown.bind(mastra);
    let shutdownPromise: Promise<void> | undefined;

    return {
      agent,
      controller,
      mastra,
      continueProcess: streamSignals.continueProcess,
      subagents: nativeSubagents,
      deliverSubagentResult: streamSignals.deliverSubagentResult,
      redact: async (text) => redactMemoryText(text, await secrets()),
      logger: logging.logger,
      gateways,
      tools,
      mcp,
      context,
      skills: agent.cubeSkills,
      durableMemory,
      memoryRetrieval,
      setMemoryNotice: (handler) => {
        notify = handler;
        for (const message of pendingNotices.splice(0)) handler(message);
      },
      drain: streamSignals.drain,
      shutdown: () => {
        shutdownPromise ??= (async () => {
          durableMemory.cancel();
          await durableMemory.drain();
          memoryRetrieval!.cancel();
          await memoryRetrieval!.drain();
          await memoryRetrieval!.close().catch(error => notice(`Memory retrieval: ${redactMemoryText(error instanceof Error ? error.message : "Cache close failed").slice(0, 500)}`));
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
    await memoryRetrieval?.close().catch(() => undefined);
    await mcp.dispose().catch(() => undefined);
    await tools.dispose().catch(() => undefined);
    await logging.close();
    throw error;
  }
};
