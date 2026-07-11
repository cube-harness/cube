import type { GraphNode } from "@langchain/langgraph";
import { RemoveMessage, HumanMessage } from "@langchain/core/messages";
import { SUMMARY_MESSAGE_THRESHOLD } from "@/config/constant.js";
import { MainState, MainStateType } from "../state.js";
import { getNewSummaryPrompt, getUpdateSummaryPrompt } from "../prompt/summarize.prompt.js";
import { ContextType } from "../context.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";
import * as z from "zod";

const SummarySchema = z.object({
  summary: z.string().describe("The updated summary of the conversation."),
});

export function shouldSummarize(state: MainStateType): boolean {
  return state.messages.length >= SUMMARY_MESSAGE_THRESHOLD;
}

export const summarizeNode: GraphNode<typeof MainState, ContextType> = async (state, config) => {
  const { messages, summary } = state;

  const summaryPromptText = summary ? getUpdateSummaryPrompt(summary) : getNewSummaryPrompt();

  const model = getLLMProvider();
  const structuredModel = model.withStructuredOutput(SummarySchema);

  const response = await structuredModel.invoke([
    ...messages,
    new HumanMessage({ content: summaryPromptText }),
  ]);

  const deleteMessages = messages.slice(0, -2).map((m) => new RemoveMessage({ id: m.id! }));

  return {
    summary: response.summary,
    messages: deleteMessages,
  };
};
