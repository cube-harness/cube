import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface NewCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
  onNewThread?: () => void;
  reloadSoul?: () => Promise<void>;
}

export const createNewCommand = (
  deps: NewCommandDependencies,
): CommandHandler => async () => {
  if (deps.session.run.isRunning()) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot start new thread while an agent turn is active.",
    });
    return;
  }

  if (deps.reloadSoul) {
    try {
      await deps.reloadSoul();
    } catch (error: unknown) {
      deps.dispatcher.emit({
        type: "system:message",
        content: `Cannot start new thread: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  }

  deps.session.thread.detachFromCurrent();
  await deps.session.thread.clearAndReleaseLock();
  deps.onNewThread?.();

  deps.dispatcher.emit({ type: "messages:clear" });
  deps.dispatcher.emit({
    type: "state:info",
    info: { threadId: "new thread" },
  });
  deps.dispatcher.emit({
    type: "system:message",
    content: "Started a new conversation thread.",
  });
};
