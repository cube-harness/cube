import type { Agent } from "@mastra/core/agent";
import { AgentController } from "@mastra/core/agent-controller";
import type { Workspace } from "@mastra/core/workspace";
import type { Memory } from "@mastra/memory";

export interface ConfiguredModelSession {
  model: {
    get(): string;
    set(input: { modelId: string }): void;
  };
}

export const applyConfiguredModel = <T extends ConfiguredModelSession>(
  session: T,
  modelId: string,
): T => {
  if (session.model.get() !== modelId) {
    session.model.set({ modelId });
  }
  return session;
};

export const createController = (input: {
  agent: Agent;
  memory: Memory;
  model: string;
  resourceId: string;
  workspace: Workspace;
}): AgentController =>
  new AgentController({
    id: "cube",
    resourceId: input.resourceId,
    agent: input.agent,
    memory: input.memory,
    workspace: input.workspace,
    defaultModeId: "default",
    modes: [
      {
        id: "default",
        name: "Default",
        defaultModelId: input.model,
        metadata: { default: true },
      },
    ],
  });
