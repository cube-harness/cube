import type { GraphNode } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import * as z from "zod";
import { MainState } from "@/graph/main/state.js";
import type { ContextType } from "@/graph/main/context.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";
import { getUpdateSummaryPrompt } from "../prompt/summarize.prompt.js";

const SummarySchema = z.object({
  summary: z.string().describe("The updated short-term summary."),
});

export const summarizeNode: GraphNode<typeof MainState, ContextType> = async (
  state
) => {
  const pendingMessages = state.pendingSummaryMessages ?? [];

  if (!pendingMessages.length || !state.pendingSummaryThroughMessageId) {
    return {};
  }

  const model = getLLMProvider();
  const structuredModel = model.withStructuredOutput(SummarySchema);
  const response = await structuredModel.invoke([
    ...pendingMessages,
    new HumanMessage({
      content: getUpdateSummaryPrompt(state.summary ?? ""),
    }),
  ]);

  return {
    summary: response.summary,
    summarizedThroughMessageId: state.pendingSummaryThroughMessageId,
    pendingSummaryMessages: undefined,
    pendingSummaryThroughMessageId: undefined,
  };
};
