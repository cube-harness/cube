import { tool } from "@langchain/core/tools";
import { TavilySearch } from "@langchain/tavily";
import * as z from "zod";
import { createLogger } from "@/config/logger.js";
import { env } from "@/config/env.js";

const log = createLogger("tavily-search.tool");

const tavilySearchSchema = z.object({
  query: z.string().describe("The search query to look up on the web."),
});

export const tavilySearchTool = tool(
  async ({ query }, config) => {
    const runLog = log.child({
      threadId: config.configurable?.thread_id,
      query,
    });

    if (!env.TAVILY_API_KEY) {
      runLog.error("Missing TAVILY_API_KEY in env");
      return "Tavily search is not configured (missing API key).";
    }

    const client = new TavilySearch({
      tavilyApiKey: env.TAVILY_API_KEY,
      maxResults: 5,
      topic: "general",
      searchDepth: "basic",
    //   timeRange: "day",
      includeAnswer: false,
      includeRawContent: false,
      includeImages: false,
      includeImageDescriptions: false,
    });

    try {
      const result = await client.invoke({ query });
      runLog.info("Search completed");
      return JSON.stringify(result);
    } catch (e) {
      runLog.error({ err: e }, "Search failed");
      return `Search failed: ${e instanceof Error ? e.message : "unknown error"}`;
    }
  },
  {
    name: "tavily_search",
    description: "Search the web for current information.",
    schema: tavilySearchSchema,
  }
);