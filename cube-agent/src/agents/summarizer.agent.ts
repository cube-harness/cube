import { Agent, type AgentConfig } from "@mastra/core/agent";
import type { IMastraLogger } from "@mastra/core/logger";
import type { RequestContext } from "@mastra/core/request-context";
import { estimateTokens, type ContextLimits } from "../context.js";
import { COMPACT_SYSTEM_PROMPT } from "../prompts/compact.prompt.js";

export const createSummarizerAgent = (model: AgentConfig["model"], logger?: IMastraLogger) =>
  new Agent({
    id: "cube-compactor",
    name: "Cube Compactor",
    instructions: COMPACT_SYSTEM_PROMPT,
    model,
    ...(logger ? { logger } : {}),
  });

export async function summarizeConversation(
  model: AgentConfig["model"],
  limits: ContextLimits,
  input: {
    text: string;
    maxOutputTokens: number;
    signal: AbortSignal;
    requestContext: RequestContext;
  },
  logger?: IMastraLogger,
) {
  const { context: capacity, output: outputLimit, input: inputLimit } = limits;
  if (!capacity || !outputLimit || !Number.isFinite(capacity) || !Number.isFinite(outputLimit))
    throw new Error("Summarizer has no known context/output limits");
  const outputTokens = Math.min(input.maxOutputTokens, outputLimit, capacity - 1024);
  if (
    outputTokens < 128 ||
    (estimateTokens([COMPACT_SYSTEM_PROMPT, input.text]) ?? Infinity) >
      Math.min(inputLimit ?? Infinity, capacity - outputTokens - 1024)
  )
    throw new Error(
      "Selected summarizer cannot fit the compact request; existing checkpoint preserved",
    );
  const summarizer = createSummarizerAgent(model, logger);
  const output = await summarizer.generate(input.text, {
    abortSignal: input.signal,
    requestContext: input.requestContext,
    maxSteps: 1,
    modelSettings: { maxOutputTokens: outputTokens },
  });
  return { text: output.text, finishReason: output.finishReason, toolCalls: output.toolCalls };
}
