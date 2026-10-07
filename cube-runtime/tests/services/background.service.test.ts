import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundTask, BackgroundTasksStorage, ProcessRegistry, ProcessRecord } from "@cube/agent";
import { BackgroundService } from "../../src/services/background.service.js";

function fixture() {
  const tasks = new Map<string, BackgroundTask>();
  const processes = new Map<string, ProcessRecord>();
  const listeners = new Set<(record: ProcessRecord) => void>();
  const notices: string[] = [];
  const continued: { record: ProcessRecord; wake: boolean }[] = [];
  const order: string[] = [];
  let selected: string | null = "owner";
  const history: Pick<BackgroundTasksStorage, "createTask" | "updateTask" | "getTask" | "listTasks"> = {
    async createTask(task) { assert.ok(!tasks.has(task.id)); tasks.set(task.id, structuredClone(task)); },
    async updateTask(id, update) { const task = tasks.get(id); if (!task) return false; Object.assign(task, structuredClone(update)); return true; },
    async getTask(id) { return tasks.get(id) ?? null; },
    async listTasks(filter) {
      const matches = [...tasks.values()].filter(task => task.resourceId === filter.resourceId &&
        task.agentId === filter.agentId && task.threadId === filter.threadId);
      return { tasks: matches.slice(0, filter.perPage ?? 100), total: matches.length };
    },
  };
  const emit = (record: ProcessRecord) => { for (const listener of listeners) listener(structuredClone(record)); };
  const registry: ProcessRegistry = {
    list: () => [...processes.values()].map(record => structuredClone(record)),
    get: id => { const record = processes.get(id); if (!record) throw new Error("Unknown process"); return structuredClone(record); },
    stop: async id => { order.push(`stop:${id}`); const record = processes.get(id)!; record.result.status = "cancelled"; record.completedAt = Date.now(); emit(record); return record; },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const service = new BackgroundService({ history: async () => history,
    processes: registry, workspaceRoot: "workspace", currentThread: () => selected,
    notice: text => notices.push(text), redact: async text => text.replaceAll("fixture-secret", "[Redacted]"),
    drain: async thread => { order.push(`drain:${thread ?? "all"}`); },
    continueProcess: async (record, wake) => { continued.push({ record, wake }); },
  });
  const task = (id: string, overrides: Partial<BackgroundTask> = {}) => {
    const record: BackgroundTask = { id, status: "completed", toolName: "execute_command", toolCallId: "call", args: { command: "echo fixture-secret", reason: "reason", cwd: "." },
      agentId: "cube-agent", resourceId: "workspace", threadId: "owner", runId: "run", createdAt: new Date(), retryCount: 0, maxRetries: 0, timeoutMs: 1000, ...overrides };
    tasks.set(id, record); return record;
  };
  const process = (id: string, overrides: Partial<ProcessRecord> = {}) => {
    const record: ProcessRecord = { id, workspaceRoot: "workspace", threadId: "owner", runId: "run", createdAt: Date.now(), detached: true, timeoutMs: 1000,
      result: { kind: "command", command: "server", reason: "reason", cwd: "workspace", process_id: id, status: "running", output: "output", exit_code: null, truncated: false }, ...overrides };
    processes.set(id, record); emit(record); return record;
  };
  return { service, tasks, processes, notices, continued, order, listeners, task, process, emit,
    select: (thread: string | null) => { selected = thread; },
  };
}

test("tasks persist per thread and share one ID with live processes", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.task(`build-${i}`);
    const live = f.process("server");
    f.process("other-server", { threadId: "other-thread" });
    f.process("foreground", { detached: false });
    const ownerJobs = await f.service.list();
    assert.equal(ownerJobs.length, 11);
    assert.equal(ownerJobs.filter(job => job.id === live.id).length, 1);
    assert.equal(f.tasks.get(live.id)!.id, live.result.process_id);
    assert.equal(f.tasks.has("foreground"), false);
    f.select("other-thread");
    assert.deepEqual((await f.service.list()).map(job => job.id), ["other-server"]);
    f.select(null);
    assert.deepEqual(await f.service.list(), []);
    f.select("owner");
    assert.deepEqual(await f.service.list(), ownerJobs);
    f.processes.clear(); // Simulate another runtime reading persisted history after exit.
    const restored = await f.service.get(live);
    assert.equal(restored.canStop, false);
    assert.equal(restored.status, "unattached");
    await assert.rejects(f.service.stop(live), /read-only/);
  } finally { await f.service.shutdown(); }
});

test("foreign handles are rejected and foreground commands never become tasks", async () => {
  const f = fixture();
  try {
    f.task("foreign", { resourceId: "other" });
    f.process("foreign-live", { workspaceRoot: "other" });
    f.process("foreground", { detached: false });
    await assert.rejects(f.service.get({ id: "foreign" }), /Unknown/);
    await assert.rejects(f.service.get({ id: "foreign-live" }), /Unknown/);
    await assert.rejects(f.service.stop({ id: "foreign-live" }), /Unknown/);
    assert.deepEqual(await f.service.list(), []);
  } finally { await f.service.shutdown(); }
});

test("explicit calling-thread management is isolated from selection and rejects cross-thread get/kill", async () => {
  const f = fixture();
  try {
    const owned = f.process("owned");
    const foreign = f.process("foreign-thread", { threadId: "other-thread" });
    const stored = f.task("foreign-history", { threadId: "other-thread" });
    f.select("other-thread");
    assert.deepEqual((await f.service.list("owner")).map(task => task.id), [owned.id]);
    assert.equal((await f.service.get(owned, "owner")).id, owned.id);
    for (const task of [foreign, stored]) {
      await assert.rejects(f.service.get(task, "owner"), /Unknown/);
      await assert.rejects(f.service.stop(task, "owner"), /Unknown/);
    }
    await assert.rejects(f.service.get(owned), /Unknown/);
    assert.deepEqual(await f.service.list(null), []);
    await f.service.stop(owned, "owner");
    await f.service.stop(owned, "owner");
    assert.equal((await f.service.get(owned, "owner")).status, "cancelled");
    assert.equal(f.processes.get(foreign.id)!.result.status, "running");
  } finally { await f.service.shutdown(); }
});

test("completion persists bounded redacted output and signals once without TUI notices", async () => {
  const f = fixture();
  try {
    const record = f.process("finished");
    await f.service.list();
    f.select("other-thread");
    record.result.status = "failed";
    record.result.exit_code = 7;
    record.result.output = `${"long line fixture-secret\n".repeat(1000)}\x1b[31mend`;
    f.emit(record); // A spawn error can be emitted before streams have closed.
    record.completedAt = Date.now();
    f.emit(record); f.emit(record);
    await f.service.list();
    assert.equal(f.continued.length, 1);
    assert.equal(f.continued[0]!.wake, false, "Never wake a different selected thread");
    assert.equal(f.continued[0]!.record.result.exit_code, 7);
    assert.deepEqual(f.notices, []);
    const detail = await f.service.get(record, "owner");
    assert.ok(detail.truncated);
    assert.ok(detail.output.split("\n").length <= 200);
    assert.ok(Buffer.byteLength(detail.output) <= 16384);
    assert.doesNotMatch(JSON.stringify(f.tasks.get(record.id)), /fixture-secret|\\u001b/);
    assert.doesNotMatch(JSON.stringify(f.continued), /fixture-secret|\\u001b/);
  } finally { await f.service.shutdown(); }
});

test("live output refreshes without storing every output chunk", async () => {
  const f = fixture();
  let refreshed = false;
  const unsubscribe = f.service.subscribe(() => { refreshed = true; });
  try {
    const record = f.process("build");
    await f.service.list();
    record.result.output = "LIVE fixture-secret";
    f.emit(record);
    assert.equal((await f.service.get(record)).output, "LIVE [Redacted]");
    assert.equal((f.tasks.get(record.id)!.result as { output: string }).output, "output");
    assert.equal((await f.service.list()).length, 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(refreshed, true);
  } finally { unsubscribe(); await f.service.shutdown(); }
});

test("JSON command output remains data rather than being interpreted as an error", async () => {
  const f = fixture();
  try {
    const record = f.process("json-output");
    record.result.output = '{"count":42,"ok":true}';
    assert.equal((await f.service.get(record)).output, record.result.output);
  } finally { await f.service.shutdown(); }
});

test("failed persistence reports a safe error and does not claim completion was delivered", async () => {
  const f = fixture();
  try {
    const record = f.process("missing-history");
    await f.service.list();
    f.tasks.delete(record.id);
    record.result.status = "completed";
    record.completedAt = Date.now();
    f.emit(record);
    await f.service.list();
    assert.equal(f.continued.length, 0);
    assert.match(f.notices[0]!, /Background history record is missing/);
  } finally { await f.service.shutdown(); }
});

test("deletion suppresses wakeups; shutdown saves cancellation and leaves foreign jobs alone", async () => {
  const f = fixture();
  f.process("owner-task");
  f.process("other-task", { threadId: "other-thread" });
  f.process("foreign", { workspaceRoot: "other" });
  const server = f.process("server", { timeoutMs: null });
  await f.service.beforeDelete("owner");
  assert.deepEqual(f.order, ["stop:owner-task", "drain:owner"]);
  assert.deepEqual(f.continued, []);
  assert.equal((await f.service.get(server)).ownerDeleted, true);
  assert.equal((await f.service.get(server)).canStop, true);
  await f.service.stop(server);
  await f.service.shutdown();
  await f.service.shutdown();
  assert.deepEqual(f.order.slice(-2), ["stop:other-task", "drain:all"]);
  assert.equal(f.tasks.get("other-task")!.status, "cancelled");
  assert.equal(f.processes.get("foreign")!.result.status, "running");
  assert.equal(f.listeners.size, 0);
});
