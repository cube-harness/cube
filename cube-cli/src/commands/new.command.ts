import type { Session } from "@cube/agent";
import type { TuiApp } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface NewCommandDependencies {
  session: Session;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
  onNewThread?: () => void;
}

export const createNewCommandHandler = (
  deps: NewCommandDependencies,
): CommandHandler => async () => {
  if (deps.session.run.isRunning()) {
    deps.showMessage("Cannot start new thread while an agent turn is active.");
    return;
  }

  deps.session.thread.detachFromCurrent();
  await deps.session.thread.clearAndReleaseLock();
  deps.onNewThread?.();

  const app = deps.getApp();
  if (app) {
    app.clearMessages();
    app.setInfo({ threadId: "new thread" });
  }

  deps.showMessage("Started a new conversation thread.");
};
