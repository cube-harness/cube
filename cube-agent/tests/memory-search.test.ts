import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryEntry } from "@cube/workspace";
import { searchMemory } from "../src/rag/search.js";

const entry = (id: string, body: string): MemoryEntry => ({
  source_id: `memory_${id}`,
  source_type: "handbook",
  project_id: "project",
  title: "Note",
  status: "verified",
  updated_at: "2026-10-12T00:00:00Z",
  revision: "revision",
  incorporated: {},
  body,
  sections: [{ start_line: 1, end_line: body.split("\n").length, evidence_refs: [] }],
});

test("BM25 uses term frequency, corpus IDF and document-length normalization", () => {
  const hits = searchMemory([entry("once", "alpha"), entry("twice", "alpha alpha")], "alpha");
  assert.deepEqual(hits.map(hit => hit.entry.source_id), ["memory_twice", "memory_once"]);
  // Two documents: lengths 2/3 including the title, average 2.5, df(alpha)=2.
  assert.ok(Math.abs(hits[0]!.score - 0.2373416715660948) < 1e-12);
  assert.ok(Math.abs(hits[1]!.score - 0.19856803215183175) < 1e-12);
  assert.ok(searchMemory([entry("short", "alpha"), entry("long", `alpha ${"filler ".repeat(80)}`)], "alpha")[0]!.entry.source_id === "memory_short");
  const rare = searchMemory([
    entry("common", "common common"), entry("rare", "rare"), entry("other", "common"),
  ], "common rare");
  assert.equal(rare[0]!.entry.source_id, "memory_rare");
});

test("BM25 tokenizes Unicode and identifiers without substring false positives", () => {
  const sources = [entry("words", "Đăng nhập refresh_token oauth.gateway.ts"), entry("partial", "refresh_tokens authorization")];
  assert.equal(searchMemory(sources, "ĐĂNG NHẬP".normalize("NFD"))[0]!.entry.source_id, "memory_words");
  assert.deepEqual(searchMemory(sources, "refresh_token").map(hit => hit.entry.source_id), ["memory_words"]);
  assert.deepEqual(searchMemory(sources, "auth"), []);
  assert.equal(searchMemory(sources, "oauth.gateway.ts")[0]!.entry.source_id, "memory_words");
  assert.deepEqual(searchMemory(sources, "?!"), []);
  assert.deepEqual(searchMemory([], "alpha"), []);
  assert.deepEqual(searchMemory(sources, "missing"), []);
  assert.deepEqual(searchMemory(sources, "Đăng Đăng"), searchMemory(sources, "Đăng"));
});

test("search ranks sections and returns only matched-section lines and provenance", () => {
  const source = entry("sections", "Unrelated\nOld decision\n\nOAuth\nRefresh tokens safely\nEvidence");
  source.sections = [
    { start_line: 1, end_line: 3, evidence_refs: [{ thread_id: "old", message_id: "old-1" }] },
    { start_line: 4, end_line: 6, evidence_refs: [{ thread_id: "oauth", message_id: "oauth-1" }] },
  ];
  const hit = searchMemory([source], "refresh")[0]!;
  assert.equal(hit.start_line, 5);
  assert.equal(hit.end_line, 6);
  assert.equal(hit.excerpt, "Refresh tokens safely\nEvidence");
  assert.deepEqual(hit.evidence_refs, [{ thread_id: "oauth", message_id: "oauth-1" }]);
  assert.ok(!hit.excerpt.includes("Old decision"));
  const fallback = { ...entry("fallback", "Plain legacy body"), sections: [] };
  assert.equal(searchMemory([fallback], "legacy")[0]!.start_line, 1);
});

test("search bounds excerpt lines and deterministically orders equal-scoring sections", () => {
  const sources = [entry("z", "alpha"), entry("a", "alpha")];
  assert.deepEqual(searchMemory(sources, "alpha").map(hit => hit.entry.source_id), ["memory_a", "memory_z"]);
  const long = entry("long", Array.from({ length: 30 }, () => `alpha ${"word ".repeat(60)}`).join("\n"));
  const hit = searchMemory([long], "alpha")[0]!;
  assert.ok(hit.end_line - hit.start_line < 12);
  assert.equal(hit.end_line, hit.excerpt.split("\n").length);
});
