import { tool } from "@langchain/core/tools";
import { TavilySearch, TavilyExtract, TavilyCrawl } from "@langchain/tavily";
import * as z from "zod";
import { createLogger } from "@/config/logger.js";
import { env } from "@/config/env.js";

const log = createLogger("tool.system.tavily");

// Chỉ xử lý lỗi thực thi (agent tự sửa được: query rỗng, URL sai, rate limit, timeout...).
// Lỗi cấu hình (thiếu API key) là việc của guardrail, xử lý trước khi tool này được bind vào agent.
function withTavilyLogging<TInput>(
  toolName: string,
  run: (input: TInput) => Promise<unknown>,
) {
  return async (input: TInput, runConfig: { configurable?: { thread_id?: string } }) => {
    const runLog = log.child({
      tool: toolName,
      threadId: runConfig.configurable?.thread_id,
    });

    try {
      const result = await run(input);
      runLog.info("Completed");
      return JSON.stringify(result);
    } catch (e) {
      runLog.error({ err: e }, "Failed");
      return `${toolName} failed: ${e instanceof Error ? e.message : "unknown error"}`;
    }
  };
}

// ---- search ----
export const tavilySearchTool = tool(
  withTavilyLogging("tavily_search", ({ query }: { query: string }) => {
    const client = new TavilySearch({
      tavilyApiKey: env.TAVILY_API_KEY,
      maxResults: 5,
      topic: "general",
      searchDepth: "basic",
      includeAnswer: false,
      includeRawContent: false,
      includeImages: false,
      includeImageDescriptions: false,
    });
    return client.invoke({ query });
  }),
  {
    name: "tavily_search",
    description: "Search the web for current information.",
    schema: z.object({
      query: z.string().describe("The search query to look up on the web."),
    }),
  },
);

// ---- extract ----
export const tavilyExtractTool = tool(
  withTavilyLogging("tavily_extract", ({ urls }: { urls: string[] }) => {
    const client = new TavilyExtract({
      tavilyApiKey: env.TAVILY_API_KEY,
      extractDepth: "basic",
      includeImages: false,
    });
    return client.invoke({ urls });
  }),
  {
    name: "tavily_extract",
    description: "Extract the full raw content from one or more specific URLs.",
    schema: z.object({
      urls: z.array(z.string()).describe("List of URLs to extract content from."),
    }),
  },
);

// ---- crawl ----
export const tavilyCrawlTool = tool(
  withTavilyLogging(
    "tavily_crawl",
    ({ url, instructions }: { url: string; instructions?: string }) => {
      const client = new TavilyCrawl({
        tavilyApiKey: env.TAVILY_API_KEY,
        maxDepth: 1,
        maxBreadth: 20,
        limit: 30,
      });
      return client.invoke({ url, instructions });
    },
  ),
  {
    name: "tavily_crawl",
    description:
      "Crawl a website starting from a base URL and extract content from multiple linked pages.",
    schema: z.object({
      url: z.string().describe("The base URL to start crawling from."),
      instructions: z
        .string()
        .optional()
        .describe("Optional natural-language instructions to guide what content to find."),
    }),
  },
);

export const tavilyTools = [tavilySearchTool, tavilyExtractTool, tavilyCrawlTool];