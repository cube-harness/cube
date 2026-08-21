import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import type { ActionDispatcher } from "../dispatcher.js";

export interface ThemeSelectHandlerDeps {
  home: Home;
  dispatcher: ActionDispatcher;
  onThemeApplied?: (themeId: string) => void;
}

export const createThemeSelectHandler = (deps: ThemeSelectHandlerDeps) => {
  return async (themeId: string) => {
    // 1. Persist theme to config.yaml
    await ConfigStore(deps.home).update((current) => ({
      ...current,
      theme: themeId,
    }));

    // 2. Notify callback if provided
    deps.onThemeApplied?.(themeId);

    // 3. Emit confirmation message
    deps.dispatcher.emit({
      type: "system:message",
      content: `Theme set to: ${themeId}`,
    });
  };
};
