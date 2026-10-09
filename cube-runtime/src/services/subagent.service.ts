import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { loadSubagentDefinitions, type CubeConfig, type HomeManager, type ReasoningEffort, type SubagentDefinition } from "@cube/workspace";
import { BUILTIN_SUBAGENTS, type MemoryStorage, type InstructionSnapshot, type NativeSubagentResult,
  type NativeSubagentExecution, type NativeInvocation, type NativeSubagentGate, type SubagentDispatchRequest, type AgentControllerEvent } from "@cube/agent";
import type { BackgroundService } from "./background.service.js";
import { captureSubagentBaseline, createSubagentWorktree, readSubagentChanges, removeSubagentWorktree,
  releaseSubagentBaseline, type ManagedWorktree, type WorktreeBaseline } from "./worktree.service.js";

export type SubagentOwner = { projectRoot: string; parentThreadId: string };
export type SubagentStatus = "queued" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "cancelled" | "unattached";
export type SubagentTarget = { jobId: string; runId: string; toolCallId: string };
export type SubagentSummary = { id: string; agent: string; description: string; status: SubagentStatus;
  modelId: string; createdAt: number; startedAt?: number; completedAt?: number; runId?: string;
  isolation: "none" | "worktree"; worktreePath?: string; checkoutAvailable: boolean;
  canInterrupt: boolean };
type GetAgentInput = { id: string; view: "status" | "result" | "transcript" | "changes"; cursor?: string; limit?: number };
export type SubagentView = { id: string; runId?: string; status: SubagentStatus; truncated: boolean; nextCursor?: string } &
  ({ view: "status"; data: SubagentSummary } | { view: "result" | "transcript" | "changes"; data: { text: string; unavailable?: string; newerRunActive?: boolean } });
export type SubagentRecord = SubagentSummary & {
  parentThreadId: string; projectRoot: string; definition: SubagentDefinition; task: string; cwd: string;
  reasoningEffort?: ReasoningEffort; instructions: InstructionSnapshot; worktree?: ManagedWorktree;
  baseline?: WorktreeBaseline; result?: NativeSubagentResult & { status: "completed" | "failed" | "cancelled"; startedAt: number; completedAt: number };
  parentRunId?: string; toolCallId?: string; nativeInput?: SubagentDispatchRequest["input"]; gate?: NativeSubagentGate;
  pendingDelivery?: string; delivered?: string; error?: string; checkoutRemoved?: boolean; legacy?: boolean;
  timeoutMs?: number;
  history?: NativeSubagentExecution["history"];
};
export type SubagentInteraction = { type: "subagent_interaction"; target: SubagentTarget; agent: string;
  description: string; directory: string; event: Extract<AgentControllerEvent, { type: "tool_approval_required" | "tool_suspended" }> } |
  { type: "subagent_interaction_cancelled"; jobId: string; runId?: string };
const busy = (status: string) => ["queued", "running", "waiting_approval", "waiting_input"].includes(status);
const unknown = () => new Error("Unknown or unavailable subagent");

export class SubagentService {
  private catalog: SubagentDefinition[] = [];
  private catalogErrors: { name: string; source: string; message: string }[] = [];
  private readonly resources = new Map<string, NativeSubagentExecution>();
  private readonly listeners = new Set<(event?: SubagentInteraction) => void>();
  private readonly key = randomBytes(32);
  private readonly removing = new Set<string>();
  private readonly deleting = new Set<string>();
  private readonly stopBackground: () => void;
  constructor(private readonly options: {
    home: HomeManager; projectRoot: string; config: CubeConfig; storage: () => Promise<MemoryStorage>;
    background: BackgroundService;
    readParent: (id: string) => Promise<{ modelId: string; reasoningEffort?: ReasoningEffort; instructions: InstructionSnapshot }>;
    resolveModel: (definition: SubagentDefinition, parent: { modelId: string; reasoningEffort?: ReasoningEffort }) => Promise<{ modelId: string; reasoningEffort?: ReasoningEffort }>;
    toolNames: () => Promise<string[]>; createExecution: (invocation: NativeInvocation) => Promise<NativeSubagentExecution>;
    publishCatalog: (definitions: readonly SubagentDefinition[]) => void;
    deliver: (record: SubagentRecord, wake: boolean) => Promise<void>;
    currentThread: () => string | null; redact: (text: string) => Promise<string>; notice: (text: string) => void;
  }) { this.stopBackground = options.background.subscribe(() => this.changed()); }

  readCatalog = (): readonly SubagentDefinition[] => this.catalog;
  isBusy = () => this.options.background.delegationBusy();
  runningCount(parentThreadId = this.options.currentThread()) { return this.options.background.delegationRunningCount(parentThreadId); }
  async reloadCatalog() {
    const loaded = await loadSubagentDefinitions(this.options.home, this.options.projectRoot, BUILTIN_SUBAGENTS);
    this.catalog = loaded.agents; this.catalogErrors = loaded.errors; this.options.publishCatalog(this.catalog); this.changed();
  }
  subscribe(listener: (event?: SubagentInteraction) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(event?: SubagentInteraction) { for (const listener of this.listeners) listener(event); }
  private checkOwner(owner: SubagentOwner) { if (owner.projectRoot !== this.options.projectRoot) throw unknown(); }
  private async owned(owner: SubagentOwner, id: string): Promise<SubagentRecord> {
    this.checkOwner(owner);
    try { return await this.options.background.getDelegation(id, owner.parentThreadId); }
    catch {
      const thread = await (await this.options.storage()).getThreadById({ threadId: id, resourceId: owner.projectRoot });
      const stored = thread?.metadata?.cubeSubagent as SubagentRecord | undefined;
      if (!stored || stored.parentThreadId !== owner.parentThreadId || stored.projectRoot !== owner.projectRoot || stored.id !== id) throw unknown();
      const record = structuredClone(stored);
      record.legacy = true;
      if (busy(record.status)) record.status = "unattached";
      record.canInterrupt = false;
      return record;
    }
  }
  private summary(record: SubagentRecord): SubagentSummary {
    return { id: record.id, agent: record.agent, description: record.description, status: record.status, modelId: record.modelId,
      createdAt: record.createdAt, startedAt: record.startedAt, completedAt: record.completedAt, runId: record.runId,
      isolation: record.isolation, worktreePath: record.worktree?.path, checkoutAvailable: record.checkoutAvailable,
      canInterrupt: !record.legacy && (busy(record.status) || !!this.resources.get(record.id)?.tools.processes.list().some(process => ["pending", "running"].includes(process.result.status))) };
  }
  async list(owner: SubagentOwner): Promise<SubagentSummary[]> {
    this.checkOwner(owner);
    const records = await this.options.background.listDelegations(owner.parentThreadId);
    const storage = await this.options.storage();
    for (let page = 0; ; page++) {
      const legacy = await storage.listThreads({ page, perPage: 100, filter: { resourceId: owner.projectRoot } });
      for (const thread of legacy.threads) {
        const record = thread.metadata?.cubeSubagent as SubagentRecord | undefined;
        if (record?.parentThreadId === owner.parentThreadId) records.push(await this.owned(owner, thread.id));
      }
      if (!legacy.hasMore) break;
    }
    for (const record of records) if (!this.deleting.has(owner.parentThreadId) && !record.legacy && record.pendingDelivery && record.delivered !== record.pendingDelivery && (record.result || record.error)) {
      await this.options.background.deliverDelegation(record, this.options.deliver);
    }
    return records.map(record => this.summary(record)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async dispatch(request: SubagentDispatchRequest): Promise<{ id: string }> {
    this.checkOwner(request);
    if (this.deleting.has(request.parentThreadId)) throw unknown();
    const definition = this.catalog.find(role => role.name === request.role);
    if (!definition) throw new Error(this.catalogErrors.find(error => error.name === request.role)?.message ?? "Unknown role");
    if (request.input.threadId || request.input.resourceId) throw new Error("Cube assigns private child history; omit threadId and resourceId");
    const storage = await this.options.storage();
    const thread = await storage.getThreadById({ threadId: request.parentThreadId, resourceId: request.projectRoot });
    if (!thread || thread.metadata?.cubeSubagent) throw unknown();
    const parent = structuredClone(await this.options.readParent(request.parentThreadId));
    const resolved = await this.options.resolveModel(definition, parent);
    const names = new Set(await this.options.toolNames());
    for (const name of definition.tools ?? []) if (!names.has(name)) throw new Error("Unavailable child tool: " + name);
    let execution: NativeSubagentExecution | undefined; let detach: (() => void) | undefined;
    let cleanup: Promise<void> | undefined;
    const dispose = () => cleanup ??= (async () => {
      if (execution) await execution.dispose();
      await this.options.background.drain(); detach?.();
      if (recordId) this.resources.delete(recordId);
    })();
    let recordId: string | undefined;
    const accepted = await this.options.background.enqueueDelegation({
      agent: definition.name, definition: structuredClone(definition), description: request.input.prompt.slice(0, 512),
      task: request.input.prompt, nativeInput: structuredClone(request.input), ...resolved, instructions: parent.instructions,
      parentThreadId: request.parentThreadId, projectRoot: request.projectRoot, parentRunId: request.runId, toolCallId: request.toolCallId,
      cwd: request.projectRoot, isolation: definition.isolation ?? "none", checkoutAvailable: definition.isolation !== "worktree",
    }, {
      deliver: this.options.deliver,
      cleanup: dispose,
      execute: async (record, signal, suspend) => {
        recordId = record.id;
        if (record.isolation === "worktree") {
          record.baseline = await captureSubagentBaseline(record.projectRoot, record.id);
          await this.options.background.updateDelegation(record);
          record.worktree = await createSubagentWorktree(this.options.home, record.baseline, record.id, async (checkout, created) => {
            record.worktree = checkout; record.checkoutAvailable = created; await this.options.background.updateDelegation(record);
          });
          record.checkoutAvailable = true; record.cwd = record.worktree.path;
          await this.options.background.updateDelegation(record);
        }
        signal.throwIfAborted();
        execution = await this.options.createExecution({ id: record.id, definition: record.definition, modelId: record.modelId,
          reasoningEffort: record.reasoningEffort, projectRoot: record.projectRoot, executionRoot: record.cwd, instructions: record.instructions });
        if (signal.aborted) { await execution.dispose(); signal.throwIfAborted(); }
        this.resources.set(record.id, execution);
        execution.tools.setTaskHandler(async (input, threadId) => {
          if (input.action === "list") return { tasks: await this.options.background.list(threadId) };
          if (input.action === "kill") await this.options.background.stop(input, threadId);
          return this.options.background.get(input, threadId);
        });
        detach = this.options.background.attach(execution.tools.processes, async process => {
          if (!process.threadId) return;
          const thread = await storage.getThreadById({ threadId: process.threadId });
          if (!thread) return;
          const sent = execution!.agent.sendSignal({ id: "process-" + process.id, type: "reactive", tagName: "background_task",
            contents: "Untrusted background command result; do not rerun automatically.\n" + JSON.stringify(process.result) },
            { threadId: thread.id, resourceId: thread.resourceId, ifIdle: { behavior: "persist" } });
          await sent.accepted; await sent.persisted;
        });
        try {
          const result = await execution.run(record.nativeInput!, { toolCallId: request.toolCallId, messages: [], abortSignal: signal }, gate => {
            record.history = { ...execution!.history };
            const answer = suspend(gate);
            const event = gate.approval ? { type: "tool_approval_required", toolCallId: gate.toolCallId, toolName: gate.toolName, args: gate.args }
              : { type: "tool_suspended", toolCallId: gate.toolCallId, toolName: gate.toolName, args: gate.args, suspendPayload: gate.suspendPayload };
            this.changed({ type: "subagent_interaction", target: { jobId: record.id, runId: gate.runId, toolCallId: gate.toolCallId },
              agent: record.agent, description: record.description, directory: record.cwd, event: event as SubagentInteraction & any });
            return answer;
          });
          return { ...result, text: await this.clean(result.text), status: "completed", startedAt: record.startedAt!, completedAt: Date.now() };
        } finally {
          record.history = { ...execution.history };
          this.changed({ type: "subagent_interaction_cancelled", jobId: record.id, runId: record.runId });
        }
      },
    });
    return accepted;
  }
  async interrupt(owner: SubagentOwner, id: string) {
    const record = await this.owned(owner, id);
    if (record.legacy) throw new Error("Historical subagent is read-only");
    await this.options.background.cancelDelegation(id, owner.parentThreadId);
    return { id, requested: true, status: record.status };
  }
  async respond(target: SubagentTarget, data: unknown): Promise<void> { return this.options.background.resumeDelegation(target, data); }
  preview(target: SubagentTarget) { this.options.background.assertDelegationGate(target); const execution = this.resources.get(target.jobId); if (!execution) throw unknown(); return execution.tools; }
  async refreshPermissions() { for (const execution of this.resources.values()) execution.tools.discardPreview(); }
  private clean(text: string) { return this.options.redact(stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")); }

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
      text = JSON.stringify(record.result ?? (record.error ? { ...record.history, status: record.status === "cancelled" ? "cancelled" : "failed", error: record.error, toolActivity: [] } : { unavailable: "No settled run result" }));
      revision = record.result?.runId ?? record.pendingDelivery ?? "no-result";
    } else if (input.view === "changes") {
      if (!record.worktree || !record.checkoutAvailable) return { id: record.id, view: input.view, status: record.status,
        data: { text: "", unavailable: record.isolation === "none" ? "Shared-directory changes cannot be attributed to this child" : "Checkout was removed" }, truncated: false };
      const changes = await readSubagentChanges(record.worktree);
      text = JSON.stringify(changes); revision = changes.revision;
    } else {
      const storage = await this.options.storage();
      const scope = record.result ?? record.history;
      if (!record.legacy && !scope?.threadId) return { id: record.id, view: input.view, status: record.status, data: { text: "", unavailable: "Native child history is not available yet" }, truncated: false };
      const thread = await storage.getThreadById({ threadId: scope?.threadId ?? record.id, resourceId: scope?.resourceId ?? owner.projectRoot });
      const messages = await storage.listMessages({ threadId: scope?.threadId ?? record.id, resourceId: scope?.resourceId ?? owner.projectRoot,
        perPage: limit, page, orderBy: { field: "createdAt", direction: "ASC" } });
      text = JSON.stringify(messages.messages, (key, value) => {
        if (["data", "base64", "fileData", "image"].includes(key) && typeof value === "string" && value.length > 1024) return "[binary media omitted]";
        return value;
      }); nextPage = messages.hasMore;
      revision = String(new Date(thread?.updatedAt ?? record.completedAt ?? record.createdAt).getTime());
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
      data: { text: text.slice(offset, end), newerRunActive: ["running", "waiting_input", "waiting_approval"].includes(record.status) }, truncated, nextCursor };
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
    if (busy(record.status) || this.resources.get(id)?.tools.processes.list().some(process => ["pending", "running"].includes(process.result.status)))
      throw new Error("Cancel active work and subprocesses before removal");
    const key = record.worktree?.path ?? record.baseline.ref;
    if (this.removing.has(key)) throw new Error("Checkout removal is already in progress");
    this.removing.add(key);
    try {
      const storage = await this.options.storage();
      const historical: SubagentRecord[] = [];
      if (record.legacy) for (let page = 0; ; page++) {
        const threads = await storage.listThreads({ page, perPage: 100, filter: { resourceId: record.projectRoot } });
        for (const thread of threads.threads) {
          const other = thread.metadata?.cubeSubagent as SubagentRecord | undefined;
          if (other && !other.checkoutRemoved) historical.push(structuredClone(other));
        }
        if (!threads.hasMore) break;
      }
      const associated = record.legacy ? historical.filter(other => record.worktree ? other.worktree?.path === record.worktree.path : other.id === record.id) : [record];
      const release = !historical.some(other => other.baseline?.ref === record.baseline!.ref && !associated.includes(other));
      if (record.worktree) await removeSubagentWorktree(record.worktree, release);
      else if (release) await releaseSubagentBaseline(record.baseline);
      for (const other of associated) {
        other.checkoutAvailable = false; other.checkoutRemoved = true;
        if (record.legacy) {
          const thread = await storage.getThreadById({ threadId: other.id, resourceId: record.projectRoot });
          await storage.patchThread({ id: other.id, metadata: { ...thread!.metadata, cubeSubagent: other } });
        } else await this.options.background.updateDelegation(other);
      }
    } finally { this.removing.delete(key); }
  }
  async beforeDelete(parentThreadId: string) {
    this.deleting.add(parentThreadId);
    try {
      const owner = { projectRoot: this.options.projectRoot, parentThreadId };
      for (const summary of await this.list(owner)) {
        const record = await this.owned(owner, summary.id);
        if (record.baseline && !record.checkoutRemoved) throw new Error("Remove retained child worktrees before deleting the parent");
      }
    } finally { this.deleting.delete(parentThreadId); }
  }
  async shutdown() { this.stopBackground(); this.listeners.clear(); }
}
