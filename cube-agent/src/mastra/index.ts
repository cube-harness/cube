import { CubeHome, Workspace, createBootstrap } from "@cube/workspace";
import { createCubeMastra } from "../bootstrap.js";

export const home = CubeHome();
await home.ensure();
await createBootstrap(home).run();

export const workspace = Workspace(home);
const composition = await createCubeMastra(home, workspace);

export const cubeAgent = composition.agent;
export const cubeController = composition.controller;
export const logger = composition.logger;
export const mastra = composition.mastra;
