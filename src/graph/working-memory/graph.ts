import { END, START, StateGraph } from "@langchain/langgraph";
import { MainContext } from "@/graph/main/context.js";
import { MainState } from "@/graph/main/state.js";
import { prepareSummaryInputNode } from "./node/prepare-summary-input.node.js";
import { summarizeNode } from "./node/summarize.node.js";

function shouldSummarize(state: typeof MainState.State): "summarize" | typeof END {
  return state.pendingSummaryMessages?.length ? "summarize" : END;
}

export const workingMemoryGraph = new StateGraph(MainState, MainContext)
  .addNode("prepare_summary_input", prepareSummaryInputNode)
  .addNode("summarize", summarizeNode)
  .addEdge(START, "prepare_summary_input")
  .addConditionalEdges("prepare_summary_input", shouldSummarize, [
    "summarize",
    END,
  ])
  .addEdge("summarize", END)
  .compile();
