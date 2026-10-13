import { MDocument } from "@mastra/rag";
import { memoryHash, type MemoryEntry } from "@cube/workspace";
import { redactMemoryText } from "../memory-evidence.js";
import type { EmbeddingProfile } from "./embedding.js";

export type MemoryChunk = {
  id: string; sourceId: string; revision: string; sectionStart: number;
  startLine: number; endLine: number; inputHash: string; text: string;
};
export async function chunkMemory(entries: MemoryEntry[], projectId: string, profile: EmbeddingProfile, secrets: string[]): Promise<MemoryChunk[]> {
  const result: MemoryChunk[] = [];
  for (const entry of entries.filter(item => item.project_id === projectId && ["handbook", "rollout"].includes(item.source_type))) {
    const lines = entry.body.split("\n");
    const masked = redactMemoryText(entry.body, secrets, { preserveOffsets: true });
    const sections = entry.sections.length ? entry.sections : [{ start_line: 1, end_line: lines.length }];
    for (const section of sections) {
      const offset = lines.slice(0, section.start_line - 1).reduce((sum, line) => sum + line.length + 1, 0);
      const text = lines.slice(section.start_line - 1, section.end_line).join("\n");
      const chunks = await MDocument.fromText(text).chunk({ strategy: "recursive",
        separators: ["\n\n", "\n", " ", ""], separatorPosition: "end",
        maxSize: profile.config.chunk.max_chars, overlap: profile.config.chunk.overlap_chars,
        addStartIndex: true, stripWhitespace: false });
      let previous = -1;
      for (const chunk of chunks) {
        const start: unknown = chunk.metadata.startIndex;
        if (typeof start !== "number" || !Number.isInteger(start) || start < 0 || start <= previous ||
          !chunk.text.length || chunk.text.length > profile.config.chunk.max_chars || text.slice(start, start + chunk.text.length) !== chunk.text)
          throw new Error("Native memory chunk offsets are invalid or ambiguous");
        previous = start;
        const safeText = masked.slice(offset + start, offset + start + chunk.text.length);
        if (!safeText.trim()) continue;
        const startLine = section.start_line + text.slice(0, start).split("\n").length - 1;
        const endLine = startLine + chunk.text.split("\n").length - 1;
        result.push({ id: memoryHash(`${entry.source_id}:${section.start_line}:${start}`),
          sourceId: entry.source_id, revision: entry.revision, sectionStart: section.start_line,
          startLine, endLine, text: safeText,
          inputHash: memoryHash(profile.config.document_prefix + safeText) });
      }
    }
  }
  return result;
}
