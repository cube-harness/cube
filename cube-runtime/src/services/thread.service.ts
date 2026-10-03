import crypto from "node:crypto";
import type { Session, InstructionSnapshot } from "@cube/agent";
import type { RuntimeMessage, ThreadSnapshot, ThreadSummary } from "../types.js";

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
      .filter((part): part is { type: "text"; text: string } =>
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
  private pendingCreation?: string;
  private readonly snapshots = new Map<string, InstructionSnapshot>();

  constructor(
    private readonly session: Session,
    private readonly instructions: {
      read: () => InstructionSnapshot;
      install: (snapshot: InstructionSnapshot) => void;
      reload: (includeDiscovered?: boolean) => Promise<void>;
      refresh: (saved: unknown) => Promise<InstructionSnapshot>;
    },
    private readonly createId: () => string = crypto.randomUUID,
    private readonly context?: {
      fork(id: string, title?: string): Promise<{ id: string }>;
      invalidate(): void;
      isBusy(): boolean;
      drain?(): Promise<void>;
      onActivated?(threadId: string): void;
    },
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
    if (activeId) {
      if (!this.snapshots.has(activeId)) await this.activateInstructions(activeId);
      return activeId;
    }
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("create a thread");

    const snapshot = this.instructions.read();
    const title = content.trim().replace(/\s+/g, " ") || "New Thread";
    const thread = await this.session.thread.create({
      id: this.plannedThreadId,
      title,
    });
    this.pendingCreation = thread.id;
    await this.saveInstructions(snapshot);
    this.instructions.install(snapshot);
    this.context?.onActivated?.(thread.id);
    return thread.id;
  }

  async create(): Promise<{ threadId: null }> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("start a new thread");

    await this.instructions.reload();
    this.session.thread.detachFromCurrent();
    await this.session.thread.clearAndReleaseLock();
    this.plannedThreadId = this.createId();
    this.pendingCreation = undefined;
    return { threadId: null };
  }

  async resume(threadId: string): Promise<ThreadSnapshot> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("switch threads");

    const snapshot = await this.prepareInstructions(threadId);
    this.context?.invalidate();
    await this.session.thread.switch({ threadId });
    this.instructions.install(snapshot);
    this.snapshots.set(threadId, snapshot);
    this.pendingCreation = undefined;
    this.context?.onActivated?.(threadId);
    return this.loadSnapshot(threadId);
  }

  async rename(title: string): Promise<{ threadId: string; title: string }> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("rename a thread");
    const threadId = this.current();
    if (!threadId) throw new Error("No active thread to rename");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("Thread title is required");

    await this.session.thread.rename({ title: normalizedTitle });
    return { threadId, title: normalizedTitle };
  }

  async delete(threadId: string): Promise<{ threadId: string; wasActive: boolean }> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("delete a thread");
    const wasActive = this.current() === threadId;
    await this.session.thread.delete({ threadId });
    this.snapshots.delete(threadId);
    if (this.pendingCreation === threadId) this.pendingCreation = undefined;
    if (wasActive) this.plannedThreadId = this.createId();
    return { threadId, wasActive };
  }

  async fork(title?: string): Promise<ThreadSnapshot> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("fork a thread");
    const sourceThreadId = this.current();
    if (!sourceThreadId) throw new Error("No active thread to fork");
    const normalizedTitle = title?.trim() || undefined;
    const snapshot = await this.instructions.refresh(
      this.snapshots.get(sourceThreadId) ?? this.instructions.read(),
    );
    const clone = this.context
      ? await this.context.fork(sourceThreadId, normalizedTitle)
      : await this.session.thread.clone({
          sourceThreadId,
          title: normalizedTitle,
        });
    if (this.context) {
      await this.session.thread.switch({ threadId: clone.id });
      this.context.invalidate();
    }
    await this.saveInstructions(snapshot);
    this.instructions.install(snapshot);
    this.pendingCreation = undefined;
    this.context?.onActivated?.(clone.id);
    return this.loadSnapshot(clone.id);
  }

  async saveInstructions(snapshot: InstructionSnapshot): Promise<void> {
    const threadId = this.current();
    if (!threadId) throw new Error("Cannot save instructions without an active thread");
    await this.session.thread.setSetting({ key: "cubeInstructions", value: snapshot });
    this.snapshots.set(threadId, structuredClone(snapshot));
  }

  async reload(): Promise<void> {
    if (this.session.run.isRunning() || this.context?.isBusy())
      throw activeRunError("reload project context");
    await this.instructions.reload(true);
    const snapshot = this.instructions.read();
    if (this.current()) await this.saveInstructions(snapshot);
  }

  /** Roll back an uncommitted first turn, never an existing conversation. */
  async finishRun(reason?: string): Promise<void> {
    const threadId = this.pendingCreation;
    if (
      !threadId ||
      this.current() !== threadId ||
      (reason !== "complete" && reason !== "error")
    )
      return;
    // agent_end can precede native persistence; inspect only after the stream settles.
    await this.context?.drain?.();
    if (this.current() !== threadId) return;
    if ((await this.session.thread.listMessages({ threadId, limit: 1 })).length) {
      this.pendingCreation = undefined;
      return;
    }
    if (
      reason !== "error" ||
      this.session.followUps.count() ||
      this.session.approval.isArmed() ||
      this.session.suspensions.hasPending()
    )
      return;
    await this.session.thread.delete({ threadId });
    this.snapshots.delete(threadId);
    this.pendingCreation = undefined;
    this.plannedThreadId = this.createId();
    this.context?.invalidate();
  }

  private async prepareInstructions(threadId: string): Promise<InstructionSnapshot> {
    const cached = this.snapshots.get(threadId);
    if (cached) return cached;
    const thread = await this.session.thread.getById({ threadId });
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const snapshot = await this.instructions.refresh(thread.metadata?.cubeInstructions);
    await this.session.thread.setSettingOn({ threadId, key: "cubeInstructions", value: snapshot });
    return snapshot;
  }

  private async activateInstructions(threadId: string): Promise<void> {
    const snapshot = await this.prepareInstructions(threadId);
    this.instructions.install(snapshot);
    this.snapshots.set(threadId, snapshot);
    this.context?.onActivated?.(threadId);
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
