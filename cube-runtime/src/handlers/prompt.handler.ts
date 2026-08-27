import type { Session } from "@cube/agent";
import { HistoryStore, type Home } from "@cube/workspace";
import type { ActionDispatcher } from "../dispatcher.js";

export interface PromptHandlerDeps {
  home: Home;
  session: Session;
  dispatcher: ActionDispatcher;
  getPlannedThreadId: () => string;
  setPlannedThreadId: (id: string) => void;
  runWithThreadLogContext: <T>(callback: () => T) => T;
  reloadSoul?: () => Promise<void>;
}

export const createPromptHandler = (deps: PromptHandlerDeps) => {
  return async (content: string) => {
    try {
      const trimmed = content.trim();
      if (trimmed) {
        void HistoryStore(deps.home)
          .append({
            text: trimmed,
            timestamp: Date.now(),
            threadId: deps.session.thread.getId() ?? deps.getPlannedThreadId(),
          })
          .catch(() => undefined);
      }

      if (deps.session.thread.getId() === null) {
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

        const plannedId = deps.getPlannedThreadId();
        const title = trimmed.replace(/\s+/g, " ") || "New Thread";
        await deps.session.thread.create({ id: plannedId, title });
        deps.dispatcher.emit({
          type: "state:info",
          info: { threadId: plannedId },
        });
      }

      await deps.runWithThreadLogContext(() =>
        deps.session.followUp({ content }),
      );
    } catch (err: unknown) {
      deps.dispatcher.emit({
        type: "system:error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
};
