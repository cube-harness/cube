import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";
import type { ThreadSummary } from "../contracts/ui.contract.js";

export interface DeleteCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
  isTurnActive?: () => boolean;
}

export const createDeleteCommand = (
  deps: DeleteCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot delete thread while an agent turn is active.",
    });
    return;
  }

  const argument = rawArgument.trim();
  let targetThreadId = argument;

  if (!targetThreadId) {
    const threads = await deps.session.thread.list();
    if (!threads || threads.length === 0) {
      deps.dispatcher.emit({
        type: "system:message",
        content: "No threads found in this workspace.",
      });
      return;
    }

    const activeId = deps.session.thread.getId();
    const threadSummaries: ThreadSummary[] = threads.map(
      (t: { id: string; title?: string; updatedAt?: Date | string }) => ({
        id: t.id,
        title: t.title || "Untitled Thread",
        updatedAt: t.updatedAt
          ? new Date(t.updatedAt).toISOString()
          : new Date().toISOString(),
        isActive: t.id === activeId,
      }),
    );

    deps.dispatcher.emit({
      type: "dialog:thread_picker",
      threads: threadSummaries,
    });
    return;
  }

  try {
    const currentActiveId = deps.session.thread.getId();
    await deps.session.thread.delete({ threadId: targetThreadId });

    if (targetThreadId === currentActiveId) {
      await deps.session.thread.detachFromCurrent?.();
      deps.dispatcher.emit({ type: "messages:clear" });
      deps.dispatcher.emit({
        type: "state:info",
        info: { threadId: "new thread" },
      });
      deps.dispatcher.emit({
        type: "system:message",
        content: "• Deleted active thread. Started a fresh thread session.",
      });
    } else {
      deps.dispatcher.emit({
        type: "system:message",
        content: `• Deleted thread: ${targetThreadId}`,
      });
    }
  } catch (error: unknown) {
    deps.dispatcher.emit({
      type: "system:error",
      error: `Failed to delete thread: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
};
