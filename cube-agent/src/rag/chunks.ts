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
      const limit = profile.maxInputBytes - Buffer.byteLength(profile.documentPrefix);
      // Keep a whole section when it fits. Repeat its heading/status only when splitting.
      const header = Buffer.byteLength(text) > limit ? text.match(/^## [^\n]+\nStatus: [^\n]+\n/)?.[0] ?? "" : "";
      const content = text.slice(header.length);
      const maxSize = limit - Buffer.byteLength(header);
      if (maxSize < 4) throw new Error("Memory section heading exceeds the embedding input limit");
      const chunks = await MDocument.fromText(content).chunk({ strategy: "recursive",
        // The final regex splits at code-point boundaries, never inside an emoji.
        separators: ["\n\n", "\n", " ", "(?<=[^\\uD800-\\uDBFF])"],
        isSeparatorRegex: true, separatorPosition: "end",
        maxSize, overlap: Math.min(128, Math.floor(maxSize / 10)),
        lengthFunction: value => Buffer.byteLength(value),
        addStartIndex: true, stripWhitespace: false });
      let previous = -1;
      for (const chunk of chunks) {
        const start: unknown = chunk.metadata.startIndex;
        if (typeof start !== "number" || !Number.isInteger(start) || start < 0 || start <= previous ||
          !chunk.text.length || Buffer.byteLength(chunk.text) > maxSize || content.slice(start, start + chunk.text.length) !== chunk.text)
          throw new Error("Native memory chunk offsets are invalid or ambiguous");
        previous = start;
        const sourceStart = header.length + start;
        const safeContent = masked.slice(offset + sourceStart, offset + sourceStart + chunk.text.length);
        if (!safeContent.trim()) continue;
        const safeText = masked.slice(offset, offset + header.length) + safeContent;
        const startLine = section.start_line + text.slice(0, sourceStart).split("\n").length - 1;
        const endLine = startLine + chunk.text.split("\n").length - 1;
        result.push({ id: memoryHash(`${entry.source_id}:${section.start_line}:${start}`),
          sourceId: entry.source_id, revision: entry.revision, sectionStart: section.start_line,
          startLine, endLine, text: safeText,
          inputHash: memoryHash(profile.documentPrefix + safeText) });
      }
    }
  }
  return result;
}
