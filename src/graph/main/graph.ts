import { AIMessage } from "@langchain/core/messages";
import {
  END,
  START,
  StateGraph,
  type ConditionalEdgeRouter,
} from "@langchain/langgraph";
import { agentNode } from "./node/agent.node.js";
import { toolNode } from "./node/tool.node.js";
import { MainContext, type ContextType } from "./context.js";
import { MainState } from "./state.js";
import { getCheckpointer } from "@/shared/memories/checkpointer.js";
import { getStore } from "@/shared/memories/store.js";

const shouldContinue: ConditionalEdgeRouter<
  typeof MainState,
  ContextType,
  "tools"
> = (state) => {
  const lastMessage = state.messages.at(-1);

  if (AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.length) {
    return "tools";
  }

  return END;
};


const checkpointer = await getCheckpointer();
const store = await getStore();
const workflow = new StateGraph(MainState, MainContext)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, ["tools", END])
  .addEdge("tools", "agent");

export const graph = workflow.compile({ checkpointer, store });
