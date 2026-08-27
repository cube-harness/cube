import type { Session } from "@cube/agent";
import type { ActionDispatcher } from "../dispatcher.js";

export interface ThreadSelectHandlerDeps {
  session: Session;
  dispatcher: ActionDispatcher;
}

export const createThreadSelectHandler = (deps: ThreadSelectHandlerDeps) => {
  return async (threadId: string) => {
    if (deps.session.run.isRunning()) {
      deps.dispatcher.emit({
        type: "system:message",
        content: "Cannot switch threads while an agent turn is active.",
      });
      return;
    }

    await deps.session.thread.switch({ threadId });
    deps.dispatcher.emit({
      type: "state:info",
      info: { threadId },
    });

    deps.dispatcher.emit({
      type: "system:message",
      content: `Switched to thread: ${threadId}`,
    });
  };
};
