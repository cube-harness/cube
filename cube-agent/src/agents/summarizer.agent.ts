import { Agent, type AgentConfig } from "@mastra/core/agent";
import type { IMastraLogger } from "@mastra/core/logger";
import { COMPACT_SYSTEM_PROMPT } from "../prompts/compact.prompt.js";

export const createSummarizerAgent = (model: AgentConfig["model"], logger?: IMastraLogger) =>
  new Agent({
    id: "cube-compactor",
    name: "Cube Compactor",
    instructions: COMPACT_SYSTEM_PROMPT,
    model,
    ...(logger ? { logger } : {}),
  });
