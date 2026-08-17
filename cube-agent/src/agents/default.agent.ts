import type { Agent, ModelWithRetries } from "@mastra/core/agent";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { Workspace } from "@mastra/core/workspace";
import type { Memory } from "@mastra/memory";
import { createOllama } from "ollama-ai-provider-v2";
import type { PreparedModelSelection } from "../model-selection.js";

export const createModelResolver = (
  ollamaBaseUrl: string,
): ((modelId: string) => MastraModelConfig) => {
  const ollama = createOllama({ baseURL: ollamaBaseUrl, compatibility: "strict" });

  return (modelId) => {
    if (!modelId.startsWith("ollama/")) {
      return modelId as MastraModelConfig;
    }

    const localModelId = modelId.slice("ollama/".length);
    if (!localModelId) {
      throw new Error("Ollama model ID must use the format ollama/<model>.");
    }
    return ollama(localModelId);
  };
};

export const createAgentModelList = (input: {
  active: PreparedModelSelection;
  fallbackModel: string | null;
  resolveModel: (modelId: string) => MastraModelConfig;
}): ModelWithRetries[] => {
  const primary: ModelWithRetries = {
    model: input.resolveModel(input.active.selection.modelId),
    maxRetries: 2,
    ...(input.active.providerOptions
      ? { providerOptions: input.active.providerOptions as ModelWithRetries["providerOptions"] }
      : {}),
  };
  const models = [primary];
  if (input.fallbackModel && input.fallbackModel !== input.active.selection.modelId) {
    models.push({
      model: input.resolveModel(input.fallbackModel),
      maxRetries: 1,
    });
  }
  return models;
};

export const createDefaultAgent = (input: {
  getInstructions: () => string;
  getModelSelection: () => PreparedModelSelection;
  fallbackModel: string | null;
  memory: Memory;
  resolveModel: (modelId: string) => MastraModelConfig;
  workspace: Workspace;
}): Agent => {
  return createCodingAgent({
    id: "cube",
    name: "Cube",
    instructions: () => input.getInstructions(),
    model: () =>
      createAgentModelList({
        active: input.getModelSelection(),
        fallbackModel: input.fallbackModel,
        resolveModel: input.resolveModel,
      }),
    memory: input.memory,
    workspace: input.workspace,
  });
};
