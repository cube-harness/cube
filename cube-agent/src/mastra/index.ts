import {
  ConfigStore,
  CubeHome,
  CubeWorkspace,
  RunnableConfigSchema,
  createBootstrap,
} from "@cube/workspace";
import { createCubeMastra } from "../bootstrap.js";

const home = CubeHome();
await home.ensure();
await createBootstrap(home).run();

const workspace = CubeWorkspace(home);
const config = RunnableConfigSchema.parse(await ConfigStore(home).read());
const composition = await createCubeMastra(home, workspace, config);

export const mastra = composition.mastra;
// Studio owns this exported instance; use the same tool cleanup as the CLI.
mastra.shutdown = composition.shutdown;
