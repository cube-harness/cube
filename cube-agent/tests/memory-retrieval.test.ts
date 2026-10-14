import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HomeManager, createMemoryStore, createMemoryIndexStore, memoryHash, MemoryRetrievalSchema, renderMemory, type MemoryEntry, Bootstrap, CubeWorkspace, ConfigStore, RunnableConfigSchema } from "@cube/workspace";
import { createCubeMastra } from "../src/bootstrap.js";
import { createMemoryRetrieval, fuseMemory } from "../src/rag/retrieval.js";
import type { MemoryEmbedding } from "../src/rag/embedding.js";
import { searchMemory } from "../src/rag/search.js";

// Native file-backed LibSQL fixtures must not share process-global teardown state.
function isolatedTest(name: string, run: () => Promise<void>) {
  if (process.env.CUBE_RETRIEVAL_TEST === name) test(name, run);
  else if (!process.env.CUBE_RETRIEVAL_TEST) test(name, { timeout: 45000 }, async () => {
    try {
      const env = { ...process.env, CUBE_RETRIEVAL_TEST: name };
      delete env.NODE_TEST_CONTEXT;
      const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", fileURLToPath(import.meta.url)], {
        env, timeout: 35000, windowsHide: true, maxBuffer: 128 * 1024,
      });
      assert.ok(result.stdout.includes(name), "child must execute the selected native case");
      assert.match(result.stdout, /(?:#|ℹ) pass 2\b/, "selected native case and pure RRF check must both pass");
    } catch (error) {
      const result = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`${result.message}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "cube-retrieval-test-"));
  const home = new HomeManager({ cubeHome: root }), store = createMemoryStore(home, root);
  const indexStore = createMemoryIndexStore(home, store.projectId);
  const notices: string[] = [];
  const secretValues: string[] = [];
  const clients: ReturnType<typeof createMemoryRetrieval>[] = [];
  const entry = (id: string, body: string): MemoryEntry => ({ source_id: `memory_${id}`, source_type: "handbook",
    project_id: store.projectId, body, title: id, status: "verified", sections: [{ start_line: 1, end_line: body.split("\n").length, evidence_refs: [] }],
    revision: randomUUID(), updated_at: new Date().toISOString(), incorporated: {} });
  const publish = async (entries: MemoryEntry[]) => store.publish({ revision: (await store.read()).revision, replacements: { "MEMORY.md": entries } }, new AbortController().signal);
  const client = (embed: MemoryEmbedding["embed"], profile = "profile") => {
    const value = createMemoryRetrieval({ store, indexStore, cacheDir: home.getMemoryRetrievalDir(), runtimeId: randomUUID(),
      secrets: async () => [...secretValues], notice: text => notices.push(text), resolveEmbedding: async () => ({ batchSize: 1, embed,
        profile: { id: memoryHash(profile), documentPrefix: "", maxInputBytes: 2048 } }) });
    clients.push(value); return value;
  };
  return { root, home, store, indexStore, notices, secretValues, entry, publish, client,
    close: async () => { await Promise.all(clients.map(value => value.close())); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}

isolatedTest("partial index participates immediately; cancellation/restart preserves published batches", async () => {
  const f = await fixture();
  let started!: () => void;
  const secondStarted = new Promise<void>(resolve => { started = resolve; });
  let documentCalls = 0;
  try {
    await f.publish([f.entry("first", "store preferences"), f.entry("second", "second lexical decision")]);
    const first = f.client(async (_values, kind, signal) => {
      if (kind === "document" && ++documentCalls === 2) {
        started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return [[1, 0]];
    });
    first.check();
    await secondStarted;
    assert.equal((await f.indexStore.read())!.ready.length, 1);
    const result = await first.search("second");
    assert.equal(result.retrieval, "hybrid");
    assert.equal(result.indexing, true);
    assert.ok(result.hits.some(item => item.entry.source_id === "memory_second"));
    first.cancel(); await first.drain(); await first.close();
    let remaining = 0;
    const resumed = f.client(async (_values, kind) => { if (kind === "document") remaining++; return [[1, 0]]; });
    resumed.check(); await resumed.drain();
    assert.equal(remaining, 1);
    assert.equal((await f.indexStore.read())!.ready.length, 2);
    assert.deepEqual(f.notices, []);
  } finally { await f.close(); }
});

isolatedTest("metadata-only updates reuse vectors, edits replace inputs and deletes cannot return stale hits", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const original = f.entry("one", "stable handbook decision");
    await f.publish([original]);
    const value = f.client(async (_values, kind) => { if (kind === "document") calls++; return [[1, 0]]; });
    value.check(); await value.drain();
    assert.equal(calls, 1);
    const originalGeneration = (await f.indexStore.read())!.generation;
    await f.publish([{ ...original, title: "updated title", revision: "updated" }]);
    value.check(); await value.drain();
    assert.equal(calls, 1);
    const changed = { ...original, revision: "edit", body: "newly changed handbook decision" };
    await f.publish([changed]);
    assert.equal((await value.search("stable")).retrieval, "bm25");
    value.check(); await value.drain();
    assert.equal(calls, 2);
    assert.equal((await value.search("newly")).retrieval, "hybrid");
    // Manual edits can retain the header revision: validate body/input, not only revision.
    await writeFile(path.join(f.home.getMemoryDir(), "MEMORY.md"), renderMemory([{ ...changed, body: "manually replaced content" }]));
    const manual = await value.search("newly");
    assert.equal(manual.retrieval, "bm25");
    assert.equal(manual.hits.length, 0);
    await f.publish([]);
    assert.deepEqual((await value.search("handbook")).hits, []);
    value.check(); await value.drain();
    assert.equal((await f.indexStore.read())!.ready.length, 0);
    const other = f.client(async () => { throw new Error("Empty corpus must not embed"); }, "empty-profile");
    other.check(); await other.drain();
    assert.notEqual((await f.indexStore.read())!.generation, originalGeneration);
    await f.publish([original]);
    await value.reload(); await value.drain();
    assert.notEqual((await f.indexStore.read())!.generation, originalGeneration, "returning to an older profile does not restore its generation");
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

isolatedTest("profile switch at equal dimension invalidates late work and never embeds another project's memory", async () => {
  const f = await fixture();
  let started!: () => void, release!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  try {
    await f.publish([f.entry("one", "current project entry")]);
    const foreign = createMemoryStore(f.home, path.join(f.root, "foreign"));
    await foreign.publish({ revision: (await foreign.read()).revision, replacements: { "MEMORY.md": [{ ...f.entry("foreign", "DO_NOT_EMBED_OTHER_PROJECT"), project_id: foreign.projectId }] } }, new AbortController().signal);
    const old = f.client(async values => { assert.deepEqual(values, ["current project entry"]); started(); await wait; return [[1, 0]]; }, "old");
    old.check(); await Promise.race([startedPromise, old.drain().then(() => { throw new Error(`Index ended before embedding: ${f.notices.join("; ")}`); })]);
    const oldGeneration = (await f.indexStore.read())!.generation;
    let calls = 0;
    const newer = f.client(async (values, kind) => { if (kind === "document") { calls++; assert.deepEqual(values, ["current project entry"]); } return [[1, 0]]; }, "new");
    newer.check(); await newer.drain();
    assert.equal(calls, 1);
    const current = (await f.indexStore.read())!;
    assert.notEqual(current.generation, oldGeneration);
    release(); await old.drain(); old.check(); await old.drain();
    assert.equal((await f.indexStore.read())!.generation, current.generation);
    assert.equal((await old.search("entry")).retrieval, "bm25");
    assert.equal((await newer.search("entry")).retrieval, "hybrid");
    assert.equal(current.ready.length, 1);
  } finally { release?.(); await f.close(); }
});

isolatedTest("empty caches make no embedding calls; failures and uncommitted vector rows fall back to BM25", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const value = f.client(async () => { calls++; f.secretValues.push("rotated-provider-secret"); throw new Error("quota exceeded: rotated-provider-secret"); });
    value.check(); await value.drain();
    assert.equal((await value.search("test")).retrieval, "bm25");
    assert.equal(calls, 0);
    assert.equal(await f.indexStore.read(), null);
    await f.publish([f.entry("one", "lexical safety")]);
    value.check(); await value.drain();
    assert.equal(calls, 1);
    const result = await value.search("lexical");
    assert.equal(result.hits.length, 1);
    assert.equal(result.retrieval, "bm25");
    assert.match(result.warning!, /quota/);
    assert.ok(!result.warning!.includes("rotated-provider-secret"));
    assert.ok(f.notices.every(notice => !notice.includes("rotated-provider-secret")));
    assert.equal(calls, 1, "no hot retry or query probe without ready vectors");
    let documentCalls = 0;
    const healthy = f.client(async (_values, kind) => { if (kind === "document") documentCalls++; return [[1, 0]]; });
    healthy.check(); await healthy.drain();
    await f.indexStore.update(current => ({ ...current!, ready: [] }));
    assert.equal((await healthy.search("lexical")).retrieval, "bm25");
    healthy.check(); await healthy.drain();
    assert.equal(documentCalls, 2, "orphan row is not published work");
  } finally { await f.close(); }
});

test("RRF uses section rank, not raw scores or duplicate chunk count", () => {
  const entries: MemoryEntry[] = ["alpha", "beta"].map(id => ({ source_id: `memory_${id}`, source_type: "handbook", project_id: "p", title: id,
    body: "matching", sections: [], status: "verified", revision: "r", updated_at: new Date().toISOString(), incorporated: {} }));
  const lexical = searchMemory(entries, "matching");
  const semantic = [{ ...lexical[1]!, score: 999 }, { ...lexical[1]!, score: 999 }, { ...lexical[0]!, score: 0 }];
  const hits = fuseMemory(lexical, semantic);
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.entry.source_id, "memory_alpha");
  assert.equal(hits[0]!.score, 1 / 61 + 1 / 62);
  assert.equal(hits[1]!.score, 1 / 61 + 1 / 62);
});

isolatedTest("manual edits during embedding invalidate the batch and wait for explicit reload", async () => {
  const f = await fixture();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  try {
    const entry = f.entry("one", "old memory content");
    await f.publish([entry]);
    const value = f.client(async (_values, kind) => {
      if (kind === "document" && ++calls === 1) { started(); await gate; }
      return [[1, 0]];
    });
    value.check();
    await Promise.race([entered, value.drain().then(() => { throw new Error(f.notices.join("; ")); })]);
    await writeFile(path.join(f.home.getMemoryDir(), "MEMORY.md"), renderMemory([{ ...entry, body: "new manual content" }]));
    release(); await value.drain();
    assert.equal(calls, 1, "no implicit manual-edit indexing trigger");
    assert.equal((await f.indexStore.read())!.ready.length, 0, "stale result cannot publish");
    assert.equal((await value.search("manual")).retrieval, "bm25");
    await value.reload(); await value.drain();
    assert.equal(calls, 2);
    assert.equal((await value.search("manual")).retrieval, "hybrid");
  } finally { release?.(); await f.close(); }
});

isolatedTest("composition indexing and explicit reload do not mutate frozen instructions or the chat model", async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let composition: Awaited<ReturnType<typeof createCubeMastra>> | undefined;
  let modelName = "";
  globalThis.fetch = async (_url, init) => {
    modelName = JSON.parse(String(init?.body)).model;
    return Response.json({ model: modelName, embeddings: [[1, 0]], total_duration: 1, load_duration: 1, prompt_eval_count: 2 });
  };
  try {
    const home = new HomeManager({ cubeHome: f.root, userHome: f.root });
    await new Bootstrap(home).run();
    await f.publish([f.entry("one", "atomic persistence")]);
    await ConfigStore(home).update(current => ({ ...current, gateway: "api_key/google", model: "google/test",
      memory: { ...current.memory, durable: { ...current.memory.durable,
        retrieval: MemoryRetrievalSchema.parse({ enabled: true, model: "ollama/first" }) } } }));
    composition = await createCubeMastra(home, CubeWorkspace(home, f.root), RunnableConfigSchema.parse(await ConfigStore(home).read()));
    const instructions = structuredClone(composition.agent.readInstructions());
    const active = composition.agent.getActiveModelId();
    composition.memoryRetrieval.check(); await composition.memoryRetrieval.drain();
    assert.equal(modelName, "first");
    assert.equal((await composition.memoryRetrieval.search("atomic")).retrieval, "hybrid");
    assert.deepEqual(composition.agent.readInstructions(), instructions);
    await ConfigStore(home).update(current => ({ ...current, model: "google/not-applied",
      memory: { ...current.memory, durable: { ...current.memory.durable,
        retrieval: { ...current.memory.durable.retrieval, model: "ollama/second" } } } }));
    composition.memoryRetrieval.check(); await composition.memoryRetrieval.drain();
    assert.equal(modelName, "first", "ordinary triggers do not reread config");
    await composition.memoryRetrieval.reload(); await composition.memoryRetrieval.drain();
    assert.equal(modelName, "second");
    assert.equal(composition.agent.getActiveModelId(), active);
    assert.deepEqual(composition.agent.readInstructions(), instructions);
    assert.deepEqual((await (await composition.mastra.getStorage()!.getStore("memory"))!.listThreads({ filter: { resourceId: f.store.projectId } })).threads, []);
  } finally { await composition?.shutdown(); globalThis.fetch = originalFetch; await f.close(); }
});
