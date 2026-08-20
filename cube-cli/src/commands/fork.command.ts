import type { Session } from "@cube/agent";
import type { TuiApp } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface ForkCommandDependencies {
  session: Session;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
  isTurnActive?: () => boolean;
}

const extractMessageText = (raw: any): string => {
  if (typeof raw === "string") return raw;
  if (!raw) return "";
  if (typeof raw.text === "string") return raw.text;
  if (typeof raw.content === "string") return raw.content;

  const parts = Array.isArray(raw.parts)
    ? raw.parts
    : raw.content && Array.isArray(raw.content.parts)
      ? raw.content.parts
      : [];

  if (parts.length > 0) {
    const textParts = parts
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        if (typeof p.text === "string") return p.text;
        if (p.data && typeof p.data.contents === "string") return p.data.contents;
        if (p.data && typeof p.data.text === "string") return p.data.text;
        return "";
      })
      .filter(Boolean);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  return "";
};

export const createForkCommandHandler = (
  deps: ForkCommandDependencies,
): CommandHandler => async (rawArgument: string) => {
  if (deps.isTurnActive?.()) {
    deps.showMessage("Cannot fork thread while an agent turn is active.");
    return;
  }

  const app = deps.getApp();
  if (!app) {
    deps.showMessage("Cube TUI is not ready.");
    return;
  }

  const currentId = deps.session.thread.getId();
  if (!currentId) {
    deps.showMessage("Cannot fork an empty session. Start a conversation first.");
    return;
  }

  const title = rawArgument.trim() || undefined;

  try {
    const cloned = await deps.session.thread.clone({
      sourceThreadId: currentId,
      title,
    });

    if (!cloned || !cloned.id) {
      deps.showMessage("Failed to clone conversation thread.");
      return;
    }

    await deps.session.thread.switch({ threadId: cloned.id });
    const rawMessages = await deps.session.thread.listMessages({
      threadId: cloned.id,
    });

    const messages: Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }> = [];

    for (const raw of rawMessages) {
      if (typeof raw === "object" && raw !== null) {
        const msg = raw as Record<string, unknown>;
        const role: "user" | "assistant" | "system" =
          msg.role === "assistant" || msg.role === "system"
            ? (msg.role as "assistant" | "system")
            : "user";

        const content = extractMessageText(raw);
        if (content.trim()) {
          messages.push({ role, content: content.trim() });
        }
      }
    }

    app.setMessages(messages);
    app.setInfo({ threadId: cloned.id });
    deps.showMessage(
      `• Forked thread into: ${cloned.id}${title ? ` ("${title}")` : ""}`,
    );
  } catch (error: unknown) {
    deps.showMessage(
      `Failed to fork thread: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
