import { createCodingAgent } from "@mastra/core/coding-agent";
import type { IMastraLogger } from "@mastra/core/logger";
import {
  SoulStore,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { createOllama } from "ollama-ai-provider-v2";
import { createMastraWorkspace } from "../workspace.js";
import { webFetchTool, webSearchTool } from "@mastra/core/tools";

export const buildModelConfig = (
  modelId: string,
  effort?: string,
  ollamaBaseUrl?: string,
): Record<string, any> => {
  if (modelId.startsWith("ollama/")) {
    const rawModel = modelId.replace(/^ollama\//, "");
    const rawUrl =
      ollamaBaseUrl ||
      process.env.OLLAMA_BASE_URL ||
      process.env.OLLAMA_HOST ||
      "http://127.0.0.1:11434/api";
    const cleanUrl = rawUrl.endsWith("/api") ? rawUrl : `${rawUrl.replace(/\/+$/, "")}/api`;

    const ollamaClient = createOllama({ baseURL: cleanUrl });
    const modelInstance = ollamaClient(rawModel);

    return {
      id: "cube-model",
      model: modelInstance,
      maxRetries: 2,
      enabled: true,
      modelSettings: { temperature: 0.3 },
    };
  }

  const providerOptions: Record<string, any> = {};

  if (
    modelId.startsWith("google/gemini-3") &&
    effort &&
    effort !== "none" &&
    effort !== "default"
  ) {
    providerOptions.google = {
      thinkingConfig: { thinkingLevel: effort, includeThoughts: true },
    };
  } else if (modelId.startsWith("google/")) {
    if (effort === "max" || effort === "xhigh") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 32768, includeThoughts: true },
      };
    } else if (effort === "high") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 24576, includeThoughts: true },
      };
    } else if (effort === "medium") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      };
    } else if (effort === "low" || effort === "minimal") {
      providerOptions.google = {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      };
    } else if (effort === "none") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 0 } };
    }
  } else if (modelId.startsWith("anthropic/")) {
    if (effort && effort !== "none" && effort !== "default") {
      const budget =
        effort === "max" || effort === "xhigh"
          ? 32768
          : effort === "high"
            ? 16384
            : effort === "medium"
              ? 8192
              : 2048;
      providerOptions.anthropic = { thinking: { type: "enabled", budgetTokens: budget } };
    }
  } else if (modelId.startsWith("openai/")) {
    if (effort && effort !== "none" && effort !== "default") {
      providerOptions.openai = { reasoningEffort: effort, reasoningSummary: "auto" };
    }
  } else if (modelId.startsWith("openrouter/")) {
    if (effort === "default") {
      providerOptions.openrouter = { reasoning: { enabled: true, exclude: false } };
    } else if (effort) {
      providerOptions.openrouter = { reasoning: { effort, exclude: false } };
    }
  }

  return {
    id: "cube-model",
    model: modelId,
    maxRetries: 2,
    enabled: true,
    modelSettings: { temperature: 0.3 },
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
};

export const updateCubeAgentModel = (
  agent: any,
  modelId: string,
  effort?: string,
  ollamaBaseUrl?: string,
): void => {
  const modelConfig = buildModelConfig(modelId, effort, ollamaBaseUrl);
  agent.model = [modelConfig];
};

export const updateCubeAgentSoul = (agent: any, soul: string): void => {
  agent.instructions = soul;
};

export const reloadCubeAgentSoul = async (agent: any, home: HomeManager): Promise<string> => {
  const soul = await SoulStore(home).read();
  updateCubeAgentSoul(agent, soul);
  return soul;
};

export const createCubeAgent = async (
  home: HomeManager,
  workspace: WorkspaceManager,
  config: CubeConfig,
  logger?: IMastraLogger,
) => {
  const soul = await SoulStore(home).read();
  const paths = await workspace.getPaths();
  const effort = config.model_config?.reasoning_effort;
  const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;
  const modelConfig = buildModelConfig(config.model, effort, ollamaUrl);
  const mastraWorkspace = await createMastraWorkspace(home, workspace);

  const agent = createCodingAgent({
    id: "cube-agent",
    name: "Cube Agent",
    model: [modelConfig as any],
    instructions: soul,
    workspace: mastraWorkspace,
    basePath: paths.root,
    tools: {
      // search: webSearchTool,
      fetch: webFetchTool,
    },
  });

  if (logger) agent.__registerPrimitives({ logger });
  return agent;
};
