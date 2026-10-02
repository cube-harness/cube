import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { IMastraLogger } from "@mastra/core/logger";
import { MEMORY_EXTRACT_PROMPT } from "../prompts/memory-extract.prompt.js";

export const createMemoryAgent = (model: MastraModelConfig, logger?: IMastraLogger) =>
  new Agent({
    id: "cube-memory",
    name: "Cube Memory",
    instructions: MEMORY_EXTRACT_PROMPT,
    model,
    ...(logger ? { logger } : {}),
  });
