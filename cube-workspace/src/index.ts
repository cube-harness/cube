import os from "node:os";
import path from "node:path";
import { createCubeHome } from "./home.js";
import { resolveWorkspaceIdentity } from "./identity.js";

export {
  ConfigSchema,
  ModelConfigSchema,
  ReasoningEffortSchema,
  type CubeConfig,
  type ModelConfig,
  type ReasoningEffort,
} from "./schemas/config.schema.js";
export type { AgentRuntimeFiles, CubeResult } from "./home.js";
export type { WorkspaceIdentity } from "./identity.js";

export const createCubeWorkspace = (
  options: { home?: string } = {},
) => {
  const home = createCubeHome(options.home ?? path.join(os.homedir(), ".cube"));
  return {
    initialize: home.initialize,
    config: home.config,
    soul: home.soul,
    identity: { resolve: resolveWorkspaceIdentity },
    agentRuntime: home.agentRuntime,
  };
};
