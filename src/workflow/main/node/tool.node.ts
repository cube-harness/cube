import { ToolNode } from "@langchain/langgraph/prebuilt"
import { tools } from "@/tools/tool-registry.js"

export const toolNode = new ToolNode(tools);