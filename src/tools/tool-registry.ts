import { tavilyTools } from "@/tools/system/tavily.tool.js";
import { getTimeTool } from "@/tools/system/get-time.tool.js";
import { alwaysEnabled, requireEnv, resolveTools } from "@/guardrail/tool.guardrail.js";
import { env } from "process";


export const tools = resolveTools([
  {
    name: "tavily",
    tools: tavilyTools,
    isEnabled: requireEnv(env.TAVILY_API_KEY),
  },
  {
    name: "time",
    tools: [getTimeTool],
    isEnabled: alwaysEnabled,
  },
]);
