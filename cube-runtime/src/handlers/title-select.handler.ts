import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import type { ActionDispatcher } from "../dispatcher.js";

export interface TitleSelectHandlerDeps {
  home: Home;
  dispatcher: ActionDispatcher;
  onTitleApplied?: (appTitle: string[]) => void;
}

export const createTitleSelectHandler = (deps: TitleSelectHandlerDeps) => {
  return async (appTitle: string[]) => {
    // 1. Persist app_title to config.yaml
    await ConfigStore(deps.home).update((current) => ({
      ...current,
      app_title: appTitle,
    }));

    // 2. Notify callback if provided
    deps.onTitleApplied?.(appTitle);

    // 3. Emit confirmation message
    deps.dispatcher.emit({
      type: "system:message",
      content: `Terminal title configuration saved: "${appTitle.join(" • ")}"`,
    });
  };
};
