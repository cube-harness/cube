// index.ts (src/mastra/index.ts) — DUY NHẤT nơi gọi createHome(), rồi truyền xuống theo chuỗi
import { Mastra } from "@mastra/core";
import { PinoLogger } from "@mastra/loggers";
import { LibSQLStore } from "@mastra/libsql";
import { CubeHome, Workspace, createBootstrap } from "@cube/workspace";
import { createCubeAgent } from "./agents/main.agent.js";
import { createCubeController } from "./agents/controller.js";

export type { Session, AgentController } from "@mastra/core/agent-controller";
export { updateCubeAgentModel, buildModelConfig } from "./agents/main.agent.js";

export const home = CubeHome();
await home.ensure();
await createBootstrap(home).run();
export const workspace = Workspace(home);

export const cubeAgent = await createCubeAgent(home, workspace);
export const cubeController = await createCubeController(home, cubeAgent, workspace);

export const mastra = new Mastra({
  agentControllers: { cubeController },
  logger: new PinoLogger({ name: "cube", level: "info" }),
  storage: new LibSQLStore({ id: "mastra-storage", url: `file:${home.getMemoryDbPath()}` }),
});