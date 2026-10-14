import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HomeManager, AuthStore, createMemoryStore, createMemoryIndexStore, MemoryRetrievalSchema } from "@cube/workspace";
import { makeMemoryEntry } from "../src/durable-memory.js";
import { resolveMemoryEmbedding } from "../src/rag/embedding.js";
import { createMemoryRetrieval } from "../src/rag/retrieval.js";

const root = await mkdtemp(path.join(tmpdir(), "cube-retrieval-live-"));
const home = new HomeManager({ cubeHome: root }), store = createMemoryStore(home, root);
const config = MemoryRetrievalSchema.parse({ enabled: true, model: "ollama/nomic-embed-text:latest" });
let documentCalls = 0, queryCalls = 0;
const notices: string[] = [];
const makeClient = () => createMemoryRetrieval({ store, indexStore: createMemoryIndexStore(home, store.projectId),
  cacheDir: home.getMemoryRetrievalDir(), runtimeId: "local-smoke", secrets: async () => [],
  notice: message => notices.push(message), resolveEmbedding: async () => {
    const native = await resolveMemoryEmbedding({ config, auth: new AuthStore(home), localOptions: {} });
    return { ...native, batchSize: 1, embed: async (values, kind, signal) => {
      if (kind === "document") documentCalls++; else queryCalls++;
      return native.embed(values, kind, signal);
    } };
  } });
let client = makeClient();
try {
  const entry = (id: string, title: string, text: string) => makeMemoryEntry(store.projectId, `memory_${id}`, "handbook", title,
    [{ title, text, status: "verified", evidence: [] }], []);
  const entries = [entry("persistence", "Safe storage", "Publish files by writing a temporary file and atomically renaming it. Interrupted saves must not corrupt committed data."),
    entry("layout", "Terminal UI", "Use the existing terminal theme and keep the input editor at the bottom."),
    entry("permissions", "Filesystem access", "Tool execution outside a trusted workspace is denied unless users explicitly override permission policy.")];
  await store.publish({ revision: (await store.read()).revision, replacements: { "MEMORY.md": entries } }, new AbortController().signal);
  client.check(); await client.drain();
  assert.deepEqual(notices, [], "Ollama or installed Nomic model is unavailable; no paid fallback");
  assert.equal(documentCalls, 3);
  const result = await client.search("How can we prevent damaged data if a save is interrupted?");
  assert.equal(result.retrieval, "hybrid");
  assert.equal(result.hits[0]?.entry.source_id, "memory_persistence");
  await client.close();
  client = makeClient(); client.check(); await client.drain();
  assert.equal(documentCalls, 3, "restart must reuse complete published chunks");
  entries[1] = entry("layout", "Terminal UI", "The terminal editor remains pinned to the bottom with reusable themed surfaces.");
  await store.publish({ revision: (await store.read()).revision, replacements: { "MEMORY.md": entries } }, new AbortController().signal);
  client.check(); await client.drain();
  assert.equal(documentCalls, 4, "only changed entry is embedded again");
  assert.deepEqual(notices, []);
  console.log(`memory-retrieval live: Nomic hybrid/restart/incremental OK (${documentCalls} document calls, ${queryCalls} query calls)`);
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
