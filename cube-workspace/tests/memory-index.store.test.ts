import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HomeManager } from "../src/home-manager.js";
import { createMemoryIndexStore, type IndexManifest } from "../src/store/memory-index.store.js";
import { memoryHash } from "../src/store/memory.store.js";

test("manifest is lazy, isolated, atomic, bounded and rejects corrupt state without repair", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cube-memory-index-"));
  const home = new HomeManager({ cubeHome: root });
  try {
    const store = createMemoryIndexStore(home, "project"), other = createMemoryIndexStore(home, "other");
    assert.equal(await store.read(), null);
    await assert.rejects(access(home.getMemoryRetrievalDir()));
    const base: IndexManifest = { projectId: "project", profile: memoryHash("profile"), generation: randomUUID(),
      indexName: "memory_abc", dimension: null, chunks: [], ready: [], claim: null };
    await store.update(() => base);
    assert.equal(await other.read(), null);
    let count = 0;
    await Promise.all(Array.from({ length: 4 }, () => store.update(value => { count++; return { ...value!, dimension: (value!.dimension ?? 0) + 1 }; })));
    assert.equal(count, 4);
    assert.equal((await store.read())!.dimension, 4);
    await assert.rejects(store.update(value => ({ ...value!, projectId: "other" })));
    const file = path.join(home.getMemoryRetrievalDir(), "projects", `${memoryHash("project")}.json`);
    await writeFile(file, "invalid", "utf8");
    await assert.rejects(store.read(), /invalid or unavailable/);
    await assert.rejects(store.update(() => base), /invalid or unavailable/);
    await writeFile(file, " ".repeat(16 * 1024 * 1024 + 1));
    await assert.rejects(store.read(), /invalid or unavailable/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
