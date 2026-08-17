import type { SlashCommandHandler } from "./registry.js";

export interface ExitCommandDependencies {
  shutdown: () => Promise<void>;
}

export const createExitCommandHandler = (
  dependencies: ExitCommandDependencies,
): SlashCommandHandler => async () => {
  await dependencies.shutdown();
};
