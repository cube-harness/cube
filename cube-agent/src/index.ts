import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  AgentRuntimeFiles,
  CubeConfig,
  CubeResult,
  WorkspaceIdentity,
} from "@cube/workspace";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { createDefaultAgent, createModelResolver } from "./agents/default.agent.js";
import { applyConfiguredModel, createController } from "./agents/controller.js";
import { createLogger } from "./logger.js";
import {
  createMemory,
  finalizeMemory as finalizeObservationalMemory,
  type FinalizeMemoryResult,
} from "./memory.js";
import { createAgentWorkspace } from "./workspace.js";
import { createSystemPrompt } from "./prompts/system.prompt.js";
import {
  createModelCatalog,
  type ModelCatalog,
  type ModelCatalogEntry,
} from "./model-catalog.js";
import {
  createActiveModelSelection,
  createSessionModelSelection,
  prepareModelSelection,
  resolveInitialModelSelection,
  type ModelSelection,
  type PreparedModelSelection,
  type SelectionValidationResult,
} from "./model-selection.js";

type CubeController = ReturnType<typeof createController>;
export type CubeSession = Awaited<ReturnType<CubeController["createSession"]>>;

interface FreshProcessSession {
  thread: Pick<
    CubeSession["thread"],
    | "getId"
    | "listActiveMessages"
    | "detachFromCurrent"
    | "clearAndReleaseLock"
    | "delete"
  >;
}

export interface CreateCubeRuntimeInput {
  config: CubeConfig;
  identity: WorkspaceIdentity;
  runtimeFiles: AgentRuntimeFiles;
  loadSystemPrompt: () => CubeResult<string>;
}

export interface CubeRuntime {
  session: CubeSession;
  preparePrompt: () => Promise<CubeResult<void>>;
  followUp: (content: string) => Promise<void>;
  getModelSelection: () => ModelSelection;
  listAvailableModels: ModelCatalog["list"];
  prepareModelSelection: (
    selection: ModelSelection,
    entry: ModelCatalogEntry | null,
  ) => SelectionValidationResult;
  applyModelSelection: (prepared: PreparedModelSelection) => Promise<void>;
  warnings: string[];
  finalizeThreadMemory: (threadId: string) => Promise<FinalizeMemoryResult>;
  close: () => Promise<void>;
}

export const prepareSessionForFreshProcess = async (
  session: FreshProcessSession,
): Promise<void> => {
  const boundThreadId = session.thread.getId();
  if (!boundThreadId) return;

  const messages = await session.thread.listActiveMessages({ limit: 1 });
  if (messages.length === 0) {
    await session.thread.delete({ threadId: boundThreadId });
    return;
  }

  session.thread.detachFromCurrent();
  await session.thread.clearAndReleaseLock();
};

export const createCubeRuntime = async (
  input: CreateCubeRuntimeInput,
): Promise<CubeRuntime> => {
  const threadId = randomUUID();
  const resourceId = input.identity.resourceId;
  const cubeLogger = createLogger(threadId, input.runtimeFiles.threadLog);
  const logger = cubeLogger.logger;
  const workspace = createAgentWorkspace(logger, input.identity.canonicalPath);
  const resolveModel = createModelResolver(input.config.providers.ollama.base_url);
  const catalog = createModelCatalog({
    ollamaBaseUrl: input.config.providers.ollama.base_url,
  });
  const storageUrl = input.runtimeFiles.memoryDatabase === ":memory:"
    ? ":memory:"
    : pathToFileURL(input.runtimeFiles.memoryDatabase).href;
  const storage = new LibSQLStore({
    id: "cube-memory",
    url: storageUrl,
  });
  let cubeController: CubeController | undefined;
  let systemPrompt: ReturnType<typeof createSystemPrompt> | undefined;

  try {
    await workspace.init();
    await storage.init();

    const initialSelection = await resolveInitialModelSelection(
      {
        modelId: input.config.model,
        config: input.config.model_config,
      },
      catalog.find,
    );
    const activeSelection = createActiveModelSelection(initialSelection.prepared);

    const memory = createMemory({
      storage,
      config: input.config.memory,
      actorModel: resolveModel(input.config.model),
      resolveModel,
    });
    const cubeAgent = createDefaultAgent({
      getInstructions: () => {
        if (!systemPrompt) {
          throw new Error("System prompt runtime is not ready.");
        }
        return systemPrompt.getInstructions();
      },
      getModelSelection: activeSelection.get,
      fallbackModel: input.config.fallback_model,
      memory,
      resolveModel,
      workspace,
    });
    const controller = createController({
      agent: cubeAgent,
      memory,
      model: input.config.model,
      resourceId,
      workspace,
    });
    cubeController = controller;

    new Mastra({
      agents: { cube: cubeAgent },
      agentControllers: { cube: controller },
      memory: { cube: memory },
      storage,
      logger,
      workspace,
    });

    await controller.init();
    const session = applyConfiguredModel(
      await controller.createSession({
        id: threadId,
        ownerId: resourceId,
        resourceId,
      }),
      input.config.model,
    );
    await prepareSessionForFreshProcess(session);
    systemPrompt = createSystemPrompt(session, input.loadSystemPrompt, threadId);
    const modelSelection = createSessionModelSelection({
      active: activeSelection,
      sessionModel: session.model,
    });

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= Promise.all([
        controller.destroy(),
        workspace.destroy(),
        storage.close(),
        cubeLogger.close(),
      ]).then(() => undefined);
      return closePromise;
    };

    return {
      session,
      preparePrompt: systemPrompt.prepare,
      followUp: async (content) => session.followUp({ content }),
      getModelSelection: modelSelection.getModelSelection,
      listAvailableModels: catalog.list,
      prepareModelSelection,
      applyModelSelection: modelSelection.applyModelSelection,
      warnings: initialSelection.warnings,
      finalizeThreadMemory: (threadId) => finalizeObservationalMemory(memory, {
        threadId,
        resourceId,
      }),
      close,
    };
  } catch (cause) {
    await Promise.allSettled([
      cubeController?.destroy(),
      workspace.destroy(),
      storage.close(),
      cubeLogger.close(),
    ]);
    throw new Error(
      `Failed to initialize Cube runtime at ${input.runtimeFiles.memoryDatabase}`,
      { cause },
    );
  }
};

export {
  createAgentModelList,
  createDefaultAgent,
  createModelResolver,
} from "./agents/default.agent.js";
export { createController } from "./agents/controller.js";
export {
  createMemory,
  finalizeMemory,
  type FinalizeMemoryResult,
} from "./memory.js";
export { createAgentWorkspace } from "./workspace.js";
export {
  createSystemPrompt,
  SYSTEM_PROMPT_SETTING_KEY,
} from "./prompts/system.prompt.js";
export {
  createModelCatalog,
  type CreateModelCatalogInput,
  type ModelCatalog,
  type ModelCatalogEntry,
  type ModelCatalogResult,
} from "./model-catalog.js";
export {
  createActiveModelSelection,
  prepareModelSelection,
  type ActiveModelSelection,
  type ModelSelection,
  type PreparedModelSelection,
  type SelectionValidationResult,
  createSessionModelSelection,
  resolveInitialModelSelection,
  type SessionModelControl,
} from "./model-selection.js";

