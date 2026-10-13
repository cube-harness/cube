import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStore } from "@cube/workspace";
import { createMemoryRecall } from "../src/tools/memory-recall.tool.js";
import { makeMemoryEntry } from "../src/durable-memory.js";
import { memoryFixture } from "./helpers/memory.js";

test("recall query is lexical/no-SQL; reads bundle originals, page safely and reject forged/stale cursors", async () => {
  const f = await memoryFixture();
  try {
    const messages = await f.thread("source", f.root, 12);
    const sections = [{ title: "Public storage", text: Array.from({ length: 260 }, (_, i) => `Line ${i}: public API`).join("\n"), status: "verified" as const, evidence: messages.map((_, index) => index) }];
    const entry = makeMemoryEntry(f.store.projectId, "memory_public", "handbook", "Public APIs", sections, messages.map(message => ({ thread_id: "source", message_id: message.id })));
    await f.store.publish({ revision: (await f.store.read()).revision, replacements: { "MEMORY.md": [entry] } }, new AbortController().signal);
    let sqlReads = 0;
    const recall = createMemoryRecall({ store: f.store, storage: async () => { sqlReads++; return f.storage; }, secrets: async () => [] });
    const query = await recall.recall({ query: "public" });
    assert.equal(query.mode, "query");
    assert.equal(sqlReads, 0);
    assert.equal(query.results?.[0]?.source_id, "memory_public");
    let result = await recall.recall({ source_id: "memory_public" });
    assert.equal(result.mode, "read");
    assert.ok(result.evidence?.length);
    const seenLines: number[] = [], seenMessages: string[] = [];
    for (let pages = 0; pages < 10; pages++) {
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
      assert.ok((result.lines?.length ?? 0) <= 120);
      assert.ok((result.evidence?.length ?? 0) <= 8);
      seenLines.push(...result.lines!.map(line => line.line));
      seenMessages.push(...result.evidence!.map(message => message.message_id));
      if (!result.next_read) break;
      const { cursor } = result.next_read;
      await assert.rejects(recall.recall({ source_id: "memory_public", cursor: cursor + "bad" }));
      result = await recall.recall(result.next_read);
    }
    assert.equal(seenLines.length, entry.body.split("\n").length);
    assert.equal(new Set(seenMessages).size, messages.length);
    const page = await recall.recall({ source_id: "memory_public" });
    await f.store.publish({ revision: (await f.store.read()).revision, replacements: { "MEMORY.md": [{ ...entry, revision: "changed" }] } }, new AbortController().signal);
    await assert.rejects(recall.recall(page.next_read!), /stale/);
    await assert.rejects(recall.recall({ source_id: "../../test.sqlite" }));
  } finally { await f.close(); }
});

test("BM25 recall scopes sections, redacts before truncating and reads fresh committed sources", async () => {
  const f = await memoryFixture();
  try {
    const messages = await f.thread("source", f.root, 2);
    const secret = `test-secret-${"q".repeat(100)}`;
    const sections = [
      { title: "Other decision", text: "Unrelated storage", status: "verified" as const, evidence: [0] },
      { title: "OAuth", text: `alpha ${"padding ".repeat(147)}${secret}\n${"alpha\n".repeat(20)}`, status: "verified" as const, evidence: [1] },
    ];
    const entry = makeMemoryEntry(f.store.projectId, "memory_auth", "handbook", "Decisions", sections,
      messages.map(message => ({ thread_id: "source", message_id: message.id })));
    const foreign = createMemoryStore(f.home, "D:/other-project");
    const otherProject = { ...entry, project_id: foreign.projectId, source_id: "memory_foreign" };
    const recall = createMemoryRecall({ store: f.store, storage: async () => { throw new Error("Query must not read SQLite"); }, secrets: async () => [secret] });
    // Seed a different project through its own scoped store, not a model-supplied path.
    await foreign.publish({ revision: (await foreign.read()).revision, replacements: { "MEMORY.md": [otherProject] } }, new AbortController().signal);
    await f.store.publish({ revision: (await f.store.read()).revision, replacements: { "MEMORY.md": [entry] } }, new AbortController().signal);
    const result = await recall.recall({ query: "alpha" });
    assert.equal(result.mode, "query");
    assert.equal(result.lexical, true);
    assert.equal(result.results!.length, 1);
    const hit = result.results![0]!;
    assert.equal(hit.source_id, "memory_auth");
    assert.ok(hit.excerpt.includes("[Redacted]"));
    assert.ok(!hit.excerpt.includes("test-secret-"));
    assert.ok(!hit.excerpt.includes("Unrelated"));
    assert.ok(hit.excerpt.length <= 1200);
    assert.ok(hit.end_line - hit.start_line < 12);
    assert.equal(hit.end_line - hit.start_line + 1, hit.excerpt.split("\n").length);
    assert.deepEqual(hit.evidence_refs, [{ thread_id: "source", message_id: "source-1" }]);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32768);
    await f.store.publish({ revision: (await f.store.read()).revision, replacements: { "MEMORY.md": [] } }, new AbortController().signal);
    assert.deepEqual((await recall.recall({ query: "alpha" })).results, []);
  } finally { await f.close(); }
});
