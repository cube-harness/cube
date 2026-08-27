import { createCodingAgent } from "@mastra/core/coding-agent";
import { Home, ConfigStore, SoulStore, WorkspaceManager } from "@cube/workspace";
import { createMemory } from "../memory.js";
import { createOllama } from "ollama-ai-provider-v2";
import { createMastraWorkspace } from "../workspace.js";

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
    const cleanUrl = rawUrl.endsWith("/api")
      ? rawUrl
      : `${rawUrl.replace(/\/+$/, "")}/api`;

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
    providerOptions.google = { thinkingConfig: { thinkingLevel: effort } };
  } else if (modelId.startsWith("google/")) {
    if (effort === "max" || effort === "xhigh") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 32768 } };
    } else if (effort === "high") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 24576 } };
    } else if (effort === "medium") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 8192 } };
    } else if (effort === "low" || effort === "minimal") {
      providerOptions.google = { thinkingConfig: { thinkingBudget: 2048 } };
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
      providerOptions.anthropic = { thinking: { type: "enabled", budget_tokens: budget } };
    }
  } else if (modelId.startsWith("openai/")) {
    if (effort && effort !== "none" && effort !== "default") {
      providerOptions.openai = { reasoningEffort: effort };
    }
  } else if (modelId.startsWith("openrouter/")) {
    if (effort && effort !== "default") {
      providerOptions.openrouter = { reasoning: { effort } };
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

export const reloadCubeAgentSoul = async (agent: any, home: Home): Promise<string> => {
  const soul = await SoulStore(home).read();
  updateCubeAgentSoul(agent, soul);
  return soul;
};

export const createCubeAgent = async (home: Home, workspace: WorkspaceManager) => {
  const config = await ConfigStore(home).read();
  const soul = await SoulStore(home).read();
  const paths = await workspace.getPaths();
  const effort = config.model_config?.reasoning_effort;
  const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;
  const modelConfig = buildModelConfig(config.model, effort, ollamaUrl);
  const mastraWorkspace = await createMastraWorkspace(workspace);

  return createCodingAgent({
    id: "cube-agent",
    name: "Cube Agent",
    model: [modelConfig as any],
    instructions: soul,
    memory: createMemory(config, home),
    workspace: mastraWorkspace,
    basePath: paths.root,
  });
};
