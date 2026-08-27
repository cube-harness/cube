import type { Session } from "@cube/agent";
import type { CommandHandler } from "../command-manager.js";
import type { ActionDispatcher } from "../dispatcher.js";
import type { ThreadSummary } from "../contracts/ui.contract.js";

export interface ResumeCommandDependencies {
  session: Session;
  dispatcher: ActionDispatcher;
}

export const createResumeCommand = (
  deps: ResumeCommandDependencies,
): CommandHandler => async () => {
  if (deps.session.run.isRunning()) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "Cannot switch threads while an agent turn is active.",
    });
    return;
  }

  const threads = await deps.session.thread.list();
  if (!threads || threads.length === 0) {
    deps.dispatcher.emit({
      type: "system:message",
      content: "No previous threads found in this workspace.",
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
};
