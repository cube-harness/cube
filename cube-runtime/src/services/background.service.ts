import type { BackgroundTask, BackgroundTasksStorage, CommandResult, ProcessRecord, ProcessRegistry } from "@cube/agent";
import { stripVTControlCharacters } from "node:util";
import { toRuntimeNotice, type BackgroundJobRef, type BackgroundJobSummary, type BackgroundJobDetail } from "../types.js";

type History = Pick<BackgroundTasksStorage, "createTask" | "updateTask" | "listTasks" | "getTask">;
const active = (status: string) => ["pending", "running", "suspended"].includes(status);

export class BackgroundService {
  private readonly deleted = new Set<string>();
  private readonly phases = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeProcesses: () => void;
  private pending: Promise<void> = Promise.resolve();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    history: () => Promise<History | undefined>;
    processes: ProcessRegistry;
    workspaceRoot: string;
    currentThread: () => string | null;
    notice: (message: string) => void;
    redact: (text: string) => Promise<string>;
    drain: (threadId?: string) => Promise<void>;
    continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>;
  }) {
    this.unsubscribeProcesses = options.processes.subscribe(record => {
      if (!this.owns(record)) return;
      this.changed();
      const previous = this.phases.get(record.id);
      const phase = `${record.result.status}:${record.completedAt ?? ""}`;
      if (previous === phase) return; // Output chunks only refresh live logs.
      this.phases.set(record.id, phase);
      this.pending = this.pending.then(() => this.save(record, previous === undefined))
        .catch(error => this.error(error));
    });
  }

  private owns(record: ProcessRecord): boolean {
    return record.detached && record.workspaceRoot === this.options.workspaceRoot;
  }

  private process(record: ProcessRecord): BackgroundJobDetail {
    const { result } = record;
    return {
      id: record.id, title: result.command, status: result.status,
      threadId: record.threadId, createdAt: record.createdAt, completedAt: record.completedAt,
      canStop: !this.closing && active(result.status), toolName: "execute_command",
      command: result.command, reason: result.reason, cwd: result.cwd,
      runId: record.runId, toolCallId: record.toolCallId, exitCode: result.exit_code,
      output: result.output, truncated: result.truncated,
      ownerDeleted: Boolean(record.threadId && this.deleted.has(record.threadId)),
    };
  }

  private task(task: BackgroundTask): BackgroundJobDetail {
    const result = task.result as CommandResult | undefined;
    const text = (key: string) => typeof task.args[key] === "string" ? task.args[key] as string : undefined;
    const interrupted = active(task.status);
    return {
      id: task.id, title: text("command") ?? task.toolName,
      // A persisted row is history, never proof that a child is still alive.
      status: interrupted ? "unattached" : task.status, canStop: false,
      threadId: task.threadId, createdAt: new Date(task.createdAt).getTime(),
      completedAt: task.completedAt ? new Date(task.completedAt).getTime() : undefined,
      toolName: task.toolName, command: text("command"), reason: text("reason"),
      cwd: result?.cwd ?? text("cwd"), runId: task.runId, toolCallId: task.toolCallId,
      exitCode: result?.exit_code,
      output: interrupted ? "Process is not attached to this Cube runtime; history is read-only."
        : task.error?.message ?? result?.output ?? "",
      truncated: result?.truncated ?? false,
      ownerDeleted: Boolean(task.threadId && this.deleted.has(task.threadId)),
    };
  }

  private async safe(detail: BackgroundJobDetail): Promise<BackgroundJobDetail> {
    const clean = (text: string) => this.options.redact(
      stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
    );
    const output = detail.output ? await clean(detail.output) : "";
    const tail = output.split("\n").slice(-200).join("\n");
    return {
      ...detail,
      title: (await clean(detail.title)).replace(/\s+/g, " ").slice(0, 500),
      command: detail.command ? (await clean(detail.command)).slice(0, 1000) : undefined,
      reason: detail.reason ? (await clean(detail.reason)).slice(0, 500) : undefined,
      cwd: detail.cwd ? (await clean(detail.cwd)).slice(0, 1000) : undefined,
      output: Buffer.from(tail).subarray(-16384).toString("utf8"),
      truncated: detail.truncated || output !== tail || Buffer.byteLength(tail) > 16384,
    };
  }

  private async save(record: ProcessRecord, create: boolean): Promise<void> {
    const detail = await this.safe(this.process(record));
    const result: CommandResult = {
      ...record.result, command: detail.command ?? "", reason: detail.reason ?? "",
      cwd: detail.cwd ?? "", output: detail.output, truncated: detail.truncated,
    };
    const history = await this.options.history();
    if (!history) throw new Error("Background history storage is unavailable.");
    const completedAt = record.completedAt ? new Date(record.completedAt) : undefined;
    if (create) {
      await history.createTask({
        id: record.id, status: result.status, toolName: "execute_command",
        toolCallId: record.toolCallId ?? record.id, runId: record.runId ?? record.id,
        agentId: "cube-agent", resourceId: record.workspaceRoot, threadId: record.threadId,
        args: { command: result.command, reason: result.reason, cwd: result.cwd, timeout: record.timeoutMs },
        result, createdAt: new Date(record.createdAt), completedAt,
        retryCount: 0, maxRetries: 0, timeoutMs: record.timeoutMs ?? 0,
      });
    } else {
      if (!(await history.updateTask(record.id, { status: result.status, result, completedAt })))
        throw new Error(`Background history record is missing: ${record.id}`);
    }
    if (record.completedAt && record.threadId && !this.closing && !this.deleted.has(record.threadId)) {
      await this.options.continueProcess({ ...record, result }, this.options.currentThread() === record.threadId);
    }
  }

  async list(threadId: string | null = this.options.currentThread()): Promise<BackgroundJobSummary[]> {
    if (!threadId) return [];
    await this.pending;
    const history = await this.options.history();
    const stored = await history?.listTasks({
      agentId: "cube-agent", resourceId: this.options.workspaceRoot, threadId,
      perPage: 100, orderDirection: "desc",
    });
    const jobs = new Map((stored?.tasks ?? []).map(task => [task.id, this.task(task)]));
    for (const record of this.options.processes.list()) {
      if (this.owns(record) && record.threadId === threadId) jobs.set(record.id, this.process(record));
    }
    return (await Promise.all([...jobs.values()].map(async detail => {
      const { id, title, status, threadId, createdAt, completedAt, canStop } = await this.safe({ ...detail, output: "" });
      return { id, title, status, threadId, createdAt, completedAt, canStop };
    }))).sort((a, b) => Number(active(b.status)) - Number(active(a.status)) || b.createdAt - a.createdAt);
  }

  async get({ id }: BackgroundJobRef, threadId: string | null = this.options.currentThread()): Promise<BackgroundJobDetail> {
    const live = this.options.processes.list().find(record => record.id === id);
    if (live) {
      if (!this.owns(live) || !threadId || live.threadId !== threadId) throw new Error("Unknown background process.");
      return this.safe(this.process(live));
    }
    await this.pending;
    const history = await this.options.history();
    const task = await history?.getTask(id);
    if (!task || !threadId || task.threadId !== threadId || task.agentId !== "cube-agent" || task.resourceId !== this.options.workspaceRoot)
      throw new Error("Unknown background process.");
    return this.safe(this.task(task));
  }

  async stop(ref: BackgroundJobRef, threadId: string | null = this.options.currentThread()): Promise<void> {
    const live = this.options.processes.list().find(record => record.id === ref.id);
    if (live && (!this.owns(live) || !threadId || live.threadId !== threadId))
      throw new Error("Unknown background process.");
    if (!live) {
      await this.get(ref, threadId);
      throw new Error("This job is read-only; its execution belongs to another runtime.");
    }
    if (active(live.result.status)) await this.options.processes.stop(ref.id);
    await this.pending;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    if (this.closing || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      for (const listener of this.listeners) listener();
    }, 50);
    this.refreshTimer.unref();
  }

  private async error(error: unknown): Promise<void> {
    if (!this.closing) {
      const message = await this.options.redact(toRuntimeNotice(error).message)
        .catch(() => "Background history or completion delivery failed.");
      this.options.notice(message);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await Promise.all(this.options.processes.list()
      .filter(record => this.owns(record) && record.runId === runId && record.timeoutMs !== null && active(record.result.status))
      .map(record => this.options.processes.stop(record.id)));
    await this.pending;
  }

  async beforeDelete(threadId: string): Promise<void> {
    this.deleted.add(threadId);
    await Promise.all(this.options.processes.list()
      .filter(record => this.owns(record) && record.threadId === threadId && record.timeoutMs !== null && active(record.result.status))
      .map(record => this.options.processes.stop(record.id)));
    await this.pending;
    await this.options.drain(threadId);
    this.changed();
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.closing = true;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.listeners.clear();
      const outcomes = await Promise.allSettled(this.options.processes.list()
        .filter(record => this.owns(record) && active(record.result.status))
        .sort((a, b) => Number(b.result.status === "pending") - Number(a.result.status === "pending"))
        .map(record => this.options.processes.stop(record.id)));
      await this.pending;
      this.unsubscribeProcesses();
      await this.options.drain();
      const failed = outcomes.find(outcome => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.shutdownPromise;
  }
}
