import { createCodingAgent } from "@mastra/core/coding-agent";
import type { IMastraLogger } from "@mastra/core/logger";
import {
  SoulStore,
  type CubeConfig,
  type HomeManager,
  type WorkspaceManager,
} from "@cube/workspace";
import { createMastraWorkspace } from "../workspace.js";
import { webFetchTool, webSearchTool } from "@mastra/core/tools";
import { getCanonicalModelId } from "../gateways/types.js";

export const buildModelConfig = (
  modelId: string,
  effort?: string,
): Record<string, any> => {
  const canonicalModelId = getCanonicalModelId(modelId);
  const providerOptions: Record<string, any> = {};

  if (
    canonicalModelId.startsWith("google/gemini-3") &&
    effort &&
    effort !== "none" &&
    effort !== "default"
  ) {
    providerOptions.google = {
      thinkingConfig: { thinkingLevel: effort, includeThoughts: true },
    };
  } else if (canonicalModelId.startsWith("google/")) {
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
  } else if (canonicalModelId.startsWith("anthropic/")) {
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
  } else if (/^cube-oauth\/xai\/grok-4\.5(?:$|-)/.test(modelId)) {
    if (effort && ["low", "medium", "high", "xhigh"].includes(effort)) {
      providerOptions.openai = { reasoningEffort: effort };
    }
  } else if (canonicalModelId.startsWith("openai/")) {
    if (effort && effort !== "none" && effort !== "default") {
      providerOptions.openai = { reasoningEffort: effort, reasoningSummary: "auto" };
    }
  } else if (canonicalModelId.startsWith("openrouter/")) {
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
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  };
};

export const updateCubeAgentModel = (
  agent: any,
  modelId: string,
  effort?: string,
): void => {
  const modelConfig = buildModelConfig(modelId, effort);
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
  const modelConfig = buildModelConfig(config.model, effort);
  const mastraWorkspace = await createMastraWorkspace(workspace);

  const agent = createCodingAgent({
    id: "cube-agent",
    name: "Cube Agent",
    model: [modelConfig as any],
    instructions: soul,
    workspace: mastraWorkspace,
    skills: [home.getSkillDir()],
    basePath: paths.root,
    tools: {
      // search: webSearchTool,
      fetch: webFetchTool,
    },
  });

  if (logger) agent.__registerPrimitives({ logger });
  return agent;
};
