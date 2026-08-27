import type { Home } from "@cube/workspace";
import { HistoryStore } from "@cube/workspace";
import type { CommandManager } from "../command-manager.js";

export interface CommandHandlerDeps {
  home: Home;
  commandManager: CommandManager;
  getThreadId?: () => string | null;
}

export const createCommandHandler = (deps: CommandHandlerDeps) => {
  return async (name: `/${string}`, argument: string = "") => {
    const fullCommand = argument ? `${name} ${argument}` : name;
    void HistoryStore(deps.home)
      .append({
        text: fullCommand,
        timestamp: Date.now(),
        threadId: deps.getThreadId?.() ?? undefined,
      })
      .catch(() => undefined);
    await deps.commandManager.execute(name, argument);
  };
};
