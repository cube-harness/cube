import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRetrievalSchema, memoryHash, type MemoryEntry } from "@cube/workspace";
import { chunkMemory } from "../src/rag/chunks.js";
import { redactMemoryText } from "../src/memory-evidence.js";

test("native chunks preserve occurrences/Unicode/lines and mask secrets across boundaries before embedding", async () => {
  const secret = "credential-".repeat(30);
  const body = `# Title\n\n${"repeat words\n".repeat(60)}\n\`\`\`ts\nconst x = 'tiếng Việt 😀';\n\`\`\`\n| column | value |\n| --- | --- |\n\n${"x ".repeat(100)}${secret}\n${"long line words ".repeat(100)}`;
  const entry: MemoryEntry = { source_id: "memory_chunk", source_type: "handbook", project_id: "project",
    title: "Title", body, sections: [], status: "verified", revision: "r1", updated_at: new Date().toISOString(), incorporated: {} };
  const config = MemoryRetrievalSchema.parse({ model: "ollama/nomic-embed-text:latest", chunk: { max_chars: 128, overlap_chars: 32 } });
  const profile = { id: "profile", endpoint: "local", config };
  const chunks = await chunkMemory([entry, { ...entry, project_id: "other", source_id: "foreign" }], "project", profile, [secret]);
  assert.ok(chunks.length > 10);
  assert.ok(chunks.every(item => item.sourceId === "memory_chunk" && item.text.length <= 128 && item.startLine <= item.endLine));
  assert.ok(new Set(chunks.map(item => item.startLine)).size > 10);
  assert.ok(!chunks.map(item => item.text).join("").includes("credential"));
  assert.equal(redactMemoryText(body, [secret], { preserveOffsets: true }).length, body.length);
  assert.ok(chunks.every(item => item.inputHash === memoryHash(item.text)));
  const moved = await chunkMemory([{ ...entry, revision: "r2" }], "project", profile, [secret]);
  assert.deepEqual(moved.map(item => item.inputHash), chunks.map(item => item.inputHash));
});
