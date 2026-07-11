import { TavilySearch } from "@langchain/tavily";

export const tavilySearchTool = new TavilySearch({
  maxResults: 3,
  topic: "general",
  searchDepth: "basic",
});