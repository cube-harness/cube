import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface ThemeCommandDependencies {
  home: Home;
  dispatcher: ActionDispatcher;
  isTurnActive?: () => boolean;
  onThemeSelected?: (themeId: string) => Promise<void> | void;
}

export const createThemeCommandHandler = (
  dependencies: ThemeCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (dependencies.isTurnActive?.()) {
    dependencies.dispatcher.emit({
      type: "system:message",
      content: "Cannot change theme while an agent turn is active.",
    });
    return;
  }

  const config = await ConfigStore(dependencies.home).read().catch(() => null);
  const currentThemeId = config?.theme || "default";

  const argument = rawArgument.trim().toLowerCase();
  if (argument) {
    await ConfigStore(dependencies.home).update((current) => ({
      ...current,
      theme: argument,
    }));

    dependencies.dispatcher.emit({
      type: "system:message",
      content: `Theme set to: ${argument}`,
    });

    if (dependencies.onThemeSelected) {
      await dependencies.onThemeSelected(argument);
    }
    return;
  }

  // Open interactive theme picker dialog in UI
  dependencies.dispatcher.emit({
    type: "dialog:theme",
    currentThemeId,
  });
};
