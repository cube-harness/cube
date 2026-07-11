import { getCurrentTimeTool } from "./get_current_time.tool.js";
import { tavilySearchTool } from "./tavily_search.tool.js";

export const systemTools = [getCurrentTimeTool, tavilySearchTool];
