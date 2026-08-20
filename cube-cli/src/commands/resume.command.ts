import type { Session } from "@cube/agent";
import type { TuiApp } from "@cube/tui";
import type { CommandHandler } from "../command-manager.js";

export interface ResumeCommandDependencies {
  session: Session;
  getApp: () => TuiApp | undefined;
  showMessage: (message: string) => void;
}

export const createResumeCommandHandler = (
  deps: ResumeCommandDependencies,
): CommandHandler => async () => {
  if (deps.session.run.isRunning()) {
    deps.showMessage("Cannot switch threads while an agent turn is active.");
    return;
  }

  const app = deps.getApp();
  if (!app) {
    deps.showMessage("Cube TUI is not ready.");
    return;
  }

  const threads = await deps.session.thread.list();
  if (!threads || threads.length === 0) {
    deps.showMessage("No previous threads found in this workspace.");
    return;
  }

  const activeId = deps.session.thread.getId();
  const selectedThreadId = await app.openThreadPicker({
    threads: threads.map((t: { id: string; title?: string; updatedAt?: Date | string }) => ({
      id: t.id,
      title: t.title || "Untitled Thread",
      updatedAt: t.updatedAt
        ? new Date(t.updatedAt).toISOString()
        : new Date().toISOString(),
      isActive: t.id === activeId,
    })),
  });

  if (!selectedThreadId || selectedThreadId === activeId) return;

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

  await deps.session.thread.switch({ threadId: selectedThreadId });
  const rawMessages = await deps.session.thread.listMessages({
    threadId: selectedThreadId,
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
  app.setInfo({ threadId: selectedThreadId });
  deps.showMessage(`Switched to thread: ${selectedThreadId}`);
};
