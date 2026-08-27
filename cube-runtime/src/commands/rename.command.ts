import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface RenameCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
  isTurnActive?: () => boolean;
}

export const createRenameCommand = (
  deps: RenameCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot rename thread while an agent turn is active.",
    });
    return;
  }

  const currentThreadId = deps.session.thread.getId();
  if (!currentThreadId) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "No active thread to rename. Send a message or create a thread first.",
    });
    return;
  }

  const title = rawArgument.trim();
  if (!title) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Usage: /rename <new-title>",
    });
    return;
  }

  try {
    await deps.session.thread.rename({ title });
    deps.dispatcher.emit({
      type: "system:message",
      content: `• Renamed thread to: "${title}"`,
    });
  } catch (error: unknown) {
    deps.dispatcher.emit({
      type: "system:error",
      error: `Failed to rename thread: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};
