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
import { workingMemoryGraph } from "@/graph/working-memory/graph.js";
import { shouldRunWorkingMemory } from "@/graph/working-memory/message-window.js";
import { WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS } from "@/config/constant.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";

const shouldContinue: ConditionalEdgeRouter<
  typeof MainState,
  ContextType,
  "tools" | "working_memory" | typeof END
> = async (state) => {
  const lastMessage = state.messages.at(-1);

  if (AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.length) {
    return "tools";
  }

  const model = getLLMProvider();
  const shouldSummarize = await shouldRunWorkingMemory({
    messages: state.messages,
    summarizedThroughMessageId: state.summarizedThroughMessageId,
    triggerTokens: WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS,
    tokenCounter: model,
  });

  if (shouldSummarize) {
    return "working_memory";
  }

  return END;
};


const checkpointer = await getCheckpointer();
const store = await getStore();
const workflow = new StateGraph(MainState, MainContext)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addNode("working_memory", workingMemoryGraph)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, ["tools", "working_memory", END])
  .addEdge("tools", "agent")
  .addEdge("working_memory", END);

export const graph = workflow.compile({ checkpointer, store });
