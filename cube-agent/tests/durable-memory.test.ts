import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createDurableMemory } from "../src/durable-memory.js";
import { captureSourceTurns } from "../src/memory-evidence.js";
import { memoryFixture } from "./helpers/memory.js";

const generated = (text: string) => ({ content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] });
const lesson = { title: "Public APIs", text: "Use public storage APIs; preserve the source transcript.", status: "verified", evidence: [0] };

test("worker extracts then consolidates once, upserts provenance and never consumes already covered turns", async () => {
  const f = await memoryFixture();
  let worker: ReturnType<typeof createDurableMemory> | undefined;
  try {
    await f.thread("old");
    await f.thread("active");
    await f.store.registerThread("active", "foreground");
    const notices: unknown[] = [];
    let calls = 0, publications = 0;
    const model = new MockLanguageModelV3({ doGenerate: async options => {
      assert.ok(!options.tools?.length);
      calls++;
      return generated(JSON.stringify(calls === 1 ? { rollout: { title: "Storage change", sections: [lesson] }, candidates: [lesson] }
        : { entries: [{ existing: null, title: "Storage APIs", sections: [lesson] }], index: [{ entry: 0, text: "Public storage decisions" }] }));
    } });
    worker = createDurableMemory({ store: f.store, storage: async () => f.storage, projectRoot: f.root,
      config: { enabled: true, min_idle_hours: 6, model: "inherit" }, runtimeId: "worker",
      secrets: async () => [], resolveWriter: async () => ({ model, limits: { context: 256000, output: 32000 } }),
      notice: message => notices.push(message), onPublished: () => { publications++; } });
    worker.check();
    await worker.drain();
    assert.deepEqual(notices, []);
    assert.equal(calls, 2);
    assert.equal(publications, 2, "notify retrieval after successful extraction and consolidation");
    const state = await f.store.read();
    assert.deepEqual(state.entries.map(entry => entry.source_type).sort(), ["handbook", "index", "raw", "rollout"]);
    const rollout = state.entries.find(entry => entry.source_type === "rollout")!;
    assert.match(rollout.body, /Status: verified/);
    assert.equal(rollout.thread_id, "old");
    assert.equal(rollout.boundary!.ids.length, 4);
    assert.equal((await f.storage.listMessages({ threadId: "old", perPage: false })).messages.length, 4);
    assert.match((await f.store.snapshot())!.text, /memory_/);
    worker.check();
    await worker.drain();
    assert.equal(calls, 2);
    assert.equal((await f.store.read()).revision, state.revision);
    await f.store.releaseThread("active", "foreground");
  } finally { worker?.cancel(); await worker?.drain(); await f.close(); }
});

test("invalid output and cancelled in-flight work publish nothing and release their claim", async () => {
  const f = await memoryFixture();
  let worker: ReturnType<typeof createDurableMemory> | undefined;
  try {
    await f.thread("old");
    const notices: unknown[] = [];
    const options = { store: f.store, storage: async () => f.storage, projectRoot: f.root,
      config: { enabled: true, min_idle_hours: 6, model: "inherit" }, runtimeId: "worker", secrets: async () => [], notice: (message: unknown) => notices.push(message) };
    worker = createDurableMemory({ ...options, resolveWriter: async () => ({
      model: new MockLanguageModelV3({ doGenerate: async () => generated('{"rollout":"invalid"}') }), limits: { context: 256000, output: 32000 },
    }) });
    worker.check(); await worker.drain();
    assert.ok(notices.length);
    assert.equal((await f.store.read()).entries.length, 0);
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    worker = createDurableMemory({ ...options, resolveWriter: async () => ({ model: new MockLanguageModelV3({ doGenerate: async () => {
      entered(); await gate;
      return generated(JSON.stringify({ rollout: { title: "Change", sections: [lesson] }, candidates: [] }));
    } }), limits: { context: 256000, output: 32000 } }) });
    worker.check(); await ready;
    worker.cancel(); finish(); await worker.drain();
    assert.equal((await f.store.read()).entries.length, 0);
    const token = await f.store.claimThread("old", "next-runtime");
    assert.ok(token);
    await f.store.releaseClaim("old", token);
  } finally { worker?.cancel(); await worker?.drain(); await f.close(); }
});

test("complete-turn capture detects source edits and never checkpoints beyond an incomplete tool", async () => {
  const f = await memoryFixture();
  try {
    const messages = await f.thread("source");
    const captured = await captureSourceTurns(f.storage, f.store.projectId, "source");
    assert.equal(captured.turns.length, 2);
    assert.equal((await captureSourceTurns(f.storage, f.store.projectId, "source", captured.boundary)).turns.length, 0);
    await f.storage.saveMessages({ messages: [{ ...messages[0]!, content: { format: 2, parts: [{ type: "text", text: "Corrected evidence" }] } }] });
    assert.equal((await captureSourceTurns(f.storage, f.store.projectId, "source", captured.boundary)).changed, true);
    await f.storage.saveMessages({ messages: [{ ...messages[1]!, content: { format: 2, parts: [{ type: "tool-invocation", toolInvocation: { state: "call", toolCallId: "pending", toolName: "read_file", args: { path: "file" } } }] } }] });
    assert.equal((await captureSourceTurns(f.storage, f.store.projectId, "source")).turns.length, 0);
  } finally { await f.close(); }
});

test("a backdated/equal-timestamp insertion invalidates the old ordered boundary", async () => {
  const f = await memoryFixture();
  try {
    const messages = await f.thread("source");
    const captured = await captureSourceTurns(f.storage, f.store.projectId, "source");
    await f.storage.saveMessages({ messages: [
      { ...messages[0]!, id: "inserted-user", createdAt: new Date(messages[0]!.createdAt.getTime() - 1) },
      { ...messages[1]!, id: "inserted-answer", createdAt: messages[0]!.createdAt },
    ] });
    const next = await captureSourceTurns(f.storage, f.store.projectId, "source", captured.boundary);
    assert.equal(next.changed, true);
    assert.notDeepEqual(next.boundary.ids, captured.boundary.ids);
    assert.equal(next.boundary.ids.includes(messages[3]!.id), false, "do not checkpoint past the newly incomplete first turn");
  } finally { await f.close(); }
});
