import { StateGraph, START, END } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";
import { MainState } from "@/workflow/main/state.js";
import { MainContext } from "@/workflow/main/context.js";
import { agentNode } from "@/workflow/main/node/agent.node.js";
import { toolNode } from "@/workflow/main/node/tool.node.js";

const shouldToolCall = (state: typeof MainState.State) => {
  const lastMessage = state.messages.at(-1);

  if (lastMessage && AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.length) {
    return "tools";
  }

  return END;
};

const builder = new StateGraph(MainState, MainContext)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldToolCall, {
    tools: "tools",
    [END]: END,
  })
  .addEdge("tools", "agent");

export const graph = builder.compile();