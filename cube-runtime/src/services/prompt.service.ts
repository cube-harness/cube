import type { Session } from "@cube/agent";
import { HistoryStore, type HomeManager } from "@cube/workspace";
import {
  executeSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
} from "../slash-commands.js";
import { toRuntimeNotice, type PromptResult } from "../types.js";
import type { ThreadService } from "./thread.service.js";

type QueuedFollowUp = NonNullable<ReturnType<Session["followUps"]["dequeue"]>>;

export class PromptService {
  constructor(
    private readonly home: HomeManager,
    private readonly session: Session,
    private readonly thread: ThreadService,
    private readonly commands: SlashCommandContext,
    private readonly runWithThreadLogContext: <T>(callback: () => T) => T,
    private readonly appendHistory = async (text: string, threadId: string) => {
      await HistoryStore(home).append({
        text,
        timestamp: Date.now(),
        threadId,
      });
    },
  ) {}

  async submit(content: string, onDispatch?: (queued: boolean) => void): Promise<PromptResult> {
    const trimmed = content.trim();
    if (!trimmed) return { kind: "ignored" };

    try {
      if (this.commands.permission?.isApplying())
        throw new Error("Wait for permissions to finish applying.");
      const command = parseSlashCommand(trimmed);
      if (command) {
        if (command.name !== "/init")
          await this.appendHistory(trimmed, this.thread.current() ?? "new thread");
        return executeSlashCommand(command.name, command.argument, this.commands);
      }

      return await this.dispatch(trimmed, onDispatch);
    } catch (error) {
      return { kind: "notice", notice: toRuntimeNotice(error) };
    }
  }

  initialize(): Promise<PromptResult> {
    if (
      this.session.run.isRunning() ||
      this.session.approval.isArmed() ||
      this.session.suspensions.hasPending() ||
      this.commands.memory.isBusy()
    ) {
      throw new Error("Finish or cancel the active turn before running /init.");
    }
    return this.dispatch("/init");
  }

  private async dispatch(
    trimmed: string,
    onDispatch?: (queued: boolean) => void,
  ): Promise<PromptResult> {
    if (!(await this.commands.gateway.readiness()).ready) {
      return {
        kind: "gateways",
        request: { choices: await this.commands.gateway.listChoices() },
      };
    }
    const threadId = await this.thread.ensureForPrompt(trimmed);
    await this.appendHistory(trimmed, threadId);
    const warn = console.warn;
    // ponytail: process-global during one queued turn; add a logger bridge if runtimes become concurrent.
    console.warn = () => undefined;
    try {
      await this.runWithThreadLogContext(() => {
        if (this.commands.permission?.isApplying())
          throw new Error("Wait for permissions to finish applying.");
        onDispatch?.(this.session.run.isRunning());
        return this.session.followUp({ content: trimmed });
      });
    } catch (error) {
      try {
        await this.thread.finishRun("error");
      } catch (cleanupError) {
        this.session.emit({ type: "info", message: toRuntimeNotice(cleanupError).message });
      }
      throw error;
    } finally {
      console.warn = warn;
    }
    return { kind: "submitted" };
  }

  cancelLatestQueued(): string | null {
    const queued: QueuedFollowUp[] = [];
    let followUp = this.session.followUps.dequeue();
    while (followUp) {
      queued.push(followUp);
      followUp = this.session.followUps.dequeue();
    }

    const cancelled = queued.pop();
    for (let index = queued.length - 1; index >= 0; index -= 1) {
      this.session.followUps.requeue(queued[index]!);
    }
    if (!cancelled) return null;

    this.session.emit({
      type: "follow_up_queued",
      count: this.session.followUps.count(),
    });
    return cancelled.content;
  }
}
