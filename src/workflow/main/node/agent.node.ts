import { GraphNode } from "@langchain/langgraph";
import { MainState } from "@/workflow/main/state.js";
import { createChatModel } from "@/provider/provider-factory.js";
import { tools } from "@/tools/tool-registry.js";
import { SystemMessage } from "@langchain/core/messages";
import { validateContext } from "@/guardrail/context.guardrail.js";

// Model with tool
const model = createChatModel({
  provider: "ollama",
  model: "qwen2.5:7b",
}).bindTools(tools);


const systemPrompt = new SystemMessage("You are a helpful assistant.");

export const agentNode: GraphNode<typeof MainState> = async (state, config) => {
  const { messages, summary } = state;
  const { userId, timeZone } = validateContext(config.context);

  const response = await model.invoke([systemPrompt, ...messages], config);

  return { messages: [response] };
};
