import crypto from "node:crypto";
import type { Session } from "@cube/agent";
import type {
  RuntimeMessage,
  ThreadSnapshot,
  ThreadSummary,
} from "../types.js";

const activeRunError = (operation: string): Error =>
  new Error(`Cannot ${operation} while an agent turn is active`);

const extractAssistantText = (messages: RuntimeMessage[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant") continue;

    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }

    const parts =
      message.content &&
      typeof message.content === "object" &&
      "parts" in message.content &&
      Array.isArray(message.content.parts)
        ? message.content.parts
        : [];
    const text = parts
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(
            part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string" &&
              part.text.trim(),
          ),
      )
      .map((part) => part.text.trim())
      .join("\n\n");
    if (text) return text;
  }

  return null;
};

export class ThreadService {
  private plannedThreadId: string;

  constructor(
    private readonly session: Session,
    private readonly reloadSoul: () => Promise<void>,
    private readonly createId: () => string = crypto.randomUUID,
  ) {
    this.plannedThreadId = createId();
  }

  current(): string | null {
    return this.session.thread.getId();
  }

  async list(): Promise<ThreadSummary[]> {
    const activeId = this.current();
    return (await this.session.thread.list()).map((thread) => ({
      id: thread.id,
      title: thread.title || "Untitled Thread",
      updatedAt: new Date(thread.updatedAt).toISOString(),
      isActive: thread.id === activeId,
    }));
  }

  async ensureForPrompt(content: string): Promise<string> {
    const activeId = this.current();
    if (activeId) return activeId;
    if (this.session.run.isRunning()) throw activeRunError("create a thread");

    await this.reloadSoul();
    const title = content.trim().replace(/\s+/g, " ") || "New Thread";
    const thread = await this.session.thread.create({
      id: this.plannedThreadId,
      title,
    });
    return thread.id;
  }

  async create(): Promise<{ threadId: null }> {
    if (this.session.run.isRunning()) throw activeRunError("start a new thread");

    await this.reloadSoul();
    this.session.thread.detachFromCurrent();
    await this.session.thread.clearAndReleaseLock();
    this.plannedThreadId = this.createId();
    return { threadId: null };
  }

  async resume(threadId: string): Promise<ThreadSnapshot> {
    if (this.session.run.isRunning()) throw activeRunError("switch threads");

    await this.session.thread.switch({ threadId });
    return this.loadSnapshot(threadId);
  }

  async rename(title: string): Promise<{ threadId: string; title: string }> {
    if (this.session.run.isRunning()) throw activeRunError("rename a thread");
    const threadId = this.current();
    if (!threadId) throw new Error("No active thread to rename");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("Thread title is required");

    await this.session.thread.rename({ title: normalizedTitle });
    return { threadId, title: normalizedTitle };
  }

  async delete(threadId: string): Promise<{ threadId: string; wasActive: boolean }> {
    if (this.session.run.isRunning()) throw activeRunError("delete a thread");
    const wasActive = this.current() === threadId;
    await this.session.thread.delete({ threadId });
    if (wasActive) this.plannedThreadId = this.createId();
    return { threadId, wasActive };
  }

  async fork(title?: string): Promise<ThreadSnapshot> {
    if (this.session.run.isRunning()) throw activeRunError("fork a thread");
    const sourceThreadId = this.current();
    if (!sourceThreadId) throw new Error("No active thread to fork");
    const normalizedTitle = title?.trim() || undefined;
    const clone = await this.session.thread.clone({
      sourceThreadId,
      title: normalizedTitle,
    });
    return this.loadSnapshot(clone.id);
  }

  async lastAssistantContent(): Promise<string | null> {
    const threadId = this.current();
    if (!threadId) return null;
    const messages = await this.session.thread.listMessages({ threadId });
    return extractAssistantText(messages);
  }

  private async loadSnapshot(threadId: string): Promise<ThreadSnapshot> {
    const [thread, messages] = await Promise.all([
      this.session.thread.getById({ threadId }),
      this.session.thread.listMessages({ threadId }),
    ]);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return {
      threadId,
      title: thread.title || "Untitled Thread",
      messages,
    };
  }
}
