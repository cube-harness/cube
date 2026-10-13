import { Memory } from "@mastra/memory";
import type { CubeConfig, HomeManager } from "@cube/workspace";

type MastraMemoryOptions = NonNullable<
  NonNullable<ConstructorParameters<typeof Memory>[0]>["options"]
>;
type DynamicModelContext = {
  requestContext: unknown;
  mastra?: {
    getAgentById: (id: string) => {
      getModel: (options: { requestContext: unknown }) => Promise<unknown>;
    };
  };
};

const resolveActiveAgentModel =
  (activeModel: string) =>
  async ({ requestContext, mastra }: DynamicModelContext) => {
    if (!mastra) return activeModel;

    return mastra.getAgentById("cube-agent").getModel({ requestContext });
  };

const toModel = (model: string, activeModel: string) =>
  model === "inherit" ? resolveActiveAgentModel(activeModel) : model;

export const createMemory = (config: CubeConfig, home: HomeManager): Memory => {
  const memoryConfig = config.memory;

  const generateTitle = !memoryConfig.generate_title.enabled
    ? false
    : {
        model: toModel(memoryConfig.generate_title.model, config.model),
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
