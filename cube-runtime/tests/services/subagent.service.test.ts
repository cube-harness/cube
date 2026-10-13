import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HomeManager, RunnableConfigSchema } from "@cube/workspace";
import type { NativeInvocation, NativeSubagentExecution, MemoryStorage, ProcessRegistry, NativeSubagentGate } from "@cube/agent";
import { BackgroundService } from "../../src/services/background.service.js";
import { SubagentService, type SubagentRecord } from "../../src/services/subagent.service.js";

const { LibSQLStore } = createRequire(import.meta.resolve("@cube/agent"))("@mastra/libsql");
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Condition did not settle");
};
const emptyProcesses: ProcessRegistry = { list: () => [], get: () => { throw new Error("No process"); }, stop: async () => { throw new Error("No process"); }, subscribe: () => () => {} };

async function fixture(timeout = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-native-jobs-"));
  const home = new HomeManager({ cubeHome: path.join(root, "home"), userHome: root });
  await home.ensure();
  const store = new LibSQLStore({ id: randomUUID(), url: `file:${home.getMemoryDbPath()}` });
  await store.init();
  const storage: MemoryStorage = await store.getStore("memory");
  const parent = randomUUID();
  await storage.saveThread({ thread: { id: parent, resourceId: root, title: "Parent",
    createdAt: new Date(), updatedAt: new Date(), metadata: { existing: true } } });
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test", subagents: { timeout_ms: timeout } });
  const pending = new Map<string, (text?: string) => void>();
  const prepared: NativeInvocation[] = [];
  const disposed: string[] = [];
  const deliveries: string[] = [];
  const background = new BackgroundService({ history: () => store.getStore("backgroundTasks"), processes: emptyProcesses,
    workspaceRoot: root, currentThread: () => parent, notice: () => {}, redact: async text => text,
    drain: async () => {}, continueProcess: async () => {}, delegationConfig: config.subagents });
  const options = { home, projectRoot: root, config, storage: async () => storage, background,
    readParent: async () => ({ modelId: "google/test", instructions: { soul: "Snapshot", sources: [], explored: [] } }),
    resolveModel: async () => ({ modelId: "google/test" }), toolNames: async () => ["read_file", "write_file"],
    currentThread: () => parent, redact: async (text: string) => text.replaceAll("fixture-secret", "[Redacted]"),
    notice: () => {}, publishCatalog: () => {},
    deliver: async (record: SubagentRecord) => { deliveries.push(record.id); },
    createExecution: async (invocation: NativeInvocation): Promise<NativeSubagentExecution> => {
      prepared.push(invocation);
      return {
        history: {},
        agent: {} as NativeSubagentExecution["agent"],
        tools: { processes: { ...emptyProcesses }, setTaskHandler: () => {}, discardPreview: () => {}, hasPreview: () => false } as unknown as NativeSubagentExecution["tools"],
        run: async (_input, runOptions) => {
          const text = await new Promise<string>((resolve, reject) => {
            pending.set(invocation.id, (text = "report") => resolve(text));
            runOptions.abortSignal?.addEventListener("abort", () => reject(runOptions.abortSignal?.reason), { once: true });
          });
          pending.delete(invocation.id);
          return { text, toolActivity: [], threadId: "history-" + invocation.id, resourceId: "private-resource" };
        },
        dispose: async () => { disposed.push(invocation.id); },
      };
    },
  };
  const service = new SubagentService(options); await service.reloadCatalog();
  const owner = { projectRoot: root, parentThreadId: parent };
  const dispatch = (prompt: string, role = "worker", callId = randomUUID()) => service.dispatch({ ...owner, role, input: { prompt }, runId: "parent-run", toolCallId: callId });
  return { root, home, config, storage, store, background, service, options, owner, prepared, pending, deliveries, disposed, dispatch,
    async close() { await background.shutdown(); await service.shutdown(); await store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

test("one-shot acceptance is idempotent, FIFO and scoped; restart reads history without execution", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.dispatch("one", "worker", "first-call");
    assert.deepEqual(await f.dispatch("one", "worker", "first-call"), first);
    const second = await f.dispatch("two"); const third = await f.dispatch("three");
    await until(() => f.prepared.length === 2);
    assert.equal(f.service.runningCount(), 2);
    assert.equal((await f.service.get(f.owner, { id: third.id, view: "status" })).status, "queued");
    assert.equal((await f.background.list()).length, 0);
    await assert.rejects(f.service.get({ ...f.owner, parentThreadId: randomUUID() }, { id: first.id, view: "status" }), /Unknown/);
    await f.service.interrupt(f.owner, third.id);
    f.pending.get(first.id)!(); f.pending.get(second.id)!();
    await until(async () => !f.service.isBusy() && (await f.service.list(f.owner)).every(record => ["completed", "cancelled"].includes(record.status)));
    assert.equal(f.prepared.length, 2);
    assert.equal((await f.service.get(f.owner, { id: first.id, view: "result" })).status, "completed");
    assert.equal(f.deliveries.filter(id => id === first.id).length, 1);
    assert.equal(f.config.subagents.timeout_ms, 0);
    const record = await f.background.getDelegation(first.id, f.owner.parentThreadId);
    assert.equal(record.timeoutMs, 0);
    const restored = new BackgroundService({ history: () => f.store.getStore("backgroundTasks"), processes: emptyProcesses,
      workspaceRoot: f.root, currentThread: () => f.owner.parentThreadId, notice: () => {}, redact: async text => text,
      drain: async () => {}, continueProcess: async () => {} });
    try {
      const stored = await restored.getDelegation(first.id, f.owner.parentThreadId);
      assert.equal(stored.result?.text, "report"); assert.equal(stored.status, "completed");
      await assert.rejects(restored.cancelDelegation(first.id, f.owner.parentThreadId), /read-only/);
    } finally { await restored.shutdown(); }
  } finally { await f.close(); }
});

test("native gates retain the slot and require exact job/run/call identity; positive timeout includes waiting", { timeout: 60000 }, async () => {
  const f = await fixture(1000);
  try {
    let seen: NativeSubagentGate | undefined;
    const record = { parentThreadId: f.owner.parentThreadId, projectRoot: f.root, agent: "worker", description: "question",
      definition: { name: "worker", description: "work", instructions: "work", source: "builtin" as const },
      modelId: "google/test", instructions: { soul: "", sources: [], explored: [] }, task: "task", cwd: f.root,
      isolation: "none" as const, checkoutAvailable: true, parentRunId: "run", toolCallId: "call" };
    const job = await f.background.enqueueDelegation(record, {
      execute: async (_record, _signal, suspend) => {
        seen = { runId: "native-run", toolCallId: "same-call", toolName: "ask_user", args: {}, suspendPayload: {}, approval: false };
        await suspend(seen);
        return { text: "answered", toolActivity: [], status: "completed", startedAt: Date.now(), completedAt: Date.now() };
      }, deliver: async () => {},
    });
    await until(() => !!seen);
    assert.equal(f.background.delegationRunningCount(f.owner.parentThreadId), 1);
    await assert.rejects(f.background.resumeDelegation({ jobId: job.id, runId: "wrong", toolCallId: "same-call" }, {}), /no longer active/);
    await until(async () => (await f.background.getDelegation(job.id, f.owner.parentThreadId)).status === "cancelled");
    assert.match((await f.background.getDelegation(job.id, f.owner.parentThreadId)).error!, /timeout/);
    await assert.rejects(f.background.resumeDelegation({ jobId: job.id, runId: "native-run", toolCallId: "same-call" }, {}), /no longer active/);
  } finally { await f.close(); }
});

test("captured role settings survive reload; failed preparation settles and private transcript uses native IDs", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.dispatch({ ...f.owner, role: "worker", input: { prompt: "wrong", threadId: "foreign" }, runId: "run", toolCallId: "wrong" }), /private child history/);
    const a = await f.dispatch("one"); const b = await f.dispatch("two");
    const dir = path.join(f.root, ".agents", "agents"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "custom.md"), "---\ndescription: Custom\n---\nORIGINAL_ROLE");
    await f.service.reloadCatalog();
    const c = await f.dispatch("three", "custom");
    await writeFile(path.join(dir, "custom.md"), "---\ndescription: Custom\n---\nNEW_ROLE");
    await f.service.reloadCatalog();
    await until(() => f.pending.has(a.id) && f.pending.has(b.id));
    f.pending.get(a.id)!(); await until(() => f.pending.has(c.id));
    assert.equal(f.prepared.find(item => item.id === c.id)!.definition.instructions, "ORIGINAL_ROLE");
    f.pending.get(b.id)!(); f.pending.get(c.id)!();
    await until(() => !f.service.isBusy());
    const settled = await f.background.getDelegation(c.id, f.owner.parentThreadId);
    await f.storage.saveThread({ thread: { id: settled.result!.threadId!, resourceId: "private-resource", title: "Private fixture", createdAt: new Date(), updatedAt: new Date() } });
    await f.storage.saveMessages({ messages: [{ id: randomUUID(), role: "assistant", threadId: settled.result!.threadId!, resourceId: "private-resource", createdAt: new Date(),
      content: { format: 2, parts: [{ type: "text", text: "ACTUAL_PRIVATE_FIXTURE" }] } }] });
    const view = await f.service.get(f.owner, { id: c.id, view: "transcript" });
    assert.ok("text" in view.data && view.data.text.includes("ACTUAL_PRIVATE_FIXTURE"));
    f.options.createExecution = async () => { throw new Error("prepare failed"); };
    const failed = await f.dispatch("failure");
    await until(async () => (await f.service.get(f.owner, { id: failed.id, view: "status" })).status === "failed");
    assert.equal(f.service.runningCount(), 0);
    const failure = await f.service.get(f.owner, { id: failed.id, view: "result" });
    assert.ok("text" in failure.data && JSON.parse(failure.data.text).error === "prepare failed");
    await until(() => f.deliveries.includes(failed.id));
    const large = { ...settled.result!, text: "fixture-secret" + "a".repeat(24000) };
    settled.result = large; await f.background.updateDelegation(settled);
    const page = await f.service.get(f.owner, { id: c.id, view: "result" });
    assert.ok(page.truncated && page.nextCursor); assert.ok("text" in page.data && !page.data.text.includes("fixture-secret"));
    await assert.rejects(f.service.get(f.owner, { id: b.id, view: "result", cursor: page.nextCursor }), /owner\/view/);
  } finally { await f.close(); }
});

test("a rate-limited child retains partial tool evidence without a final report", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    f.options.createExecution = async invocation => {
      const history = { threadId: "native-" + invocation.id, resourceId: "private-" + invocation.id };
      return { history, agent: {} as NativeSubagentExecution["agent"],
        tools: { processes: { ...emptyProcesses }, setTaskHandler: () => {} } as unknown as NativeSubagentExecution["tools"],
        dispose: async () => {}, run: async () => {
          await f.storage.saveThread({ thread: { id: history.threadId, resourceId: history.resourceId, title: "Private", createdAt: new Date(), updatedAt: new Date() } });
          await f.storage.saveMessages({ messages: [{ id: randomUUID(), role: "assistant", ...history, createdAt: new Date(),
            content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: {
              state: "result", toolCallId: "search-call", toolName: "search", args: { query: "fixture" }, result: "PARTIAL_SEARCH_EVIDENCE",
            } }] } }] });
          throw new Error("HTTP 429: upstream rate limited");
        } };
    };
    const job = await f.dispatch("Investigate fixture", "explore");
    await until(async () => (await f.service.get(f.owner, { id: job.id, view: "status" })).status === "failed");
    const result = await f.service.get(f.owner, { id: job.id, view: "result" });
    assert.ok("text" in result.data && JSON.parse(result.data.text).error === "HTTP 429: upstream rate limited");
    const transcript = await f.service.get(f.owner, { id: job.id, view: "transcript" });
    assert.ok("text" in transcript.data && transcript.data.text.includes("PARTIAL_SEARCH_EVIDENCE"));
    assert.equal(f.service.runningCount(), 0);
    assert.equal((await f.service.list(f.owner)).length, 1, "Reading evidence must not start another job");
  } finally { await f.close(); }
});

test("cancelled jobs retain native history and parent deletion does not deliver a completion", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    f.options.createExecution = async invocation => {
      const history = { threadId: "native-" + invocation.id, resourceId: "private-" + invocation.id };
      return { history, agent: {} as NativeSubagentExecution["agent"],
        tools: { processes: { ...emptyProcesses }, setTaskHandler: () => {} } as unknown as NativeSubagentExecution["tools"],
        dispose: async () => {}, run: async (_input, _options, suspend) => {
          await f.storage.saveThread({ thread: { id: history.threadId, resourceId: history.resourceId, title: "Private", createdAt: new Date(), updatedAt: new Date() } });
          await f.storage.saveMessages({ messages: [{ id: randomUUID(), role: "user", ...history, createdAt: new Date(),
            content: { format: 2, parts: [{ type: "text", text: "CANCELLED_PRIVATE_TASK" }] } }] });
          await suspend({ runId: "native-run", toolCallId: "question", toolName: "ask_user", args: {}, suspendPayload: {}, approval: false });
          throw new Error("Unexpected continuation");
        } };
    };
    const cancelled = await f.dispatch("cancel");
    await until(async () => (await f.background.getDelegation(cancelled.id, f.owner.parentThreadId)).status === "waiting_input");
    await f.service.interrupt(f.owner, cancelled.id);
    const result = await f.service.get(f.owner, { id: cancelled.id, view: "result" });
    assert.ok("text" in result.data && JSON.parse(result.data.text).status === "cancelled");
    const view = await f.service.get(f.owner, { id: cancelled.id, view: "transcript" });
    assert.ok("text" in view.data && view.data.text.includes("CANCELLED_PRIVATE_TASK"));
    const waiting = await f.dispatch("delete");
    await until(async () => (await f.background.getDelegation(waiting.id, f.owner.parentThreadId)).status === "waiting_input");
    f.deliveries.length = 0;
    await f.service.beforeDelete(f.owner.parentThreadId);
    await f.background.beforeDelete(f.owner.parentThreadId);
    assert.deepEqual(f.deliveries, []);
  } finally { await f.close(); }
});
