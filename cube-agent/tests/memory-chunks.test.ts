import assert from "node:assert/strict";
import test from "node:test";
import { memoryHash, type MemoryEntry } from "@cube/workspace";
import { chunkMemory } from "../src/rag/chunks.js";
import { redactMemoryText } from "../src/memory-evidence.js";

test("native chunks preserve occurrences/Unicode/lines and mask secrets across boundaries before embedding", async () => {
  const secret = "credential-".repeat(30);
  const body = `# Title\n\n${"repeat words\n".repeat(60)}\n\`\`\`ts\nconst x = 'tiếng Việt 😀';\n\`\`\`\n| column | value |\n| --- | --- |\n\n${"x ".repeat(100)}${secret}\n${"long line words ".repeat(100)}\n${"😀".repeat(100)}`;
  const entry: MemoryEntry = { source_id: "memory_chunk", source_type: "handbook", project_id: "project",
    title: "Title", body, sections: [], status: "verified", revision: "r1", updated_at: new Date().toISOString(), incorporated: {} };
  const profile = { id: "profile", documentPrefix: "", maxInputBytes: 128 };
  const chunks = await chunkMemory([entry, { ...entry, project_id: "other", source_id: "foreign" }], "project", profile, [secret]);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every(item => item.sourceId === "memory_chunk" && Buffer.byteLength(item.text) <= 128 && item.text.isWellFormed() && item.startLine <= item.endLine));
  assert.ok(new Set(chunks.map(item => item.startLine)).size > 10);
  assert.ok(!chunks.map(item => item.text).join("").includes("credential"));
  assert.equal(redactMemoryText(body, [secret], { preserveOffsets: true }).length, body.length);
  assert.ok(chunks.every(item => item.inputHash === memoryHash(item.text)));
  const moved = await chunkMemory([{ ...entry, revision: "r2" }], "project", profile, [secret]);
  assert.deepEqual(moved.map(item => item.inputHash), chunks.map(item => item.inputHash));
});

test("memory sections stay whole when they fit; oversized sections retain heading/status within the byte budget", async () => {
  const header = "## Auxiliary reasoning effort\nStatus: verified\n";
  const body = header + "Title, compaction and durable memory inherit the parent model. ".repeat(20);
  const entry: MemoryEntry = { source_id: "memory_section", source_type: "handbook", project_id: "project",
    title: "Settings", body, sections: [{ start_line: 1, end_line: 3, evidence_refs: [] }],
    status: "verified", revision: "r1", updated_at: new Date().toISOString(), incorporated: {} };
  const profile = { id: "profile", documentPrefix: "search_document: ", maxInputBytes: 2048 };
  const whole = await chunkMemory([entry], "project", profile, []);
  assert.equal(whole.length, 1);
  assert.equal(whole[0]!.text, body);
  assert.equal(whole[0]!.startLine, 1);
  const split = await chunkMemory([entry], "project", { ...profile, maxInputBytes: 256 }, []);
  assert.ok(split.length > 1);
  for (const chunk of split) {
    assert.ok(chunk.text.startsWith(header));
    assert.ok(chunk.text.slice(header.length).trim());
    assert.ok(Buffer.byteLength(profile.documentPrefix + chunk.text) <= 256);
    assert.equal(chunk.startLine, 3);
    assert.equal(chunk.endLine, 3);
    assert.equal(chunk.inputHash, memoryHash(profile.documentPrefix + chunk.text));
  }
});
