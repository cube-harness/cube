import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { LibSQLVector } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import type { CubeConfig, HomeManager } from "@cube/workspace";

type MastraMemoryOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof Memory>[0]>["options"]
>;
type DynamicModelContext = {
  requestContext: unknown;
  mastra?: {
    getAgentById: (id: string) => {
      getModel: (options: { requestContext: unknown }) => Promise<unknown>;
    };
  };
};

const resolveActiveAgentModel =
  (activeModel: string) =>
  async ({ requestContext, mastra }: DynamicModelContext) => {
    if (!mastra) return activeModel;

    return mastra.getAgentById("cube-agent").getModel({ requestContext });
  };

const toModel = (model: string, activeModel: string) =>
  model === "inherit" ? resolveActiveAgentModel(activeModel) : model;

const toSemanticRecall = (config: CubeConfig["memory"]["semantic_recall"]) => {
  if (!config.enabled) return false;

  return {
    topK: config.top_k,
    messageRange: config.message_range,
    scope: config.scope,
    ...(config.threshold === null ? {} : { threshold: config.threshold }),
  };
};

export type CubeMemoryFinalizeResult = {
  enabled: boolean;
  activated: boolean;
  observed: boolean;
  reflected: boolean;
};

export const finalizeCubeAgentMemory = async (
  agent: {
    resolveProcessorById(id: "observational-memory"): Promise<unknown>;
  },
  input: { threadId: string; resourceId?: string },
): Promise<CubeMemoryFinalizeResult> => {
  const processor = await agent.resolveProcessorById("observational-memory");
  const engine =
    processor && typeof processor === "object" && "engine" in processor
      ? (processor as { engine?: unknown }).engine
      : undefined;
  const finalize =
    engine && typeof engine === "object" && "finalize" in engine
      ? (engine as { finalize?: unknown }).finalize
      : undefined;

  if (typeof finalize !== "function") {
    return {
      enabled: false,
      activated: false,
      observed: false,
      reflected: false,
    };
  }

  const { activated, observed, reflected } = (await finalize.call(engine, input)) as {
    activated: boolean;
    observed: boolean;
    reflected: boolean;
  };
  return { enabled: true, activated, observed, reflected };
};

export const createMemory = (config: CubeConfig, home: HomeManager): Memory => {
  const memoryConfig = config.memory;
  const wm = memoryConfig.working_memory;
  const om = memoryConfig.observational_memory;

  const vector = memoryConfig.vector.enabled
    ? new LibSQLVector({
        id: "cube-vector",
        url: `file:${home.getMemoryDbPath()}`,
      })
    : false;

  const embedder = memoryConfig.embedder.enabled
    ? new ModelRouterEmbeddingModel(memoryConfig.embedder.model!)
    : undefined;

  const generateTitle = !memoryConfig.generate_title.enabled
    ? false
    : {
        model: toModel(memoryConfig.generate_title.model, config.model),
        instructions: memoryConfig.generate_title.instructions,
      };

  const workingMemory = !wm.enabled
    ? { enabled: false as const }
    : {
        enabled: true as const,
        scope: wm.scope,
        useStateSignals: wm.use_state_signals,
        agentManaged: wm.agent_managed,
        template: wm.template,
      };

  const observationalMemory = !om.enabled
    ? false
    : {
        enabled: true as const,
        scope: om.scope,
        activateAfterIdle: om.activate_after_idle,
        activateOnProviderChange: om.activate_on_provider_change,
        shareTokenBudget: om.share_token_budget,
        temporalMarkers: om.temporal_markers,
        retrieval: !om.retrieval.enabled
          ? false
          : {
              vector: om.retrieval.vector,
              scope: om.retrieval.scope,
            },
        observation: {
          model: toModel(om.observation.model, config.model),
          messageTokens: om.observation.message_tokens,
          bufferTokens: om.observation.buffer_tokens,
          bufferOnIdle: om.observation.buffer_on_idle,
          bufferActivation: om.observation.buffer_activation,
          blockAfter: om.observation.block_after,
          previousObserverTokens: om.observation.previous_observer_tokens,
          manageWorkingMemory: om.observation.manage_working_memory,
          threadTitle: om.observation.thread_title,
          observeAttachments: om.observation.observe_attachments,
        },
        reflection: {
          model: toModel(om.reflection.model, config.model),
          observationTokens: om.reflection.observation_tokens,
          bufferActivation: om.reflection.buffer_activation,
          blockAfter: om.reflection.block_after,
        },
      };

  return new Memory({
    vector,
    embedder,
    options: {
      // Cube invariants: keep complete coding-agent history and valid tool pairs.
      readOnly: false,
      lastMessages: Number.MAX_SAFE_INTEGER,
      filterIncompleteToolCalls: true,
      generateTitle: generateTitle as MastraMemoryOptions["generateTitle"],
      workingMemory: workingMemory as MastraMemoryOptions["workingMemory"],
      observationalMemory: observationalMemory as MastraMemoryOptions["observationalMemory"],
      semanticRecall: toSemanticRecall(
        memoryConfig.semantic_recall,
      ) as MastraMemoryOptions["semanticRecall"],
    },
  });
};
