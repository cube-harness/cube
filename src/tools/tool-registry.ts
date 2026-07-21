// tools/registry.ts
import { env } from "@/config/env.js";
import { resolveTools, requireEnv } from "@/guardrail/tool.guardrail.js";
import { tavilyTools } from "@/tools/system/tavily.tool.js";
import { getTimeTool } from "@/tools/system/get-time.tool.js";

export const tools = resolveTools([
  {
    name: "tavily",
    tools: tavilyTools,
    isEnabled: requireEnv(env.TAVILY_API_KEY),
  },
  {
    name: "time",
    tools: [getTimeTool],
    isEnabled: () => true, 
  },
]);