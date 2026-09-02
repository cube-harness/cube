import type { Session } from "@cube/agent";
import { HistoryStore, type Home } from "@cube/workspace";
import {
  executeSlashCommand,
  parseSlashCommand,
  type SlashCommandContext,
} from "../slash-commands.js";
import type { PromptResult } from "../types.js";
import type { ThreadService } from "./thread.service.js";

type QueuedFollowUp = NonNullable<
  ReturnType<Session["followUps"]["dequeue"]>
>;

export class PromptService {
  constructor(
    private readonly home: Home,
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

  async submit(content: string): Promise<PromptResult> {
    const trimmed = content.trim();
    if (!trimmed) return { kind: "ignored" };

    const command = parseSlashCommand(trimmed);
    if (command) {
      await this.appendHistory(trimmed, this.thread.current() ?? "new thread");
      return executeSlashCommand(command.name, command.argument, this.commands);
    }

    const threadId = await this.thread.ensureForPrompt(trimmed);
    await this.appendHistory(trimmed, threadId);
    await this.runWithThreadLogContext(() =>
      this.session.followUp({ content: trimmed }),
    );
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
