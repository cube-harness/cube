import type { Home } from "@cube/workspace";
import { ConfigStore } from "@cube/workspace";
import type { ActionDispatcher } from "../dispatcher.js";

export interface StatusLineSelectHandlerDeps {
  home: Home;
  dispatcher: ActionDispatcher;
  onStatusLineApplied?: (statusLine: string[]) => void;
}

export const createStatusLineSelectHandler = (deps: StatusLineSelectHandlerDeps) => {
  return async (statusLine: string[]) => {
    // 1. Persist status_line to config.yaml
    await ConfigStore(deps.home).update((current) => ({
      ...current,
      status_line: statusLine,
    }));

    // 2. Notify callback if provided
    deps.onStatusLineApplied?.(statusLine);

    // 3. Emit confirmation message
    deps.dispatcher.emit({
      type: "system:message",
      content: `Footer status line configuration saved: "${statusLine.join(" • ")}"`,
    });
  };
};
