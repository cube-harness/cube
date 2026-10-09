import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HomeManager, RunnableConfigSchema } from "@cube/workspace";
import type { ChildRunResult, MemoryStorage, SubagentChild } from "@cube/agent";
import { SubagentService, type SubagentRecord } from "../../src/services/subagent.service.js";

const { LibSQLStore } = createRequire(import.meta.resolve("@cube/agent"))("@mastra/libsql");
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Condition did not settle");
};

async function fixture(concurrency = 2) {
  const root = await mkdtemp(path.join(process.env.CUBE_SUBAGENT_TEST_ROOT ?? os.tmpdir(), "cube-subagents-"));
  const home = new HomeManager({ cubeHome: path.join(root, "home"), userHome: root });
  await home.ensure();
  const store = new LibSQLStore({ id: randomUUID(), url: `file:${home.getMemoryDbPath()}` });
  await store.init();
  const storage: MemoryStorage = await store.getStore("memory");
  const parent = randomUUID();
  await storage.saveThread({ thread: { id: parent, resourceId: root, title: "Parent",
    createdAt: new Date(), updatedAt: new Date(), metadata: { existing: true } } });
  const owner = { projectRoot: root, parentThreadId: parent };
  const config = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test", subagents: { concurrency } });
  const pending = new Map<string, { content: string; finish: (status?: ChildRunResult["status"], text?: string) => void }>();
  const attempts: { id: string; content: string }[] = [];
  const deliveries: SubagentRecord[] = [];
  const notices: string[] = [];
  let failDelivery = false;
  let running = 0, peak = 0;
  const options = { home, projectRoot: root, config, storage: async () => storage,
    readParent: async () => ({ modelId: "google/test", instructions: { soul: "Snapshot", sources: [], explored: [] } }),
    resolveModel: async () => ({ modelId: "google/test" }), toolNames: async () => ["read_file", "write_file"],
    currentThread: () => parent, redact: async (text: string) => text.replaceAll("fixture-secret", "[Redacted]"),
    notice: (text: string) => notices.push(text),
    deliver: async (record: SubagentRecord) => { if (failDelivery) throw new Error("delivery offline"); deliveries.push(record); },
    createChild: async (record: SubagentRecord): Promise<SubagentChild> => ({
      session: { subscribe: () => () => {}, abort: () => pending.get(record.id)?.finish("cancelled"), getCurrentRunId: () => record.runId },
      tools: { processes: { list: () => [] }, discardPreview: () => {} }, agent: {}, context: {},
      run: async (content: string) => {
        attempts.push({ id: record.id, content }); running++; peak = Math.max(peak, running);
        return new Promise<ChildRunResult>(resolve => pending.set(record.id, { content, finish: (status = "completed", text = "report") => {
          pending.delete(record.id); running--;
          resolve({ runId: randomUUID(), status, text, startedAt: Date.now(), completedAt: Date.now(), toolActivity: [],
            ...(status === "failed" ? { error: "provider failed" } : {}) });
        } }));
      }, drain: async () => {}, dispose: async () => {},
    } as unknown as SubagentChild),
  };
  const service = new SubagentService(options);
  await service.reloadCatalog();
  return { service, options, owner, storage, attempts, pending, deliveries, notices,
    peak: () => peak, failDelivery: (value: boolean) => { failDelivery = value; },
    async close() {
      await service.shutdown(); await store.close();
      // Native SQLite transaction handles on Windows release fully on process exit.
      if (!process.env.CUBE_SUBAGENT_TEST_ROOT) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
}
const task = (description: string) => ({ agent: "worker", description, task: description });

if (process.platform === "win32" && !process.env.CUBE_SUBAGENT_TEST_ROOT) {
  test("subagents service integration (isolated SQLite fixtures)", { timeout: 90000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cube-subagents-suite-"));
    try {
      const env = { ...process.env, CUBE_SUBAGENT_TEST_ROOT: root };
      delete env.NODE_TEST_CONTEXT;
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--test", import.meta.filename], { env, windowsHide: true });
      t.diagnostic(result.stdout);
      assert.equal(result.stderr, "");
      assert.match(result.stdout, /fail 0/);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
} else {

test("global FIFO slots and child follow-ups do not bypass concurrency or ownership", async () => {
  const f = await fixture();
  try {
    const spawned = await f.service.spawn(f.owner, { tasks: [task("one"), task("two"), task("three")] });
    const [a, b, c] = spawned.agents;
    await until(() => f.pending.size === 2);
    assert.equal(f.service.runningCount(), 2, "queued third child is not running");
    assert.equal(f.service.runningCount(randomUUID()), 0, "other parents have a separate count");
    assert.equal(f.service.runningCount(null), 0);
    assert.deepEqual(f.attempts.map(item => item.content), ["one", "two"]);
    assert.equal((await f.service.send(f.owner, { id: a!.id, message: "follow-up" })).queued, true);
    await assert.rejects(f.service.get({ ...f.owner, parentThreadId: randomUUID() }, { id: a!.id, view: "status" }), /Unknown/);
    f.pending.get(a!.id)!.finish();
    await until(() => f.pending.has(c!.id));
    assert.equal(f.attempts[2]!.content, "three");
    f.pending.get(b!.id)!.finish();
    await until(() => f.attempts.some(item => item.content === "follow-up"));
    assert.equal(f.peak(), 2);
    await f.service.interrupt(f.owner, a!.id);
    f.pending.get(c!.id)!.finish();
    await until(async () => (await f.service.list(f.owner)).every(item => ["completed", "cancelled"].includes(item.status)));
    assert.equal(f.service.runningCount(), 0);
    assert.equal((await f.storage.getThreadById({ threadId: f.owner.parentThreadId }))!.metadata?.existing, true);
  } finally { await f.close(); }
});

test("chain substitutes actual initial report and cancels all dependent steps on failure", async () => {
  const f = await fixture();
  try {
    const spawned = await f.service.spawn(f.owner, { chain: [task("one"), task("two {previous}"), task("three {previous}")] });
    await until(() => f.pending.has(spawned.agents[0]!.id));
    f.pending.get(spawned.agents[0]!.id)!.finish("completed", "verified first");
    await until(() => f.pending.has(spawned.agents[1]!.id));
    assert.equal(f.attempts[1]!.content, "two verified first");
    f.pending.get(spawned.agents[1]!.id)!.finish("failed");
    await until(async () => (await f.service.list(f.owner)).find(item => item.id === spawned.agents[2]!.id)?.status === "cancelled");
    assert.equal(f.attempts.length, 2);
    assert.equal((await f.service.get(f.owner, { id: spawned.agents[1]!.id, view: "result" })).status, "failed");
  } finally { await f.close(); }
});

test("role isolation defaults apply before dispatch and explicit spawn wins for single and chain", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.owner.projectRoot, ".cube", "agents");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "worker.md"), "---\ndescription: Isolated worker\nisolation: worktree\n---\nWork");
    await f.service.reloadCatalog();
    await assert.rejects(f.service.spawn(f.owner, { chain: [task("work"), { ...task("inspect"), agent: "explore" }] }), /different isolation/);
    assert.deepEqual(await f.service.list(f.owner), [], "reject incompatible chain before persisting any child");
    await assert.rejects(f.service.spawn(f.owner, task("needs git")), /Git|git|repository/);
    assert.equal(f.attempts.length, 0, "a worktree role must not silently execute in the main directory");
    const spawned = await f.service.spawn(f.owner, { ...task("explicit shared"), isolation: "none" });
    assert.equal(spawned.agents[0]!.isolation, "none");
    await until(() => f.pending.has(spawned.agents[0]!.id));
    f.pending.get(spawned.agents[0]!.id)!.finish();
    await until(() => f.deliveries.length === 1);
    const chain = await f.service.spawn(f.owner, { isolation: "none", chain: [task("work"), { ...task("inspect"), agent: "explore" }] });
    assert.ok(chain.agents.every(child => child.isolation === "none"));
    await f.service.interrupt(f.owner, chain.agents[0]!.id);
  } finally { await f.close(); }
});

test("bounded continuation retains oversized evidence and rejects tampering, wrong view and stale results", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const id = (await f.service.spawn(f.owner, task("large report"))).agents[0]!.id;
    await until(() => f.pending.has(id));
    const text = "Việt😀 fixture-secret ".repeat(8000);
    f.pending.get(id)!.finish("completed", text);
    await until(async () => (await f.service.list(f.owner))[0]!.status === "completed");
    let page = await f.service.get(f.owner, { id, view: "result" });
    const firstCursor = page.nextCursor!;
    let joined = "";
    for (;;) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 16384);
      assert.ok("text" in page.data);
      joined += page.data.text;
      if (!page.nextCursor) break;
      page = await f.service.get(f.owner, { id, view: "result", cursor: page.nextCursor });
    }
    assert.equal(JSON.parse(joined).text, text.replaceAll("fixture-secret", "[Redacted]"));
    await assert.rejects(f.service.get(f.owner, { id, view: "result", cursor: firstCursor + "x" }), /Invalid/);
    await assert.rejects(f.service.get(f.owner, { id, view: "transcript", cursor: firstCursor }), /owner\/view/);
    await f.service.send(f.owner, { id, message: "new attempt" });
    await until(() => f.pending.has(id));
    f.pending.get(id)!.finish("completed", "");
    await until(async () => {
      const view = await f.service.get(f.owner, { id, view: "result" });
      return !view.truncated && JSON.parse(view.data.text).text === "";
    });
    await assert.rejects(f.service.get(f.owner, { id, view: "result", cursor: firstCursor }), /stale/);
  } finally { await f.close(); }
});

test("delivery failure preserves actual result; recovery persists it without waking or replaying work", async () => {
  const f = await fixture();
  let recovered: SubagentService | undefined;
  try {
    f.failDelivery(true);
    const id = (await f.service.spawn(f.owner, task("completed but offline"))).agents[0]!.id;
    await until(() => f.pending.has(id));
    f.pending.get(id)!.finish("completed", "verified");
    await until(() => f.notices.length > 0);
    assert.equal((await f.service.list(f.owner))[0]!.status, "completed");
    await f.service.shutdown();
    const wakes: boolean[] = [];
    recovered = new SubagentService({ ...f.options, createChild: async () => { throw new Error("Recovery must not replay"); },
      deliver: async (_record, wake) => { wakes.push(wake); } });
    assert.equal((await recovered.list(f.owner))[0]!.status, "completed");
    await recovered.list(f.owner);
    assert.deepEqual(wakes, [false]);
    assert.equal(f.attempts.length, 1);
  } finally { await recovered?.shutdown(); await f.close(); }
});

test("restart marks in-flight records unattached; non-Git batch preparation never starts models", async () => {
  const f = await fixture();
  let recovered: SubagentService | undefined;
  try {
    await assert.rejects(f.service.spawn(f.owner, { tasks: [task("normal"), { ...task("isolated"), isolation: "worktree" }] }));
    assert.equal(f.attempts.length, 0);
    assert.ok((await f.service.list(f.owner)).every(item => item.status === "failed"));
    const id = randomUUID();
    const source = (await f.storage.listThreads({ filter: { resourceId: f.owner.projectRoot } })).threads.find(item => item.metadata?.cubeSubagent)!;
    const record = { ...source.metadata!.cubeSubagent as SubagentRecord, id, status: "waiting_approval", queuedMessages: 2 };
    await f.storage.saveThread({ thread: { ...source, id, metadata: { cubeSubagent: record } } });
    recovered = new SubagentService(f.options);
    const restored = await recovered.get(f.owner, { id, view: "status" });
    assert.equal(restored.status, "unattached");
    assert.equal((restored.data as { queuedMessages: number }).queuedMessages, 0);
    assert.equal(f.attempts.length, 0);
  } finally { await recovered?.shutdown(); await f.close(); }
});

test("factory failure is inspectable, delivered and never reuses a previous report", async () => {
  const f = await fixture();
  try {
    f.options.createChild = async () => { throw new Error("Unavailable child credential"); };
    const id = (await f.service.spawn(f.owner, task("failure"))).agents[0]!.id;
    await until(() => f.deliveries.length === 1);
    const result = await f.service.get(f.owner, { id, view: "result" });
    assert.equal(result.status, "failed");
    assert.match(JSON.parse(result.data.text).error, /Unavailable child credential/);
    assert.equal(result.runId, undefined, "a dispatch failure must not invent a native run ID");
    assert.ok(f.deliveries[0]!.pendingDelivery);
  } finally { await f.close(); }
});

test("interrupt cancels pending processes before running ones and deletion still allows shutdown", async () => {
  const f = await fixture();
  const statuses = new Map([["A", "running"], ["B", "pending"]]);
  const order: string[] = [];
  const create = f.options.createChild;
  f.options.createChild = async record => {
    const child = await create(record);
    child.tools.processes = { list: () => [...statuses].map(([id, status]) => ({ id, result: { status } })),
      stop: async id => {
        order.push(id); const wasRunning = statuses.get(id) === "running"; statuses.set(id, "cancelled");
        if (wasRunning && statuses.get("B") === "pending") statuses.set("B", "running");
      } } as unknown as SubagentChild["tools"]["processes"];
    return child;
  };
  try {
    const id = (await f.service.spawn(f.owner, task("process owner"))).agents[0]!.id;
    await until(() => f.pending.has(id));
    f.pending.get(id)!.finish();
    await until(() => f.deliveries.length === 1);
    await f.service.interrupt(f.owner, id);
    assert.deepEqual(order, ["B", "A"]);
    assert.ok([...statuses.values()].every(status => status === "cancelled"));
    await f.service.beforeDelete(f.owner.parentThreadId);
    await f.service.shutdown();
  } finally { await f.close(); }
});

test("worktree removal excludes concurrent follow-ups and retains result/transcript inspection", async () => {
  const f = await fixture();
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: f.owner.projectRoot, windowsHide: true });
  let release!: () => void;
  let paused = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = f.storage.listThreads.bind(f.storage);
  try {
    await git("init"); await git("config", "user.name", "Cube Test");
    await git("config", "user.email", "cube@example.invalid");
    await writeFile(path.join(f.owner.projectRoot, ".gitignore"), "home/\n");
    await writeFile(path.join(f.owner.projectRoot, "fixture.txt"), "fixture\n");
    await git("add", ".gitignore", "fixture.txt"); await git("commit", "-m", "fixture");
    const id = (await f.service.spawn(f.owner, { ...task("owned checkout"), isolation: "worktree" })).agents[0]!.id;
    await until(() => f.pending.has(id)); f.pending.get(id)!.finish();
    await until(() => f.deliveries.length === 1);
    f.storage.listThreads = async input => { paused = true; await gate; return list(input); };
    const removal = f.service.removeWorktree(f.owner, id, true);
    await until(() => paused);
    await assert.rejects(f.service.send(f.owner, { id, message: "must not run" }), /unavailable/);
    release(); await removal;
    assert.equal(f.attempts.length, 1);
    const changes = await f.service.get(f.owner, { id, view: "changes" });
    assert.match(changes.data.unavailable!, /removed/);
    assert.equal((await f.service.get(f.owner, { id, view: "result" })).status, "completed");
    await assert.rejects(f.service.send(f.owner, { id, message: "removed checkout" }), /unavailable/);
  } finally { release(); f.storage.listThreads = list; await f.close(); }
});

test("recovered partial preparation cannot run in the main checkout and can release owned resources", async () => {
  const f = await fixture();
  let recovered: SubagentService | undefined;
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: f.owner.projectRoot, windowsHide: true });
  try {
    await git("init"); await git("config", "user.name", "Cube Test");
    await git("config", "user.email", "cube@example.invalid");
    await writeFile(path.join(f.owner.projectRoot, "fixture.txt"), "fixture\n");
    await git("add", "fixture.txt"); await git("commit", "-m", "fixture");
    const id = (await f.service.spawn(f.owner, { ...task("partial checkout"), isolation: "worktree" })).agents[0]!.id;
    await until(() => f.pending.has(id)); f.pending.get(id)!.finish();
    await until(() => f.deliveries.length === 1);
    await f.service.shutdown();
    const thread = await f.storage.getThreadById({ threadId: id });
    const record = thread!.metadata!.cubeSubagent as SubagentRecord;
    await f.storage.patchThread({ id, metadata: { cubeSubagent: { ...record, status: "failed", checkoutAvailable: false } } });
    recovered = new SubagentService(f.options);
    await assert.rejects(recovered.send(f.owner, { id, message: "must not fall back to main" }), /unavailable/);
    await assert.rejects(recovered.beforeDelete(f.owner.parentThreadId), /retained/);
    await recovered.removeWorktree(f.owner, id, true);
    await recovered.beforeDelete(f.owner.parentThreadId);
    assert.equal(await readFile(path.join(f.owner.projectRoot, "fixture.txt"), "utf8"), "fixture\n");
    await assert.rejects(git("rev-parse", "--verify", record.baseline!.ref));
  } finally { await recovered?.shutdown(); await f.close(); }
});
}
