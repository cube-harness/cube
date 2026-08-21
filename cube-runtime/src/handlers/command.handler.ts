import type { CommandManager } from "../command-manager.js";

export interface CommandHandlerDeps {
  commandManager: CommandManager;
}

export const createCommandHandler = (deps: CommandHandlerDeps) => {
  return async (name: `/${string}`, argument: string = "") => {
    await deps.commandManager.execute(name, argument);
  };
};
