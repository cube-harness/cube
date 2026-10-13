import type { MemoryEntry } from "@cube/workspace";

export type MemorySearchHit = {
  entry: MemoryEntry;
  score: number;
  section_start_line: number;
  start_line: number;
  end_line: number;
  excerpt: string;
  evidence_refs: MemoryEntry["sections"][number]["evidence_refs"];
};

const tokensOf = (text: string) =>
  text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** BM25 over committed memory sections. The caller owns project scope and output safety. */
export function searchMemory(entries: MemoryEntry[], query: string): MemorySearchHit[] {
  const terms = [...new Set(tokensOf(query))].slice(0, 24);
  if (!terms.length) return [];
  const documents = entries.flatMap(entry => {
    const lines = entry.body.split("\n");
    const sections = entry.sections.length ? entry.sections : [{
      start_line: 1, end_line: lines.length, evidence_refs: [],
    }];
    return sections.map(section => {
      const body = lines.slice(section.start_line - 1, section.end_line);
      const tokens = tokensOf(`${entry.title}\n${body.join("\n")}`);
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      return { entry, section, body, length: tokens.length, frequencies };
    }).filter(document => document.length > 0);
  });
  if (!documents.length) return [];
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
  // Lucene-style positive IDF; standard BM25 saturation/length defaults.
  // https://lucene.apache.org/core/9_12_3/core/org/apache/lucene/search/similarities/BM25Similarity.html
  const idf = new Map(terms.map(term => {
    const frequency = documents.filter(document => document.frequencies.has(term)).length;
    return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
  }));
  const k1 = 1.2, b = 0.75;
  // ponytail: scan the scoped corpus per query; persist a lexical index only if measured latency requires it.
  return documents.map(document => {
    const norm = k1 * (1 - b + b * document.length / averageLength);
    const score = terms.reduce((sum, term) => {
      const frequency = document.frequencies.get(term) ?? 0;
      return sum + idf.get(term)! * frequency * (k1 + 1) / (frequency + norm);
    }, 0);
    return { document, score };
  }).filter(hit => hit.score > 0).sort((a, b) =>
    b.score - a.score || a.document.entry.source_id.localeCompare(b.document.entry.source_id) ||
    a.document.section.start_line - b.document.section.start_line,
  ).map(({ document, score }) => {
    const match = document.body.findIndex(line => tokensOf(line).some(token => terms.includes(token)));
    const start = Math.max(0, match);
    const excerpt = document.body.slice(start, start + 12).join("\n");
    const start_line = document.section.start_line + start;
    return {
      entry: document.entry, score, start_line,
      section_start_line: document.section.start_line,
      end_line: start_line + excerpt.split("\n").length - 1,
      excerpt, evidence_refs: document.section.evidence_refs,
    };
  });
}
