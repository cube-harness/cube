// memory.ts
import { Memory } from "@mastra/memory";
import { CubeConfig } from "@cube/workspace";


export const createMemory = (config: CubeConfig): Memory => {
  const wm = config.memory.working_memory;
  const om = config.memory.observational_memory;

  return new Memory({
    options: {
      workingMemory: {
        enabled: wm.enabled,
        scope: wm.scope,
        template: wm.template,
      },
      observationalMemory: om.enabled
        ? {
            model: om.model === "inherit" ? config.model : om.model,
            observation: {
              messageTokens: om.observation.message_tokens,
              bufferTokens: om.observation.buffer_tokens,
              bufferActivation: om.observation.buffer_activation,
              blockAfter: om.observation.block_after,
            },
            reflection: {
              observationTokens: om.reflection.observation_tokens,
              bufferActivation: om.reflection.buffer_activation,
              blockAfter: om.reflection.block_after,
            },
            shareTokenBudget: om.share_token_budget,
          }
        : undefined,
      semanticRecall: config.memory.semantic_recall ? { topK: 3, messageRange: 2 } : false,
    },
  });
};