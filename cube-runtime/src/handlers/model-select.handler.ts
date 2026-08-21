import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import { updateCubeAgentModel } from "@cube/agent";
import type { ActionDispatcher } from "../dispatcher.js";
import type { ReasoningEffort } from "../contracts/events.contract.js";

export interface ModelSelectHandlerDeps {
  home: Home;
  agent: any;
  dispatcher: ActionDispatcher;
}

export const createModelSelectHandler = (deps: ModelSelectHandlerDeps) => {
  return async (modelId: string, reasoningEffort?: ReasoningEffort) => {
    // 1. Persist model and reasoning_effort to config.yaml
    await ConfigStore(deps.home).update((current) => ({
      ...current,
      model: modelId,
      model_config: {
        ...current.model_config,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      },
    }));

    // 2. Update Mastra Agent Runtime Model
    updateCubeAgentModel(deps.agent, modelId, reasoningEffort);

    // 3. Emit updated info state
    const modelDisplay = `${modelId}${
      reasoningEffort && reasoningEffort !== "none" ? ` (${reasoningEffort})` : ""
    }`;
    deps.dispatcher.emit({
      type: "state:info",
      info: { model: modelDisplay },
    });

    // 4. Emit confirmation system message
    const effortStr =
      reasoningEffort && reasoningEffort !== "none"
        ? ` [effort: ${reasoningEffort}]`
        : "";
    deps.dispatcher.emit({
      type: "system:message",
      content: `Model set to: ${modelId}${effortStr}`,
    });
  };
};
