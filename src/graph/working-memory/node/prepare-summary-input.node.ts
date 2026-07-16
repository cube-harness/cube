import type { GraphNode } from "@langchain/langgraph";
import {
  WORKING_MEMORY_RECENT_TOKENS_TO_KEEP,
  WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS,
} from "@/config/constant.js";
import { MainState } from "@/graph/main/state.js";
import type { ContextType } from "@/graph/main/context.js";
import { prepareSummaryWindow } from "../message-window.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";

export const prepareSummaryInputNode: GraphNode<
  typeof MainState,
  ContextType
> = async (state) => {
  const model = getLLMProvider();
  const window = await prepareSummaryWindow({
    messages: state.messages,
    summarizedThroughMessageId: state.summarizedThroughMessageId,
    triggerTokens: WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS,
    recentTokensToKeep: WORKING_MEMORY_RECENT_TOKENS_TO_KEEP,
    tokenCounter: model,
  });

  if (!window.shouldSummarize) {
    return {
      pendingSummaryMessages: undefined,
      pendingSummaryThroughMessageId: undefined,
    };
  }

  return {
    pendingSummaryMessages: window.messagesToSummarize,
    pendingSummaryThroughMessageId: window.summarizedThroughMessageId,
  };
};
