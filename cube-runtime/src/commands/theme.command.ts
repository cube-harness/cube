import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";
import type { ThemeItem } from "../contracts/events.contract.js";

export const AVAILABLE_THEMES: ThemeItem[] = [
  { id: "default", name: "Default Cyan" },
  { id: "tokyo-night", name: "Tokyo Night" },
  { id: "dracula", name: "Dracula" },
  { id: "nord", name: "Nord" },
  { id: "cyberpunk", name: "Cyberpunk Neon" },
  { id: "solarized-dark", name: "Solarized Dark" },
  { id: "solarized-light", name: "Solarized Light" },
  { id: "light", name: "Clean Light" },
];

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
    const matched = AVAILABLE_THEMES.find(
      (t) => t.id === argument || t.id.replace(/-/g, "") === argument.replace(/[\s-_]/g, ""),
    );

    const themeToSet = matched ? matched.id : argument;

    await ConfigStore(dependencies.home).update((current) => ({
      ...current,
      theme: themeToSet,
    }));

    dependencies.dispatcher.emit({
      type: "system:message",
      content: `Theme set to: ${matched ? matched.name : themeToSet}`,
    });

    if (dependencies.onThemeSelected) {
      await dependencies.onThemeSelected(themeToSet);
    }
    return;
  }

  // Open interactive theme picker dialog
  dependencies.dispatcher.emit({
    type: "dialog:theme_picker",
    themes: AVAILABLE_THEMES,
    currentThemeId,
  });
};
