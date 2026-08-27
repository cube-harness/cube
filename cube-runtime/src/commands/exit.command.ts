import type { CommandHandler } from "../command-manager.js";

export interface ExitCommandDependencies {
  shutdown: () => Promise<void>;
}

export const createExitCommand = (
  dependencies: ExitCommandDependencies,
): CommandHandler => async () => {
  await dependencies.shutdown();
};
