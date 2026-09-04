import { ModelsDevGateway } from "@mastra/core/llm";

export type ModelsDevDelegate = Pick<
  ModelsDevGateway,
  "fetchProviders" | "buildUrl" | "resolveLanguageModel"
>;

export const createModelsDevDelegate = (): ModelsDevDelegate => new ModelsDevGateway();
