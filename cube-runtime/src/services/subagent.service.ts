import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { loadSubagentDefinitions, type CubeConfig, type HomeManager, type ReasoningEffort,
  type SubagentDefinition } from "@cube/workspace";
import { BUILTIN_SUBAGENTS, spawnAgentSchema, type MemoryStorage, type InstructionSnapshot,
  type ChildRunResult, type SubagentChild, type SubagentOwner, type SubagentTask,
  type SpawnAgentInput, type SpawnAgentResult, type SubagentSummary, type SubagentStatus,
  type GetAgentInput, type SubagentView, type SubagentTarget, type AgentControllerEvent } from "@cube/agent";
import { captureSubagentBaseline, createSubagentWorktree, readSubagentChanges,
  removeSubagentWorktree, releaseSubagentBaseline, type ManagedWorktree, type WorktreeBaseline } from "./worktree.service.js";

export type SubagentRecord = SubagentSummary & {
  parentThreadId: string; projectRoot: string; definition: SubagentDefinition; task: string; cwd: string;
  reasoningEffort?: ReasoningEffort; instructions: InstructionSnapshot; worktree?: ManagedWorktree;
  baseline?: WorktreeBaseline; chainIds?: string[]; chainIndex?: number; result?: ChildRunResult;
  pendingDelivery?: string; delivered?: string; error?: string;
  initialResult?: ChildRunResult;
  initialCancelled?: boolean;
  checkoutRemoved?: boolean;
};
export type SubagentInteraction = { type: "subagent_interaction"; target: SubagentTarget;
  agent: string; description: string; directory: string; event: Extract<AgentControllerEvent, { type: "tool_approval_required" | "tool_suspended" }> } |
  { type: "subagent_interaction_cancelled"; threadId: string; runId?: string };
type Job = { id: string; content: string; initial: boolean; after?: string };
const busy = (status: SubagentStatus) => ["queued", "running", "waiting_approval", "waiting_input"].includes(status);
const unknown = () => new Error("Unknown or unavailable subagent");
const within = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export class SubagentService {
  private catalog: SubagentDefinition[] = [];
  private catalogErrors: { name: string; source: string; message: string }[] = [];
  private readonly records = new Map<string, SubagentRecord>();
  private readonly children = new Map<string, SubagentChild>();
  private readonly jobs: Job[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event?: SubagentInteraction) => void>();
  private readonly key = randomBytes(32);
  private readonly deleted = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly removing = new Set<string>();
  private readonly interrupted = new Set<string>();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private readonly detachChildren = new Map<string, () => void>();

  constructor(private readonly options: {
    home: HomeManager; projectRoot: string; config: CubeConfig; storage: () => Promise<MemoryStorage>;
    readParent: (id: string) => Promise<{ modelId: string; reasoningEffort?: ReasoningEffort; instructions: InstructionSnapshot }>;
    resolveModel: (definition: SubagentDefinition, parent: { modelId: string; reasoningEffort?: ReasoningEffort }) => Promise<{ modelId: string; reasoningEffort?: ReasoningEffort }>;
    toolNames: () => Promise<string[]>;
    createChild: (record: SubagentRecord) => Promise<SubagentChild>;
    deliver: (record: SubagentRecord, wake: boolean) => Promise<void>;
    currentThread: () => string | null; redact: (text: string) => Promise<string>; notice: (text: string) => void;
    attachChild?: (child: SubagentChild, record: SubagentRecord) => () => void;
    drainProcesses?: () => Promise<void>;
    mcpToolNames?: () => string[];
    validateModel?: (record: SubagentRecord) => Promise<void>;
  }) {}

  readCatalog = (): readonly SubagentDefinition[] => this.catalog;
  isBusy = () => this.active.size > 0 || this.jobs.length > 0;
  async reloadCatalog() {
    const loaded = await loadSubagentDefinitions(this.options.home, this.options.projectRoot, BUILTIN_SUBAGENTS);
    this.catalog = loaded.agents;
    this.catalogErrors = loaded.errors;
    this.changed();
  }
  subscribe(listener: (event?: SubagentInteraction) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(event?: SubagentInteraction) { for (const listener of this.listeners) listener(event); }
  private checkOwner(owner: SubagentOwner) {
    if (owner.projectRoot !== this.options.projectRoot || this.deleted.has(owner.parentThreadId)) throw unknown();
  }
  private async owned(owner: SubagentOwner, id: string): Promise<SubagentRecord> {
    this.checkOwner(owner);
    const thread = await (await this.options.storage()).getThreadById({ threadId: id, resourceId: owner.projectRoot });
    const stored = thread?.metadata?.cubeSubagent as SubagentRecord | undefined;
    if (!stored || thread!.resourceId !== owner.projectRoot || stored.projectRoot !== owner.projectRoot ||
      stored.parentThreadId !== owner.parentThreadId || stored.id !== id) throw unknown();
    let record = this.records.get(id);
    if (!record) {
      record = structuredClone(stored);
      if (busy(record.status)) { record.status = "unattached"; record.queuedMessages = 0; }
      this.records.set(id, record);
      if (record.status === "unattached") await this.save(record);
      if (record.pendingDelivery && (record.result || record.error) && record.delivered !== record.pendingDelivery)
        await this.deliver(record, false);
    }
    return record;
  }
  private summary(record: SubagentRecord): SubagentSummary {
    return { id: record.id, agent: record.agent, description: record.description, status: record.status,
      modelId: record.modelId, createdAt: record.createdAt, startedAt: record.startedAt,
      completedAt: record.completedAt, runId: record.runId, queuedMessages: record.queuedMessages,
      isolation: record.isolation, worktreePath: record.worktree?.path, checkoutAvailable: record.checkoutAvailable,
      canInterrupt: busy(record.status) || this.hasProcesses(record), canSend: !this.closing && record.checkoutAvailable };
  }
  private save(record: SubagentRecord) {
    const next = (this.writes.get(record.id) ?? Promise.resolve()).then(async () => {
      const storage = await this.options.storage();
      const thread = await storage.getThreadById({ threadId: record.id, resourceId: record.projectRoot });
      if (!thread) throw unknown();
      await storage.patchThread({ id: record.id, metadata: { ...thread.metadata, cubeSubagent: structuredClone(record) } });
      this.changed();
    });
    this.writes.set(record.id, next.catch(() => undefined));
    return next;
  }
  private hasProcesses(record: SubagentRecord) {
    return this.children.get(record.id)?.tools.processes.list().some(process => ["running", "pending"].includes(process.result.status)) ?? false;
  }
  async list(owner: SubagentOwner): Promise<SubagentSummary[]> {
    this.checkOwner(owner);
    const result: SubagentSummary[] = [];
    for (let page = 0; ; page++) {
      const stored = await (await this.options.storage()).listThreads({ page, perPage: 100, filter: { resourceId: owner.projectRoot } });
      for (const thread of stored.threads) {
        const record = thread.metadata?.cubeSubagent as SubagentRecord | undefined;
        if (record?.parentThreadId === owner.parentThreadId) result.push(this.summary(await this.owned(owner, thread.id)));
      }
      if (!stored.hasMore) break;
    }
    return result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async spawn(owner: SubagentOwner, input: SpawnAgentInput): Promise<SpawnAgentResult> {
    this.checkOwner(owner);
    if (this.closing || this.deleting.has(owner.parentThreadId)) throw new Error("Subagents are shutting down or their parent is being deleted");
    input = spawnAgentSchema.parse(input);
    const storage = await this.options.storage();
    const parentThread = await storage.getThreadById({ threadId: owner.parentThreadId, resourceId: owner.projectRoot });
    if (!parentThread || parentThread.resourceId !== owner.projectRoot || parentThread.metadata?.cubeSubagent) throw unknown();
    const parent = structuredClone(await this.options.readParent(owner.parentThreadId));
    const mode = "tasks" in input ? "parallel" : "chain" in input ? "chain" : "single";
    const tasks: SubagentTask[] = "tasks" in input ? input.tasks : "chain" in input
      ? input.chain.map(item => ({ ...item, isolation: input.isolation })) : [input];
    const names = new Set(await this.options.toolNames());
    const prepared: SubagentRecord[] = [];
    // Complete semantic validation before retaining trees or starting any child model.
    for (const task of tasks) {
      const definition = this.catalog.find(agent => agent.name === task.agent);
      if (!definition) throw new Error(this.catalogErrors.find(error => error.name === task.agent)?.message ?? `Unknown agent role: ${task.agent}`);
      for (const tool of definition.tools ?? []) if (!names.has(tool)) throw new Error(`Unavailable child tool: ${tool}`);
      const resolved = await this.options.resolveModel(definition, parent);
      const isolation = task.isolation ?? definition.isolation ?? "none";
      if (mode === "chain" && prepared.length && prepared[0]!.isolation !== isolation)
        throw new Error("Chain roles have different isolation settings. Set one isolation on the chain.");
      const cwd = await realpath(path.resolve(owner.projectRoot, task.cwd ?? "."));
      if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a working directory: ${cwd}`);
      if (this.options.config.permissions.workspace_only && !within(owner.projectRoot, cwd)) throw new Error(`Permission denied: access on ${task.cwd}`);
      prepared.push({ id: randomUUID(), agent: definition.name, definition: structuredClone(definition),
        description: task.description, task: task.task, status: "queued", ...resolved, instructions: structuredClone(parent.instructions),
        createdAt: Date.now(), queuedMessages: 0, isolation, checkoutAvailable: isolation !== "worktree",
        canInterrupt: true, canSend: true, cwd, ...owner });
    }
    const chainIds = mode === "chain" ? prepared.map(record => record.id) : undefined;
    let baseline: WorktreeBaseline | undefined;
    try {
      for (const [index, record] of prepared.entries()) {
        if (chainIds) { record.chainIds = chainIds; record.chainIndex = index; }
        const now = new Date(record.createdAt);
        await storage.saveThread({ thread: { id: record.id, resourceId: owner.projectRoot,
          title: record.description, createdAt: now, updatedAt: now, metadata: { cubeSubagent: record } } });
        this.records.set(record.id, record);
      }
      if (prepared.some(record => record.isolation === "worktree"))
        baseline = await captureSubagentBaseline(owner.projectRoot, prepared[0]!.id);
      let shared: ManagedWorktree | undefined;
      for (const record of prepared) {
        if (record.isolation === "worktree") {
          record.baseline = baseline;
          await this.save(record);
          const checkout = shared ?? await createSubagentWorktree(this.options.home, baseline!, record.id,
            async (checkout, created) => {
              record.worktree = checkout; record.checkoutAvailable = created;
              if (within(owner.projectRoot, record.cwd)) record.cwd = path.join(checkout.path, path.relative(owner.projectRoot, record.cwd));
              await this.save(record);
            });
          if (mode === "chain") shared = checkout;
          record.worktree = checkout;
          record.checkoutAvailable = true;
          if (within(owner.projectRoot, record.cwd)) record.cwd = path.join(checkout.path, path.relative(owner.projectRoot, record.cwd));
          await this.save(record);
        }
      }
    } catch (error) {
      for (const record of prepared) if (this.records.has(record.id)) {
        record.status = "failed"; record.error = await this.clean(error instanceof Error ? error.message : String(error));
        await this.save(record);
      }
      throw error;
    }
    if (this.closing || this.deleting.has(owner.parentThreadId) || this.deleted.has(owner.parentThreadId))
      throw new Error("Subagents closed during preparation; retained resources are available for cleanup");
    for (const [index, record] of prepared.entries()) this.jobs.push({ id: record.id, content: record.task,
      initial: true, after: mode === "chain" && index > 0 ? prepared[index - 1]!.id : undefined });
    this.pump();
    return { mode, agents: prepared.map(record => this.summary(record)) };
  }

  private pump() {
    if (this.closing) return;
    for (let i = 0; i < this.jobs.length && this.active.size < this.options.config.subagents.concurrency;) {
      const job = this.jobs[i]!;
      const record = this.records.get(job.id)!;
      const previous = job.after ? this.records.get(job.after) : undefined;
      if (previous && (previous.initialCancelled || previous.initialResult?.status === "failed" || previous.initialResult?.status === "cancelled")) {
        this.jobs.splice(i, 1); record.status = "cancelled"; record.initialCancelled = true;
        void this.save(record).catch(error => this.error(error)); continue;
      }
      const sameCheckout = (other: SubagentRecord) => record.worktree && other.worktree?.path === record.worktree.path;
      const locked = [...this.active.keys()].some(id => id === job.id || sameCheckout(this.records.get(id)!));
      const waitingChain = !job.initial && this.jobs.some(other => other.initial && sameCheckout(this.records.get(other.id)!));
      if (locked || waitingChain || this.removing.has(record.worktree?.path ?? "") || this.deleting.has(record.parentThreadId) ||
        (previous && !previous.initialResult)) { i++; continue; }
      this.jobs.splice(i, 1);
      if (previous) job.content = job.content.replaceAll("{previous}", previous.initialResult?.text ?? "");
      this.interrupted.delete(record.id);
      record.status = "running"; record.startedAt = Date.now(); record.runId = undefined; record.error = undefined;
      const running = this.execute(record, job);
      this.active.set(record.id, running);
      void running.finally(() => { this.active.delete(record.id); this.pump(); this.changed(); }).catch(error => this.error(error));
    }
  }
  private async execute(record: SubagentRecord, job: Job) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    try {
      await this.save(record);
      const deadline = record.startedAt! + this.options.config.subagents.timeout_ms;
      const checkDeadline = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          this.interrupted.add(record.id);
          void this.interrupt({ projectRoot: record.projectRoot, parentThreadId: record.parentThreadId }, record.id).catch(error => this.error(error));
        } else { timer = setTimeout(checkDeadline, Math.min(remaining, 2147483647)); timer.unref(); }
      };
      if (this.options.config.subagents.timeout_ms > 0) checkDeadline();
      await this.options.validateModel?.(record);
      let child = this.children.get(record.id);
      if (!child) {
        child = await this.options.createChild(record);
        this.children.set(record.id, child);
        const detach = this.options.attachChild?.(child, record);
        if (detach) this.detachChildren.set(record.id, detach);
      }
      if (this.interrupted.has(record.id) || this.closing) {
        record.status = "cancelled";
        if (job.initial) record.initialCancelled = true;
        await this.save(record);
        return;
      }
      if (!job.initial) record.queuedMessages = Math.max(0, record.queuedMessages - 1);
      stop = child.session.subscribe(event => {
        record.runId = child!.session.getCurrentRunId() ?? record.runId;
        if (event.type === "tool_approval_required" || event.type === "tool_suspended") {
          record.status = event.type === "tool_approval_required" ? "waiting_approval" : "waiting_input";
          const runId = child!.session.getCurrentRunId();
          if (runId) this.changed({ type: "subagent_interaction", target: { threadId: record.id, runId, toolCallId: event.toolCallId },
            agent: record.agent, description: record.description, directory: record.cwd, event });
        } else if (event.type === "tool_end" || event.type === "agent_start") record.status = "running";
        if (["agent_start", "tool_end", "tool_approval_required", "tool_suspended"].includes(event.type))
          void this.save(record).catch(error => this.error(error));
      });
      const result = await child.run(job.content);
      await child.drain();
      result.text = await this.clean(result.text);
      if (result.error) result.error = await this.clean(result.error);
      record.result = result; record.runId = result.runId; record.status = result.status;
      if (job.initial) record.initialResult = structuredClone(result);
      record.completedAt = result.completedAt;
      record.pendingDelivery = `subagent-${record.id}-${result.runId}`;
      await this.save(record);
      await this.deliver(record, this.options.currentThread() === record.parentThreadId).catch(error => this.error(error));
    } catch (error) {
      record.status = "failed"; record.error = await this.clean(error instanceof Error ? error.message : String(error));
      record.result = undefined;
      if (job.initial) record.initialCancelled = true;
      record.completedAt = Date.now();
      // A dispatch/factory failure has no native run ID. Keep its stable delivery ID, not a fabricated run.
      record.pendingDelivery = `subagent-${record.id}-dispatch-${randomUUID()}`;
      await this.save(record);
      await this.deliver(record, this.options.currentThread() === record.parentThreadId).catch(error => this.error(error));
    } finally {
      clearTimeout(timer); stop?.();
      this.changed({ type: "subagent_interaction_cancelled", threadId: record.id, runId: record.runId });
    }
  }
  private async deliver(record: SubagentRecord, wake: boolean) {
    if (!record.pendingDelivery || record.delivered === record.pendingDelivery || this.deleted.has(record.parentThreadId) || this.deleting.has(record.parentThreadId)) return;
    await this.options.deliver(structuredClone(record), wake);
    record.delivered = record.pendingDelivery;
    await this.save(record);
  }
  private clean(text: string) { return this.options.redact(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")); }
  private error(error: unknown) { void this.clean(error instanceof Error ? error.message : String(error)).then(text => this.options.notice(text)); }

  async send(owner: SubagentOwner, input: { id: string; message: string }) {
    const record = await this.owned(owner, input.id);
    const check = () => {
      if (this.closing || this.deleting.has(record.parentThreadId) || this.deleted.has(record.parentThreadId) ||
        !record.checkoutAvailable || this.removing.has(record.worktree?.path ?? ""))
        throw new Error("Child checkout is unavailable; spawn a new child");
    };
    check();
    if (!input.message.trim()) throw new Error("Follow-up must not be empty");
    if (record.worktree) await realpath(record.worktree.path);
    check();
    this.jobs.push({ id: record.id, content: input.message, initial: false });
    record.queuedMessages++;
    if (!this.active.has(record.id)) record.status = "queued";
    await this.save(record); this.pump();
    return { id: record.id, queued: this.jobs.some(job => job.id === record.id && !job.initial) };
  }
  async interrupt(owner: SubagentOwner, id: string) {
    const record = await this.owned(owner, id);
    return this.cancel(record);
  }
  private async cancel(record: SubagentRecord) {
    const id = record.id;
    for (let i = this.jobs.length - 1; i >= 0; i--) if (this.jobs[i]!.id === id) this.jobs.splice(i, 1);
    record.queuedMessages = 0;
    const child = this.children.get(id);
    const requested = this.active.has(id);
    if (requested) this.interrupted.add(id);
    child?.session.abort();
    if (child) for (const process of child.tools.processes.list().sort((a, b) => Number(b.result.status === "pending") - Number(a.result.status === "pending")))
      if (["running", "pending"].includes(process.result.status))
      await child.tools.processes.stop(process.id);
    if (!requested && busy(record.status)) { record.status = "cancelled"; record.initialCancelled ??= !record.initialResult; }
    await this.save(record); this.pump();
    return { id, requested, status: record.status };
  }
  async refreshPermissions() {
    for (const child of this.children.values()) {
      const { configureCubePermissions } = await import("@cube/agent");
      await configureCubePermissions(child.session, this.options.config.permissions, this.options.mcpToolNames?.() ?? []);
      child.tools.discardPreview(); child.agent.refreshPermissions();
    }
  }
  getChild(target: SubagentTarget): SubagentChild {
    const child = this.children.get(target.threadId);
    if (!child || child.session.getCurrentRunId() !== target.runId || !this.active.has(target.threadId)) throw unknown();
    return child;
  }

  async get(owner: SubagentOwner, input: GetAgentInput): Promise<SubagentView> {
    const record = await this.owned(owner, input.id);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
    if (input.view === "status") return { id: record.id, view: input.view, status: record.status, data: this.summary(record), truncated: false };
    let text: string, revision: string, pageRevision = "";
    let page = 0, offset = 0;
    const token = input.cursor ? this.decode(input.cursor) : undefined;
    const identity = JSON.stringify([owner, input.id, input.view, limit]);
    if (token && token.identity !== identity) throw new Error("Invalid subagent continuation owner/view");
    if (token) { page = token.page; offset = token.offset; }
    let nextPage = false;
    if (input.view === "result") {
      text = JSON.stringify(record.result ?? (record.error ? { status: "failed", error: record.error, toolActivity: [] } : { unavailable: "No settled run result" }));
      revision = record.result?.runId ?? record.pendingDelivery ?? "no-result";
    } else if (input.view === "changes") {
      if (!record.worktree || !record.checkoutAvailable) return { id: record.id, view: input.view, status: record.status,
        data: { text: "", unavailable: record.isolation === "none" ? "Shared-directory changes cannot be attributed to this child" : "Checkout was removed" }, truncated: false };
      const changes = await readSubagentChanges(record.worktree);
      text = JSON.stringify(changes); revision = changes.revision;
    } else {
      const storage = await this.options.storage();
      const thread = await storage.getThreadById({ threadId: record.id, resourceId: owner.projectRoot });
      const messages = await storage.listMessages({ threadId: record.id, resourceId: owner.projectRoot,
        perPage: limit, page, orderBy: { field: "createdAt", direction: "ASC" } });
      text = JSON.stringify(messages.messages, (key, value) => {
        if (["data", "base64", "fileData", "image"].includes(key) && typeof value === "string" && value.length > 1024) return "[binary media omitted]";
        return value;
      }); nextPage = messages.hasMore;
      revision = String(new Date(thread!.updatedAt).getTime());
    }
    text = await this.clean(text);
    pageRevision = createHash("sha256").update(text).digest("hex");
    if (token && (token.revision !== revision || (token.pageRevision && token.pageRevision !== pageRevision)))
      throw new Error("Subagent continuation is stale; read from the beginning");
    if (offset < 0 || offset > text.length) throw new Error("Invalid subagent continuation offset");
    let end = Math.min(text.length, offset + 12000);
    // Bound encoded response bytes too, including escaping and Unicode; preserve surrogate pairs.
    while (Buffer.byteLength(JSON.stringify(text.slice(offset, end))) > 13000) end = offset + Math.floor((end - offset) * 0.8);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
    const truncated = end < text.length || nextPage;
    let nextCursor: string | undefined;
    if (truncated) {
      if (end < text.length) nextCursor = this.encode({ identity, revision, pageRevision, page, offset: end });
      else {
        nextCursor = this.encode({ identity, revision, page: page + 1, offset: 0 });
      }
    }
    return { id: record.id, view: input.view, runId: record.result?.runId, status: record.status,
      data: { text: text.slice(offset, end), newerRunActive: this.active.has(record.id) }, truncated, nextCursor };
  }
  private encode(value: { identity: string; revision: string; pageRevision?: string; page: number; offset: number }) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.key).update(payload).digest("base64url")}`;
  }
  private decode(token: string): { identity: string; revision: string; pageRevision?: string; page: number; offset: number } {
    const [payload, signature, extra] = token.split(".");
    const expected = createHmac("sha256", this.key).update(payload ?? "").digest();
    const actual = Buffer.from(signature ?? "", "base64url");
    if (extra || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid subagent continuation");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    if (!Number.isSafeInteger(decoded.page) || decoded.page < 0 || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)
      throw new Error("Invalid subagent continuation position");
    return decoded;
  }

  async removeWorktree(owner: SubagentOwner, id: string, confirmed: boolean) {
    const record = await this.owned(owner, id);
    if (!record.baseline || record.checkoutRemoved) throw new Error("No retained worktree");
    if (!confirmed) throw new Error("Confirm discarding all unintegrated/generated checkout content");
    const checkout = record.worktree?.path ?? record.baseline.ref;
    if (this.removing.has(checkout)) throw new Error("Checkout removal is already in progress");
    this.removing.add(checkout);
    try {
    await this.list(owner);
    const associated = [...this.records.values()].filter(other => !other.checkoutRemoved &&
      (record.worktree ? other.worktree?.path === record.worktree.path : other.id === record.id));
    if (associated.some(other => busy(other.status) || this.active.has(other.id) || this.jobs.some(job => job.id === other.id) || this.hasProcesses(other)))
      throw new Error("Cancel active/queued work and subprocesses before removal");
    const remaining = [...this.records.values()].some(other => !other.checkoutRemoved &&
      other.baseline?.ref === record.baseline!.ref && !associated.includes(other));
    if (record.worktree) await removeSubagentWorktree(record.worktree, !remaining);
    else if (!remaining) await releaseSubagentBaseline(record.baseline);
    for (const other of associated) { other.checkoutAvailable = false; other.checkoutRemoved = true; await this.save(other); }
    } finally { this.removing.delete(checkout); this.pump(); }
  }
  async beforeDelete(parentThreadId: string) {
    const owner = { projectRoot: this.options.projectRoot, parentThreadId };
    if (this.deleting.has(parentThreadId)) throw new Error("Parent deletion is already in progress");
    this.deleting.add(parentThreadId);
    try {
    await this.list(owner);
    const records = [...this.records.values()].filter(record => record.parentThreadId === parentThreadId);
    if (records.some(record => record.baseline && !record.checkoutRemoved)) throw new Error("Remove retained child worktrees before deleting the parent");
    for (const record of records) await this.cancel(record);
    this.deleted.add(parentThreadId);
    await Promise.allSettled(records.map(record => this.active.get(record.id)));
    } finally { this.deleting.delete(parentThreadId); }
  }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.close();
    return this.shutdownPromise;
  }
  private async close() {
    this.closing = true;
    for (const record of this.records.values()) await this.cancel(record);
    await Promise.allSettled([...this.active.values()]);
    await this.options.drainProcesses?.();
    for (const detach of this.detachChildren.values()) detach();
    await Promise.allSettled([...this.children.values()].map(child => child.dispose()));
    await Promise.allSettled([...this.writes.values()]);
    this.listeners.clear();
  }
}
