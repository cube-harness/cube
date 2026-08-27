import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";

export interface ForkCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
  isTurnActive?: () => boolean;
}

export const createForkCommand = (
  deps: ForkCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot fork thread while an agent turn is active.",
    });
    return;
  }

  const currentId = deps.session.thread.getId();
  if (!currentId) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot fork an empty session. Start a conversation first.",
    });
    return;
  }

  const title = rawArgument.trim() || undefined;

  try {
    const cloned = await deps.session.thread.clone({
      sourceThreadId: currentId,
      title,
    });

    if (!cloned || !cloned.id) {
      deps.dispatcher.emit({
        type: "system:message",
        content: "Failed to clone conversation thread.",
      });
      return;
    }

    await deps.session.thread.switch({ threadId: cloned.id });
    deps.dispatcher.emit({
      type: "state:info",
      info: { threadId: cloned.id },
    });

    deps.dispatcher.emit({
      type: "system:message",
      content: `• Forked thread into: ${cloned.id}${title ? ` ("${title}")` : ""}`,
    });
  } catch (error: unknown) {
    deps.dispatcher.emit({
      type: "system:error",
      error: `Failed to fork thread: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};
