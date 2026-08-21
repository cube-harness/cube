import type { Session } from "@cube/agent";
import type { ActionDispatcher } from "../dispatcher.js";

export interface CancelHandlerDeps {
  session: Session;
  dispatcher: ActionDispatcher;
  onExit?: () => void;
}

export const createCancelHandler = (deps: CancelHandlerDeps) => {
  return async () => {
    if (deps.session.thread.getId() !== null) {
      await deps.session.thread.clearAndReleaseLock().catch(() => undefined);
    }
    deps.onExit?.();
  };
};
