import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import type { MemoryStorage } from "@mastra/core/storage";
import { z } from "zod";
import type { EvidenceRef, MemoryStore } from "@cube/workspace";
import { readSourceEvidence, redactMemoryText } from "../memory-evidence.js";
import { MEMORY_RECALL_PROMPT } from "../prompts/memory-recall.prompt.js";

const querySchema = z.object({ query: z.string().trim().min(1).max(512) }).strict();
const readSchema = z.object({
  source_id: z.string().min(1).max(100),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  cursor: z.string().max(2048).optional(),
}).strict();
const cursorSchema = z.object({
  project: z.string(), source: z.string(), revision: z.string(),
  start: z.number().int().positive(), end: z.number().int().positive(),
  line: z.number().int().positive(), evidence: z.number().int().nonnegative(),
}).strict();
const cap = 32 * 1024;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const termsOf = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? [])].slice(0, 24);

export function createMemoryRecall(options: {
  store: MemoryStore;
  storage: () => Promise<MemoryStorage>;
  secrets: () => Promise<string[]>;
}) {
  const key = randomBytes(32);
  const sign = (text: string) => createHmac("sha256", key).update(text).digest();
  const encode = (cursor: z.infer<typeof cursorSchema>) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const token = `${payload}.${sign(payload).toString("base64url")}`;
    if (token.length > 2048) throw new Error("Memory continuation exceeds its safety limit");
    return token;
  };
  const decode = (token: string) => {
    const [payload, signature, extra] = token.split(".");
    const actual = Buffer.from(signature ?? "", "base64url");
    const expected = sign(payload ?? "");
    if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error("Invalid memory continuation");
    return cursorSchema.parse(JSON.parse(Buffer.from(payload!, "base64url").toString()));
  };

  async function recall(input: z.infer<typeof querySchema> | z.infer<typeof readSchema>) {
    if ("query" in input) {
      const terms = termsOf(input.query);
      const entries = await options.store.sources();
      const ranked = entries.map(entry => {
        const title = entry.title.toLowerCase(), body = entry.body.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (body.includes(term) ? 1 : 0), 0);
        return { entry, score };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.entry.source_id.localeCompare(b.entry.source_id)).slice(0, 5);
      const secrets = await options.secrets();
      const result = { mode: "query", lexical: true, results: ranked.map(({ entry, score }) => {
        const lines = entry.body.split("\n");
        const match = lines.findIndex(line => terms.some(term => line.toLowerCase().includes(term)));
        const start = Math.max(0, match);
        return { source_id: entry.source_id, title: redactMemoryText(entry.title, secrets), status: entry.status,
          score, start_line: start + 1, end_line: Math.min(lines.length, start + 12),
          excerpt: redactMemoryText(lines.slice(start, start + 12).join("\n"), secrets).slice(0, 1200),
          evidence_refs: entry.sections.flatMap(section => section.evidence_refs).slice(0, 4) };
      }) };
      while (size(result) > cap) result.results.pop();
      return result;
    }

    const entry = await options.store.source(input.source_id);
    if (!entry) throw new Error("Memory source is unavailable in this project");
    const lines = entry.body.split("\n");
    const cursor = input.cursor ? decode(input.cursor) : {
      project: options.store.projectId, source: entry.source_id, revision: entry.revision,
      start: input.start_line ?? 1, end: input.end_line ?? lines.length,
      line: input.start_line ?? 1, evidence: 0,
    };
    if (cursor.project !== options.store.projectId || cursor.source !== entry.source_id || cursor.revision !== entry.revision)
      throw new Error("Memory continuation is stale or belongs to another source");
    if (cursor.start > cursor.end || cursor.end > lines.length || cursor.line > cursor.end + 1 ||
        (input.start_line !== undefined && input.start_line !== cursor.start) ||
        (input.end_line !== undefined && input.end_line !== cursor.end)) throw new Error("Invalid memory line range");
    const refs: EvidenceRef[] = [...new Map(entry.sections
      .filter(section => section.end_line >= cursor.start && section.start_line <= cursor.end)
      .flatMap(section => section.evidence_refs)
      .map(ref => [JSON.stringify(ref), ref])).values()];
    if (cursor.evidence > refs.length) throw new Error("Invalid memory evidence continuation");
    const secrets = await options.secrets();
    const result = { mode: "read", source_id: entry.source_id, revision: entry.revision, status: entry.status,
      lines: [] as { line: number; text: string }[], evidence: [] as Awaited<ReturnType<typeof readSourceEvidence>>,
      truncated: false, next_read: undefined as { source_id: string; cursor: string } | undefined };
    const fits = () => size(result) <= cap - 2048;
    const last = Math.min(cursor.end, cursor.line + 119);
    while (cursor.line <= last) {
      result.lines.push({ line: cursor.line, text: redactMemoryText(lines[cursor.line - 1]!, secrets) });
      if (!fits()) { result.lines.pop(); break; }
      cursor.line++;
    }
    const originals = await readSourceEvidence(await options.storage(), options.store.projectId, refs.slice(cursor.evidence, cursor.evidence + 8), secrets);
    for (const original of originals) {
      result.evidence.push(original);
      if (!fits()) { result.evidence.pop(); break; }
      cursor.evidence++;
    }
    result.truncated = cursor.line <= cursor.end || cursor.evidence < refs.length;
    if (!result.lines.length && !result.evidence.length && result.truncated)
      throw new Error("A single memory line or original message exceeds the recall page limit");
    if (result.truncated) result.next_read = { source_id: entry.source_id, cursor: encode(cursor) };
    if (size(result) > cap) throw new Error("Memory recall exceeds its response limit");
    return result;
  }

  const tool = createTool({
    id: "memory_recall", description: MEMORY_RECALL_PROMPT,
    inputSchema: z.union([querySchema, readSchema]),
    execute: async input => {
      try { return await recall(input); }
      catch (error) { return { isError: true, error: redactMemoryText(error instanceof Error ? error.message : "Memory recall failed").slice(0, 500) }; }
    },
  });
  return { tool, recall };
}
