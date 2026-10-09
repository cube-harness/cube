import type {
  BackgroundTask,
  BackgroundTasksStorage,
  CommandResult,
  ProcessRecord,
  ProcessRegistry,
} from "@cube/agent";
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import type { NativeSubagentGate } from "@cube/agent";
import type { SubagentRecord, SubagentTarget } from "./subagent.service.js";
import {
  toRuntimeNotice,
  type BackgroundJobRef,
  type BackgroundJobSummary,
  type BackgroundJobDetail,
} from "../types.js";

type History = Pick<BackgroundTasksStorage, "createTask" | "updateTask" | "listTasks" | "getTask">;
const active = (status: string) => ["pending", "running", "suspended"].includes(status);
type DelegationCallbacks = {
  execute(record: SubagentRecord, signal: AbortSignal, suspend: (gate: NativeSubagentGate) => Promise<unknown>): Promise<NonNullable<SubagentRecord["result"]>>;
  deliver(record: SubagentRecord, wake: boolean): Promise<void>;
  cleanup?(): Promise<void>;
};
type DelegationJob = { record: SubagentRecord; callbacks: DelegationCallbacks; abort: AbortController;
  completion?: Promise<void>; gate?: NativeSubagentGate;
  answer?: { resolve(value: unknown): void; reject(error: unknown): void } };

export class BackgroundService {
  private readonly deleted = new Set<string>();
  private readonly phases = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly registries = new Map<
    ProcessRegistry,
    {
      stop: () => void;
      continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>;
    }
  >();
  private pending: Promise<void> = Promise.resolve();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private readonly delegations = new Map<string, DelegationJob>();
  private readonly delegationQueue: string[] = [];
  private delegationSlots = 0;
  private readonly acceptances = new Map<string, Promise<{ id: string }>>();
  private readonly deliveries = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      history: () => Promise<History | undefined>;
      processes: ProcessRegistry;
      workspaceRoot: string;
      currentThread: () => string | null;
      notice: (message: string) => void;
      redact: (text: string) => Promise<string>;
      drain: (threadId?: string) => Promise<void>;
      continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>;
      delegationConfig?: { concurrency: number; timeout_ms: number };
    },
  ) {
    this.attach(options.processes, options.continueProcess);
  }

  enqueueDelegation(
    input: Omit<SubagentRecord, "id" | "status" | "createdAt" | "canInterrupt">,
    callbacks: DelegationCallbacks,
  ): Promise<{ id: string }> {
    const key = JSON.stringify([input.parentThreadId, input.parentRunId, input.toolCallId]);
    const existing = this.acceptances.get(key);
    if (existing) return existing;
    const accepted = this.acceptDelegation(input, callbacks);
    this.acceptances.set(key, accepted);
    void accepted.catch(() => this.acceptances.delete(key));
    return accepted;
  }

  private async acceptDelegation(
    input: Omit<SubagentRecord, "id" | "status" | "createdAt" | "canInterrupt">,
    callbacks: DelegationCallbacks,
  ): Promise<{ id: string }> {
    if (this.closing || this.deleted.has(input.parentThreadId) || input.projectRoot !== this.options.workspaceRoot)
      throw new Error("Delegation owner is unavailable");
    if (!input.parentRunId || !input.toolCallId) throw new Error("Delegation requires a parent run/tool call");
    const stored = await (await this.options.history())?.listTasks({ agentId: "cube-agent", resourceId: input.projectRoot,
      threadId: input.parentThreadId, runId: input.parentRunId, toolCallId: input.toolCallId });
    const previous = stored?.tasks.find(task => task.args.kind === "delegation");
    if (previous) return { id: previous.id };
    const record: SubagentRecord = { ...structuredClone(input), id: randomUUID(), createdAt: Date.now(), status: "queued",
      timeoutMs: this.options.delegationConfig?.timeout_ms ?? 0, canInterrupt: true };
    // Persist acceptance before acknowledging or starting work.
    await this.saveDelegation(record, true);
    if (this.closing || this.deleted.has(record.parentThreadId)) {
      record.status = "cancelled"; await this.saveDelegation(record); throw new Error("Delegation owner closed during acceptance");
    }
    this.delegations.set(record.id, { record, callbacks, abort: new AbortController() });
    this.delegationQueue.push(record.id); this.pumpDelegations(); this.changed();
    return { id: record.id };
  }

  private saveDelegation(record: SubagentRecord, create = false): Promise<void> {
    const snapshot = structuredClone(record);
    const write = this.pending.then(async () => {
      const history = await this.options.history();
      if (!history) throw new Error("Background history storage is unavailable");
      const status = snapshot.status === "queued" ? "pending" : snapshot.status === "waiting_approval" || snapshot.status === "waiting_input" ? "suspended" : snapshot.status === "unattached" ? "failed" : snapshot.status;
      if (create) await history.createTask({ id: snapshot.id, toolName: `agent-${snapshot.agent}`, toolCallId: snapshot.toolCallId!,
        runId: snapshot.parentRunId!, agentId: "cube-agent", resourceId: snapshot.projectRoot, threadId: snapshot.parentThreadId,
        status, args: { kind: "delegation" }, result: snapshot, createdAt: new Date(snapshot.createdAt),
        retryCount: 0, maxRetries: 0, timeoutMs: snapshot.timeoutMs ?? 0 });
      else if (!(await history.updateTask(snapshot.id, { status, result: snapshot,
        completedAt: snapshot.completedAt ? new Date(snapshot.completedAt) : undefined }))) throw new Error("Delegation history record is missing");
    });
    this.pending = write.catch(error => this.error(error));
    return write;
  }

  async updateDelegation(record: SubagentRecord): Promise<void> { await this.saveDelegation(record); this.changed(); }

  private pumpDelegations(): void {
    while (!this.closing && this.delegationSlots < (this.options.delegationConfig?.concurrency ?? 2) && this.delegationQueue.length) {
      const id = this.delegationQueue.shift()!;
      const job = this.delegations.get(id)!;
      if (job.abort.signal.aborted) continue;
      this.delegationSlots++;
      job.completion = this.executeDelegation(job).finally(() => { this.delegationSlots--; this.pumpDelegations(); this.changed(); });
      void job.completion.catch(error => this.error(error));
    }
  }

  private async executeDelegation(job: DelegationJob): Promise<void> {
    const { record, abort, callbacks } = job;
    let timer: ReturnType<typeof setTimeout> | undefined;
    record.status = "running"; record.startedAt = Date.now(); this.changed();
    const timeout = record.timeoutMs ?? 0;
    const deadline = record.startedAt + timeout;
    const check = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        abort.abort(new Error("Subagent timeout")); job.answer?.reject(abort.signal.reason);
        void callbacks.cleanup?.().catch(error => this.error(error));
      } else { timer = setTimeout(check, Math.min(remaining, 2147483647)); timer.unref(); }
    };
    if (timeout > 0) check();
    try {
      await this.saveDelegation(record);
      abort.signal.throwIfAborted();
      record.result = await callbacks.execute(record, abort.signal, async gate => {
        abort.signal.throwIfAborted();
        job.gate = gate; record.gate = gate; record.runId = gate.runId;
        record.status = gate.approval ? "waiting_approval" : "waiting_input";
        const answer = new Promise<unknown>((resolve, reject) => { job.answer = { resolve, reject }; });
        const cancel = () => job.answer?.reject(abort.signal.reason);
        abort.signal.addEventListener("abort", cancel, { once: true });
        try {
          await this.saveDelegation(record); this.changed();
          return await answer;
        } finally {
          abort.signal.removeEventListener("abort", cancel); job.answer = undefined; job.gate = undefined; record.gate = undefined;
          record.status = "running"; this.changed();
        }
      });
      abort.signal.throwIfAborted();
      record.status = record.result.status;
    } catch (error) {
      record.status = abort.signal.aborted ? "cancelled" : "failed";
      record.error = await this.options.redact(toRuntimeNotice(error).message);
      await callbacks.cleanup?.();
    } finally {
      clearTimeout(timer); record.completedAt = Date.now(); record.gate = undefined;
      record.pendingDelivery = `subagent-${record.id}`;
      await this.saveDelegation(record); this.changed();
    }
    if (!this.closing && !this.deleted.has(record.parentThreadId)) {
      await this.deliverDelegation(record, callbacks.deliver, this.options.currentThread() === record.parentThreadId);
    }
  }

  async getDelegation(id: string, parentThreadId: string): Promise<SubagentRecord> {
    const live = this.delegations.get(id)?.record;
    if (live) {
      if (live.parentThreadId !== parentThreadId || this.deleted.has(parentThreadId)) throw new Error("Unknown subagent");
      return live;
    }
    await this.pending;
    if (this.deleted.has(parentThreadId)) throw new Error("Unknown subagent");
    const task = await (await this.options.history())?.getTask(id);
    if (!task || task.args.kind !== "delegation" || task.resourceId !== this.options.workspaceRoot || task.threadId !== parentThreadId || task.agentId !== "cube-agent") throw new Error("Unknown subagent");
    const record = structuredClone(task.result) as SubagentRecord;
    if (["queued", "running", "waiting_approval", "waiting_input"].includes(record.status)) { record.status = "unattached"; record.gate = undefined; }
    return record;
  }

  async listDelegations(parentThreadId: string): Promise<SubagentRecord[]> {
    await this.pending;
    const history = await this.options.history();
    const ids = new Set<string>();
    for (let page = 0; history; page++) {
      const stored = await history.listTasks({ agentId: "cube-agent", resourceId: this.options.workspaceRoot,
        threadId: parentThreadId, page, perPage: 100, orderDirection: "desc" });
      for (const task of stored.tasks) if (task.args.kind === "delegation") ids.add(task.id);
      if ((page + 1) * 100 >= stored.total) break;
    }
    for (const job of this.delegations.values()) if (job.record.parentThreadId === parentThreadId) ids.add(job.record.id);
    return Promise.all([...ids].map(id => this.getDelegation(id, parentThreadId)));
  }

  delegationRunningCount(threadId: string | null): number {
    return [...this.delegations.values()].filter(job => job.record.parentThreadId === threadId && ["running", "waiting_approval", "waiting_input"].includes(job.record.status)).length;
  }
  delegationBusy(): boolean { return this.delegationSlots > 0 || this.delegationQueue.length > 0; }

  deliverDelegation(record: SubagentRecord, deliver: DelegationCallbacks["deliver"], wake = false): Promise<void> {
    const pending = this.deliveries.get(record.id);
    if (pending) return pending;
    const sent = (async () => {
      if (this.closing || this.deleted.has(record.parentThreadId) || record.delivered === record.pendingDelivery) return;
      await deliver(record, wake);
      record.delivered = record.pendingDelivery;
      await this.saveDelegation(record);
    })();
    this.deliveries.set(record.id, sent);
    void sent.finally(() => this.deliveries.delete(record.id)).catch(() => undefined);
    return sent;
  }

  assertDelegationGate(target: SubagentTarget): void {
    const job = this.delegations.get(target.jobId);
    if (!job?.answer || job.abort.signal.aborted || job.gate?.runId !== target.runId || job.gate?.toolCallId !== target.toolCallId)
      throw new Error("Subagent interaction is no longer active");
  }

  async resumeDelegation(target: SubagentTarget, resumeData: unknown): Promise<void> {
    this.assertDelegationGate(target);
    const job = this.delegations.get(target.jobId)!;
    const answer = job.answer!; job.answer = undefined; answer.resolve(resumeData);
  }
  async cancelDelegation(id: string, parentThreadId: string): Promise<void> {
    const job = this.delegations.get(id);
    const record = job?.record ?? await this.getDelegation(id, parentThreadId);
    if (record.parentThreadId !== parentThreadId) throw new Error("Unknown subagent");
    if (!job) throw new Error("This subagent is read-only history");
    job.abort.abort(new Error("Subagent cancelled")); job.answer?.reject(job.abort.signal.reason);
    const queued = this.delegationQueue.indexOf(id);
    if (queued >= 0) {
      this.delegationQueue.splice(queued, 1); record.status = "cancelled"; record.completedAt = Date.now();
      record.error = "Subagent cancelled before execution"; record.pendingDelivery = `subagent-${record.id}`;
      await this.saveDelegation(record);
      if (!this.closing && !this.deleted.has(parentThreadId)) await this.deliverDelegation(record, job.callbacks.deliver);
    }
    await job.callbacks.cleanup?.(); await job.completion; this.changed();
  }

  attach(
    registry: ProcessRegistry,
    continueProcess: (record: ProcessRecord, wake: boolean) => Promise<void>,
  ): () => void {
    const existing = this.registries.get(registry);
    if (existing) throw new Error("Process registry is already attached");
    const stop = registry.subscribe((record) => {
      if (!this.owns(record)) return;
      this.changed();
      const previous = this.phases.get(record.id);
      const phase = `${record.result.status}:${record.completedAt ?? ""}`;
      if (previous === phase) return; // Output chunks only refresh live logs.
      this.phases.set(record.id, phase);
      this.pending = this.pending
        .then(() => this.save(record, previous === undefined))
        .catch((error) => this.error(error));
    });
    this.registries.set(registry, { stop, continueProcess });
    return () => {
      stop();
      this.registries.delete(registry);
    };
  }

  private liveProcesses(): ProcessRecord[] {
    return [...this.registries.keys()].flatMap((registry) => registry.list());
  }
  private registryFor(id: string): ProcessRegistry {
    const registry = [...this.registries.keys()].find((source) =>
      source.list().some((record) => record.id === id),
    );
    if (!registry) throw new Error("Unknown background process.");
    return registry;
  }

  private owns(record: ProcessRecord): boolean {
    return record.detached && record.workspaceRoot === this.options.workspaceRoot;
  }

  runningCount(threadId: string | null = this.options.currentThread()): number {
    if (!threadId) return 0;
    return this.liveProcesses().filter(record =>
      this.owns(record) && record.threadId === threadId && active(record.result.status),
    ).length;
  }

  private process(record: ProcessRecord): BackgroundJobDetail {
    const { result } = record;
    return {
      id: record.id,
      title: result.command,
      status: result.status,
      threadId: record.threadId,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      canStop: !this.closing && active(result.status),
      toolName: "execute_command",
      command: result.command,
      reason: result.reason,
      cwd: result.cwd,
      runId: record.runId,
      toolCallId: record.toolCallId,
      exitCode: result.exit_code,
      output: result.output,
      truncated: result.truncated,
      ownerDeleted: Boolean(record.threadId && this.deleted.has(record.threadId)),
    };
  }

  private task(task: BackgroundTask): BackgroundJobDetail {
    const result = task.result as CommandResult | undefined;
    const text = (key: string) =>
      typeof task.args[key] === "string" ? (task.args[key] as string) : undefined;
    const interrupted = active(task.status);
    return {
      id: task.id,
      title: text("command") ?? task.toolName,
      // A persisted row is history, never proof that a child is still alive.
      status: interrupted ? "unattached" : task.status,
      canStop: false,
      threadId: task.threadId,
      createdAt: new Date(task.createdAt).getTime(),
      completedAt: task.completedAt ? new Date(task.completedAt).getTime() : undefined,
      toolName: task.toolName,
      command: text("command"),
      reason: text("reason"),
      cwd: result?.cwd ?? text("cwd"),
      runId: task.runId,
      toolCallId: task.toolCallId,
      exitCode: result?.exit_code,
      output: interrupted
        ? "Process is not attached to this Cube runtime; history is read-only."
        : (task.error?.message ?? result?.output ?? ""),
      truncated: result?.truncated ?? false,
      ownerDeleted: Boolean(task.threadId && this.deleted.has(task.threadId)),
    };
  }

  private async safe(detail: BackgroundJobDetail): Promise<BackgroundJobDetail> {
    const clean = (text: string) =>
      this.options.redact(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
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
      ...record.result,
      command: detail.command ?? "",
      reason: detail.reason ?? "",
      cwd: detail.cwd ?? "",
      output: detail.output,
      truncated: detail.truncated,
    };
    const history = await this.options.history();
    if (!history) throw new Error("Background history storage is unavailable.");
    const completedAt = record.completedAt ? new Date(record.completedAt) : undefined;
    if (create) {
      await history.createTask({
        id: record.id,
        status: result.status,
        toolName: "execute_command",
        toolCallId: record.toolCallId ?? record.id,
        runId: record.runId ?? record.id,
        agentId: "cube-agent",
        resourceId: record.workspaceRoot,
        threadId: record.threadId,
        args: {
          command: result.command,
          reason: result.reason,
          cwd: result.cwd,
          timeout: record.timeoutMs,
        },
        result,
        createdAt: new Date(record.createdAt),
        completedAt,
        retryCount: 0,
        maxRetries: 0,
        timeoutMs: record.timeoutMs ?? 0,
      });
    } else {
      if (!(await history.updateTask(record.id, { status: result.status, result, completedAt })))
        throw new Error(`Background history record is missing: ${record.id}`);
    }
    if (
      record.completedAt &&
      record.threadId &&
      !this.closing &&
      !this.deleted.has(record.threadId)
    ) {
      const registry = this.registryFor(record.id);
      await this.registries
        .get(registry)!
        .continueProcess({ ...record, result }, this.options.currentThread() === record.threadId);
    }
  }

  async list(
    threadId: string | null = this.options.currentThread(),
  ): Promise<BackgroundJobSummary[]> {
    if (!threadId) return [];
    await this.pending;
    const history = await this.options.history();
    const stored = await history?.listTasks({
      agentId: "cube-agent",
      resourceId: this.options.workspaceRoot,
      threadId,
      toolName: "execute_command",
      perPage: 100,
      orderDirection: "desc",
    });
    const jobs = new Map((stored?.tasks ?? []).filter(task => task.toolName === "execute_command").map((task) => [task.id, this.task(task)]));
    for (const record of this.liveProcesses()) {
      if (this.owns(record) && record.threadId === threadId)
        jobs.set(record.id, this.process(record));
    }
    return (
      await Promise.all(
        [...jobs.values()].map(async (detail) => {
          const { id, title, status, threadId, createdAt, completedAt, canStop } = await this.safe({
            ...detail,
            output: "",
          });
          return { id, title, status, threadId, createdAt, completedAt, canStop };
        }),
      )
    ).sort(
      (a, b) => Number(active(b.status)) - Number(active(a.status)) || b.createdAt - a.createdAt,
    );
  }

  async get(
    { id }: BackgroundJobRef,
    threadId: string | null = this.options.currentThread(),
  ): Promise<BackgroundJobDetail> {
    const live = this.liveProcesses().find((record) => record.id === id);
    if (live) {
      if (!this.owns(live) || !threadId || live.threadId !== threadId)
        throw new Error("Unknown background process.");
      return this.safe(this.process(live));
    }
    await this.pending;
    const history = await this.options.history();
    const task = await history?.getTask(id);
    if (
      !task ||
      task.toolName !== "execute_command" ||
      !threadId ||
      task.threadId !== threadId ||
      task.agentId !== "cube-agent" ||
      task.resourceId !== this.options.workspaceRoot
    )
      throw new Error("Unknown background process.");
    return this.safe(this.task(task));
  }

  async stop(
    ref: BackgroundJobRef,
    threadId: string | null = this.options.currentThread(),
  ): Promise<void> {
    const live = this.liveProcesses().find((record) => record.id === ref.id);
    if (live && (!this.owns(live) || !threadId || live.threadId !== threadId))
      throw new Error("Unknown background process.");
    if (!live) {
      await this.get(ref, threadId);
      throw new Error("This job is read-only; its execution belongs to another runtime.");
    }
    if (active(live.result.status)) await this.registryFor(ref.id).stop(ref.id);
    await this.pending;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
      const message = await this.options
        .redact(toRuntimeNotice(error).message)
        .catch(() => "Background history or completion delivery failed.");
      this.options.notice(message);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    await Promise.all(
      this.liveProcesses()
        .filter(
          (record) =>
            this.owns(record) &&
            record.runId === runId &&
            record.timeoutMs !== null &&
            active(record.result.status),
        )
        .map((record) => this.registryFor(record.id).stop(record.id)),
    );
    await this.pending;
  }

  async beforeDelete(threadId: string): Promise<void> {
    this.deleted.add(threadId);
    const outcomes = await Promise.allSettled([
      ...[...this.delegations.values()].filter(job => job.record.parentThreadId === threadId)
        .map(job => this.cancelDelegation(job.record.id, threadId)),
      ...
      this.liveProcesses()
        .filter(
          (record) =>
            this.owns(record) &&
            record.threadId === threadId &&
            record.timeoutMs !== null &&
            active(record.result.status),
        )
        .map((record) => this.registryFor(record.id).stop(record.id)),
    ]);
    await this.pending;
    await this.options.drain(threadId);
    this.changed();
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async drain(): Promise<void> {
    await this.pending;
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      this.closing = true;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.listeners.clear();
      const outcomes = await Promise.allSettled([
        ...[...this.delegations.values()].map(job => this.cancelDelegation(job.record.id, job.record.parentThreadId)),
        ...this.liveProcesses()
          .filter((record) => this.owns(record) && active(record.result.status))
          .sort(
            (a, b) => Number(b.result.status === "pending") - Number(a.result.status === "pending"),
          )
          .map((record) => this.registryFor(record.id).stop(record.id)),
      ]);
      await this.pending;
      for (const entry of this.registries.values()) entry.stop();
      this.registries.clear();
      await this.options.drain();
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return this.shutdownPromise;
  }
}
