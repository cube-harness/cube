import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface StatusLineCommandDependencies {
  dispatcher: ActionDispatcher;
}

export const createStatusLineCommand =
  (deps: StatusLineCommandDependencies): CommandHandler =>
  async () => {
    deps.dispatcher.emit({
      type: "dialog:statusline_picker",
    });
  };
