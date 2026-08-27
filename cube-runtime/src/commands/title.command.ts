import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface TitleCommandDependencies {
  dispatcher: ActionDispatcher;
}

export const createTitleCommand =
  (deps: TitleCommandDependencies): CommandHandler =>
  async () => {
    deps.dispatcher.emit({
      type: "dialog:title_picker",
    });
  };
