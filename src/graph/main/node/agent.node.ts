import type { GraphNode } from "@langchain/langgraph";
import { SystemMessage } from "@langchain/core/messages";
import { filterAllowedTools } from "@/middleware/tool_permission.middleware.js";
import { systemTools } from "@/shared/tools/index.js";
import { MainState } from "../state.js";
import { ContextType } from "../context.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";
import { getAgentSystemPrompt } from "@/graph/main/prompt/agent.prompt.js";

export const agentNode: GraphNode<typeof MainState, ContextType> = async (state, config) => {
  const { messages, summary } = state;

  const { userRole, userMemory, locale } = config.context ?? {};

  const allowedTools = filterAllowedTools(systemTools, userRole);

  const model = getLLMProvider();
  const modelWithTools = model.bindTools(allowedTools);

  const systemPrompt = getAgentSystemPrompt(summary, userMemory, locale);

  const response = await modelWithTools.invoke([new SystemMessage(systemPrompt), ...messages]);

  return {
    messages: [response],
  };
};
