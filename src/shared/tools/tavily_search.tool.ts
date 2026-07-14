import { tool } from "@langchain/core/tools";
import { TavilySearch } from "@langchain/tavily";
import * as z from "zod";

let tavilySearch: TavilySearch | undefined;

function getTavilySearchTool(): TavilySearch {
  tavilySearch ??= new TavilySearch({
    maxResults: 3,
    topic: "general",
    searchDepth: "basic",
  });

  return tavilySearch;
}

export const tavilySearchTool = tool(
  async (input, runtime) => {
    return getTavilySearchTool().invoke(input, runtime);
  },
  {
    name: "tavily_search",
    description:
      "A search engine optimized for comprehensive, accurate, and trusted results. Useful for answering questions about current events. Input should be a search query.",
    schema: z.object({
      query: z.string(),
      includeDomains: z.array(z.string()).optional(),
      excludeDomains: z.array(z.string()).optional(),
      searchDepth: z.enum(["basic", "advanced"]).optional(),
      includeImages: z.boolean().optional(),
      timeRange: z.enum(["day", "week", "month", "year"]).optional(),
      topic: z.enum(["general", "news", "finance"]).optional(),
    }),
  }
);

