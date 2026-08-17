import type { CubeConfig } from "@cube/workspace";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";

export type FinalizeMemoryResult =
  | { status: "disabled" }
  | { status: "no-op" }
  | {
      status: "completed";
      activated: boolean;
      observed: boolean;
      reflected: boolean;
    };

export const createMemory = (input: {
  storage: LibSQLStore;
  config: CubeConfig["memory"];
  actorModel: MastraModelConfig;
  resolveModel: (modelId: string) => MastraModelConfig;
}): Memory => {
  const config = input.config;
  const working = config.working_memory;
  const observational = config.observational_memory;

  return new Memory({
    storage: input.storage,
    options: {
      semanticRecall: config.semantic_recall,
      workingMemory: working.enabled
        ? {
            enabled: true,
            scope: working.scope,
            useStateSignals: working.use_state_signals,
            agentManaged: working.agent_managed,
            template: working.template,
          }
        : { enabled: false },
      observationalMemory: observational.enabled
        ? {
            enabled: true,
            scope: observational.scope,
            model: observational.model === "inherit"
              ? input.actorModel
              : input.resolveModel(observational.model),
            activateAfterIdle: observational.activate_after_idle,
            activateOnProviderChange: observational.activate_on_provider_change,
            shareTokenBudget: observational.share_token_budget,
            temporalMarkers: observational.temporal_markers,
            retrieval: observational.retrieval,
            observation: {
              messageTokens: observational.observation.message_tokens,
              bufferTokens: observational.observation.buffer_tokens,
              bufferActivation: observational.observation.buffer_activation,
              blockAfter: observational.observation.block_after,
              previousObserverTokens: observational.observation.previous_observer_tokens,
              maxTokensPerBatch: observational.observation.max_tokens_per_batch,
              manageWorkingMemory: observational.observation.manage_working_memory,
              observeAttachments: observational.observation.observe_attachments,
              modelSettings: observational.observation.model_settings,
            },
            reflection: {
              observationTokens: observational.reflection.observation_tokens,
              bufferActivation: observational.reflection.buffer_activation,
              blockAfter: observational.reflection.block_after,
              modelSettings: observational.reflection.model_settings,
            },
          }
        : false,
    },
  });
};

export const finalizeMemory = async (
  memory: Memory,
  input: { threadId: string; resourceId: string },
): Promise<FinalizeMemoryResult> => {
  const engine = await memory.omEngine;
  if (!engine) {
    return { status: "disabled" };
  }

  const result = await engine.finalize(input);
  if (!result.activated && !result.observed && !result.reflected) {
    return { status: "no-op" };
  }

  return {
    status: "completed",
    activated: result.activated,
    observed: result.observed,
    reflected: result.reflected,
  };
};
