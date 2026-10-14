import { Memory } from "@mastra/memory";
import type { Agent } from "@mastra/core/agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { CubeConfig, HomeManager } from "@cube/workspace";
import { buildModelConfig } from "./agents/default.agent.js";
import { getModelGateway, toMastraRouterId } from "./gateways/types.js";

type MastraMemoryOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof Memory>[0]>["options"]
>;
type ModelProviderOptions = NonNullable<Awaited<ReturnType<Agent["getModelList"]>>>[number]["providerOptions"];
type DynamicModelContext = {
  requestContext: RequestContext;
  mastra?: {
    getAgentById: (id: string) => Pick<Agent, "getModel" | "getModelList"> & { getActiveModelId(): string };
  };
};

export const resolveMemoryModel = async (
  agent: Pick<Agent, "getModel" | "getModelList">,
  modelId: string,
  selection: Pick<CubeConfig["memory"]["generate_title"], "model" | "reasoning_effort">,
  requestContext?: RequestContext,
): Promise<MastraModelConfig> => {
  const inherit = selection.model === "inherit";
  const [model, models] = await Promise.all([
    agent.getModel({ requestContext, ...(inherit ? {} : { modelConfig: modelId as MastraModelConfig }) }),
    inherit && selection.reasoning_effort === undefined ? agent.getModelList(requestContext) : null,
  ]);
  const providerOptions: ModelProviderOptions = selection.reasoning_effort !== undefined
    ? buildModelConfig(modelId, selection.reasoning_effort).providerOptions
    : models?.find(entry => entry.enabled)?.providerOptions;
  if (!providerOptions) return model;
  // getModel() resolves only the model, dropping per-entry provider options.
  // Native title generation accepts a model but no separate providerOptions.
  return new Proxy(model, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "doGenerate" || key === "doStream")
        return (params: { providerOptions?: ModelProviderOptions }) => value.call(target, {
          ...params, providerOptions: { ...params.providerOptions, ...providerOptions },
        });
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

export const createMemory = (config: CubeConfig, home: HomeManager): Memory => {
  const memoryConfig = config.memory;

  const generateTitle = !memoryConfig.generate_title.enabled
    ? false
    : {
        model: async ({ requestContext, mastra }: DynamicModelContext) => {
          const selection = memoryConfig.generate_title;
          if (!mastra) return selection.model === "inherit" ? config.model : toMastraRouterId(config.gateway, selection.model);
          const agent = mastra.getAgentById("cube-agent");
          const active = agent.getActiveModelId();
          const modelId = selection.model === "inherit" ? active : toMastraRouterId(getModelGateway(active) ?? config.gateway, selection.model);
          return resolveMemoryModel(agent, modelId, selection, requestContext);
        },
        instructions: memoryConfig.generate_title.instructions,
      };

  return new Memory({
    vector: false,
    options: {
      // Cube invariants: keep complete coding-agent history and valid tool pairs.
      readOnly: false,
      lastMessages: Number.MAX_SAFE_INTEGER,
      filterIncompleteToolCalls: true,
      generateTitle: generateTitle as MastraMemoryOptions["generateTitle"],
      workingMemory: { enabled: false },
      observationalMemory: false,
      semanticRecall: false,
    },
  });
};
