import { ConfigStore, CubeHome, CubeWorkspace, createBootstrap } from "@cube/workspace";
import { createCubeMastra } from "../bootstrap.js";

const home = CubeHome();
await home.ensure();
await createBootstrap(home).run();

const workspace = CubeWorkspace(home);
const config = await ConfigStore(home).read();
const composition = await createCubeMastra(home, workspace, config);

export const mastra = composition.mastra;
