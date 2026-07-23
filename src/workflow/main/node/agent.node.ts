import { GraphNode } from "@langchain/langgraph";
import { MainState } from "@/workflow/main/state.js";
import { createChatModel } from "@/provider/provider-factory.js";
import { tools } from "@/tools/tool-registry.js";
import { resolveRuntimeContext } from "@/guardrail/context.guardrail.js";
import { buildSystemPrompt } from "../prompt/system.prompt.js";

// Get Model
const model = createChatModel({ provider: "ollama", model: "qwen2.5:7b" }).bindTools(tools);

export const agentNode: GraphNode<typeof MainState> = async (state, config) => {
  const { messages, summary } = state;
  const context = resolveRuntimeContext(config);

  // SystemPrompt
  const systemPrompt = await buildSystemPrompt(config, {
    userId: context.userId,
    agentId: context.agentId,
    timeZone: context.timeZone,
    locale: context.locale
  });
  console.log(systemPrompt);
  // Call Model
  const response = await model.invoke([systemPrompt, ...messages], config);

  return { messages: [response] };
};