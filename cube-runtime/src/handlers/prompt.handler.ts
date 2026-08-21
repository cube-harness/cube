import type { Session } from "@cube/agent";
import type { ActionDispatcher } from "../dispatcher.js";

export interface PromptHandlerDeps {
  session: Session;
  dispatcher: ActionDispatcher;
  getPlannedThreadId: () => string;
  setPlannedThreadId: (id: string) => void;
}

export const createPromptHandler = (deps: PromptHandlerDeps) => {
  return async (content: string) => {
    try {
      if (deps.session.thread.getId() === null) {
        const plannedId = deps.getPlannedThreadId();
        const title = content.trim().replace(/\s+/g, " ") || "New Thread";
        await deps.session.thread.create({ id: plannedId, title });
        deps.dispatcher.emit({
          type: "state:info",
          info: { threadId: plannedId },
        });
      }

      deps.dispatcher.emit({
        type: "message:add",
        message: { role: "user", content },
      });

      deps.dispatcher.emit({
        type: "turn:start",
        message: "Thinking...",
      });

      await deps.session.sendMessage({ content });

      deps.dispatcher.emit({
        type: "turn:end",
      });
    } catch (err: unknown) {
      deps.dispatcher.emit({
        type: "turn:end",
      });
      deps.dispatcher.emit({
        type: "system:error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
};
