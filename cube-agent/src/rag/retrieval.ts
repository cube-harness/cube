import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LibSQLVector } from "@mastra/libsql";
import { memoryHash, type MemoryStore, type IndexManifest, type createMemoryIndexStore } from "@cube/workspace";
import { redactMemoryText } from "../memory-evidence.js";
import { chunkMemory, type MemoryChunk } from "./chunks.js";
import { validateEmbeddings, type MemoryEmbedding } from "./embedding.js";
import { searchMemory, type MemorySearchHit } from "./search.js";

const BATCH_TIMEOUT = 30_000, QUERY_TIMEOUT = 5_000, CANDIDATES = 20, OVERFETCH = 100;
export type RetrievalSearch = { hits: MemorySearchHit[]; retrieval: "bm25" | "hybrid"; indexing: boolean; warning?: string };
const sectionId = (hit: MemorySearchHit) => `${hit.entry.source_id}:${hit.section_start_line}`;
export function fuseMemory(lexical: MemorySearchHit[], semantic: MemorySearchHit[]): MemorySearchHit[] {
  const merged = new Map<string, MemorySearchHit>();
  for (const branch of [lexical, semantic]) {
    const seen = new Set<string>();
    let rank = 0;
    for (const hit of branch) {
      const id = sectionId(hit);
      if (seen.has(id)) continue;
      seen.add(id);
      const score = 1 / (60 + ++rank);
      const old = merged.get(id);
      merged.set(id, { ...hit, score: score + (old?.score ?? 0) });
      if (rank === CANDIDATES) break;
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score ||
    a.entry.source_id.localeCompare(b.entry.source_id) || a.section_start_line - b.section_start_line);
}
const ownerAlive = (owner: NonNullable<IndexManifest["claim"]>) => {
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

export function createMemoryRetrieval(options: {
  store: MemoryStore;
  indexStore: ReturnType<typeof createMemoryIndexStore>;
  cacheDir: string;
  runtimeId: string;
  secrets: () => Promise<string[]>;
  resolveEmbedding: () => Promise<MemoryEmbedding | undefined>;
  notice: (message: string) => void;
  registerVector?: (vector: LibSQLVector) => void;
}) {
  let embedding: MemoryEmbedding | undefined;
  let generation: string | undefined;
  let vector: LibSQLVector | undefined;
  let initialized = false, stopped = false, requested = false;
  let pending: Promise<void> | undefined;
  let reloadPending: Promise<void> | undefined;
  let controller = new AbortController();
  let warning: string | undefined;
  let knownSecrets: string[] = [];
  const queries = new Set<Promise<RetrievalSearch>>();
  const reported = new Set<string>();
  const indexPrefix = `memory_${memoryHash(options.store.projectId).slice(0, 16)}_`;
  const report = async (error: unknown) => {
    knownSecrets = [...new Set([...knownSecrets, ...await options.secrets().catch(() => [])])];
    warning = redactMemoryText(error instanceof Error ? error.message : "Memory retrieval unavailable", knownSecrets).slice(0, 500);
    if (reported.has(warning)) return;
    if (reported.size === 32) reported.clear();
    reported.add(warning);
    try { options.notice(`Memory retrieval: ${warning}`); } catch { /* A notice cannot break chat/indexing. */ }
  };
  const getVector = () => {
    if (!vector) {
      vector = new LibSQLVector({ id: `memory-retrieval-${options.runtimeId}`,
        url: `file:${path.join(options.cacheDir, "vectors.sqlite")}` });
      options.registerVector?.(vector);
    }
    return vector;
  };
  const descriptor = (chunk: MemoryChunk, selected: string) => {
    const { text: _text, ...data } = chunk;
    return { ...data, vectorId: memoryHash(`${selected}:${chunk.sourceId}:${chunk.inputHash}`) };
  };
  async function select(signal: AbortSignal) {
    embedding = await options.resolveEmbedding();
    signal.throwIfAborted();
    generation = undefined;
    initialized = true;
    warning = undefined;
  }
  async function reconcile(signal: AbortSignal) {
    knownSecrets = await options.secrets();
    if (!initialized) await select(signal);
    const captured = embedding;
    if (!captured) return;
    const entries = await options.store.sources();
    signal.throwIfAborted();
    if (!entries.length && generation === undefined && !await options.indexStore.read()) return;
    const chunks = await chunkMemory(entries, options.store.projectId, captured.profile, knownSecrets);
    signal.throwIfAborted();
    const token = randomUUID();
    let deleted: string[] = [];
    const metadataUpdates = new Set<string>();
    const manifest = await options.indexStore.update(current => {
      // A normal trigger can never revive a profile superseded by another runtime.
      if (generation !== undefined && (current?.generation !== generation || current.profile !== captured.profile.id)) return null;
      if (!current || current.profile !== captured.profile.id) {
        const nextGeneration = randomUUID();
        current = { projectId: options.store.projectId, profile: captured.profile.id,
          generation: nextGeneration, indexName: indexPrefix + nextGeneration.replaceAll("-", ""),
          dimension: null, chunks: [], ready: [], claim: null };
      }
      generation = current.generation;
      if (current.claim && current.claim.runtimeId !== options.runtimeId && ownerAlive(current.claim)) return null;
      const desired = chunks.map(chunk => descriptor(chunk, current!.generation));
      const wanted = new Set(desired.map(chunk => chunk.vectorId));
      deleted = current.ready.filter(id => !wanted.has(id));
      const previous = new Map(current.chunks.map(chunk => [chunk.vectorId, chunk]));
      const published = new Set(current.ready);
      for (const chunk of desired) {
        const old = previous.get(chunk.vectorId);
        if (published.has(chunk.vectorId) && (old?.revision !== chunk.revision || old.startLine !== chunk.startLine || old.endLine !== chunk.endLine))
          metadataUpdates.add(chunk.vectorId);
      }
      return { ...current, chunks: desired, ready: current.ready.filter(id => wanted.has(id)),
        claim: { runtimeId: options.runtimeId, host: hostname(), pid: process.pid, token } };
    }, signal);
    if (!manifest) return;
    const selectedGeneration = manifest.generation;
    const owns = (current: IndexManifest | null) => current?.generation === selectedGeneration && current.profile === captured.profile.id && current.claim?.token === token;
    try {
      if (!chunks.length && manifest.dimension === null) return;
      const database = getVector();
      const unique = [...new Map(chunks.map(chunk => [descriptor(chunk, selectedGeneration).vectorId, chunk])).values()];
      const ready = new Set(manifest.ready);
      if (manifest.dimension !== null) {
        const stats = await database.describeIndex({ indexName: manifest.indexName });
        if (stats.dimension !== manifest.dimension) throw new Error("Memory retrieval vector index dimension is invalid");
        for (const id of deleted) {
          signal.throwIfAborted();
          if (!owns(await options.indexStore.read())) return;
          await database.deleteVector({ indexName: manifest.indexName, id });
        }
      }
      for (let offset = 0; offset < unique.length; offset += captured.batchSize) {
        signal.throwIfAborted();
        const batch = unique.slice(offset, offset + captured.batchSize).filter(chunk => !ready.has(descriptor(chunk, selectedGeneration).vectorId));
        if (!batch.length) continue;
        if (!owns(await options.indexStore.read())) return;
        const vectors = validateEmbeddings(await captured.embed(batch.map(chunk => chunk.text), "document",
          AbortSignal.any([signal, AbortSignal.timeout(BATCH_TIMEOUT)])), batch.length, manifest.dimension);
        signal.throwIfAborted();
        const batchSources = new Set(batch.map(chunk => chunk.sourceId));
        const fresh = await chunkMemory((await options.store.sources()).filter(entry => batchSources.has(entry.source_id)), options.store.projectId, captured.profile, await options.secrets());
        const valid = new Map(fresh.map(chunk => [chunk.id, chunk]));
        if (batch.some(chunk => valid.get(chunk.id)?.inputHash !== chunk.inputHash || valid.get(chunk.id)?.revision !== chunk.revision)) {
          return;
        }
        if (!owns(await options.indexStore.read())) return;
        if (manifest.dimension === null) {
          manifest.dimension = vectors[0]!.length;
          await database.createIndex({ indexName: manifest.indexName, dimension: manifest.dimension, metric: "cosine" });
        }
        const ids = batch.map(chunk => descriptor(chunk, selectedGeneration).vectorId);
        await database.upsert({ indexName: manifest.indexName, ids, vectors,
          metadata: batch.map(chunk => ({ projectId: manifest.projectId, generation: selectedGeneration,
            sourceId: chunk.sourceId, inputHash: chunk.inputHash, revision: chunk.revision,
            startLine: chunk.startLine, endLine: chunk.endLine })) });
        // Vector write and ready publication are intentionally not one transaction.
        const published = await options.indexStore.update(current => !signal.aborted && owns(current) ? {
          ...current!, dimension: manifest.dimension, ready: [...new Set([...current!.ready, ...ids])],
        } : null, signal);
        if (!published) return;
        ids.forEach(id => ready.add(id));
      }
      if (manifest.dimension !== null) {
        const refs = new Map(manifest.chunks.map(chunk => [chunk.vectorId, chunk]));
        for (const id of metadataUpdates) {
          const chunk = refs.get(id);
          if (chunk) await database.updateVector({ indexName: manifest.indexName, id,
            update: { metadata: { projectId: manifest.projectId, generation: selectedGeneration,
              sourceId: chunk.sourceId, inputHash: chunk.inputHash, revision: chunk.revision,
              startLine: chunk.startLine, endLine: chunk.endLine } } });
        }
        // Native rows outside ready mappings are harmless, but retire old generations.
        for (const name of await database.listIndexes()) {
          signal.throwIfAborted();
          if (!owns(await options.indexStore.read())) return;
          if (name.startsWith(indexPrefix) && name !== manifest.indexName) await database.deleteIndex({ indexName: name });
        }
      }
      warning = undefined;
    } finally {
      await options.indexStore.update(current => owns(current) ? { ...current!, claim: null } : null)
        .catch(report);
    }
  }
  function check() {
    if (stopped || reloadPending) return;
    requested = true;
    if (pending) return;
    const signal = controller.signal;
    pending = (async () => {
      for (let pass = 0; pass < 2 && requested && !signal.aborted; pass++) {
        requested = false;
        try { await reconcile(signal); }
        catch (error) { if (!signal.aborted) await report(error); requested = false; break; }
      }
    })().finally(() => { pending = undefined; requested = false; });
  }
  async function search(query: string): Promise<RetrievalSearch> {
    const lexical = async (): Promise<RetrievalSearch> => ({ hits: searchMemory(await options.store.sources(), query),
      retrieval: "bm25", indexing: !!pending || !!reloadPending, ...(warning ? { warning } : {}) });
    const captured = embedding, selectedGeneration = generation, signal = controller.signal;
    if (!initialized || !captured || !selectedGeneration || stopped || reloadPending) return lexical();
    try {
      const manifest = await options.indexStore.read();
      if (!manifest || manifest.generation !== selectedGeneration || manifest.profile !== captured.profile.id || manifest.dimension === null || !manifest.ready.length) return lexical();
      const entries = await options.store.sources();
      const chunks = await chunkMemory(entries, options.store.projectId, captured.profile, await options.secrets());
      const desired = new Map(manifest.chunks.map(chunk => [chunk.id, chunk]));
      const ready = new Set(manifest.ready);
      const eligible = chunks.filter(chunk => {
        const saved = desired.get(chunk.id);
        return saved?.inputHash === chunk.inputHash && saved.revision === chunk.revision && ready.has(saved.vectorId);
      });
      if (!eligible.length) return lexical();
      const vectors = validateEmbeddings(await captured.embed([redactMemoryText(query, await options.secrets())], "query",
        AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT)])), 1, manifest.dimension);
      const rows = await getVector().query({ indexName: manifest.indexName, queryVector: vectors[0], topK: OVERFETCH });
      signal.throwIfAborted();
      const current = await options.indexStore.read();
      if (current?.generation !== selectedGeneration || current.profile !== captured.profile.id) return lexical();
      const fresh = await options.store.sources();
      const freshChunks = await chunkMemory(fresh, options.store.projectId, captured.profile, await options.secrets());
      const valid = new Map(freshChunks.map(chunk => [chunk.id, chunk]));
      const bySource = new Map(fresh.map(entry => [entry.source_id, entry]));
      const semantic: MemorySearchHit[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        if (!current.ready.includes(row.id) || row.metadata?.projectId !== options.store.projectId || row.metadata?.generation !== selectedGeneration) continue;
        for (const candidate of current.chunks.filter(chunk => chunk.vectorId === row.id)) {
          const chunk = valid.get(candidate.id);
          const entry = bySource.get(candidate.sourceId);
          if (!chunk || !entry || chunk.inputHash !== candidate.inputHash || chunk.revision !== candidate.revision || row.metadata?.inputHash !== chunk.inputHash || row.metadata?.sourceId !== entry.source_id) continue;
          const section = entry.sections.find(item => item.start_line === chunk.sectionStart);
          const key = `${entry.source_id}:${chunk.sectionStart}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const body = entry.body.split("\n");
          const end = Math.min(chunk.startLine + 11, section?.end_line ?? body.length);
          semantic.push({ entry, score: row.score, section_start_line: chunk.sectionStart,
            start_line: chunk.startLine, end_line: end,
            excerpt: body.slice(chunk.startLine - 1, end).join("\n"), evidence_refs: section?.evidence_refs ?? [] });
          if (semantic.length === CANDIDATES) break;
        }
        if (semantic.length === CANDIDATES) break;
      }
      if (!semantic.length) return lexical();
      return { hits: fuseMemory(searchMemory(fresh, query).slice(0, CANDIDATES), semantic),
        retrieval: "hybrid", indexing: !!pending, ...(warning ? { warning } : {}) };
    } catch (error) { if (!signal.aborted) await report(error); return lexical(); }
  }
  return {
    check,
    search(query: string) {
      const operation = search(query);
      queries.add(operation);
      void operation.finally(() => queries.delete(operation)).catch(() => undefined);
      return operation;
    },
    reload(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (reloadPending) return reloadPending;
      controller.abort(); requested = false;
      reloadPending = (async () => {
        await Promise.allSettled([pending, ...queries]);
        if (stopped) return;
        controller = new AbortController();
        initialized = false; embedding = undefined; generation = undefined;
        reported.clear();
      })().finally(() => { reloadPending = undefined; if (!stopped) check(); });
      return reloadPending;
    },
    cancel() { stopped = true; requested = false; controller.abort(); },
    async drain() { await Promise.allSettled([reloadPending, pending, ...queries]); },
    async close() { stopped = true; controller.abort(); await Promise.allSettled([reloadPending, pending, ...queries]); await vector?.close(); },
  };
}
export type MemoryRetrieval = ReturnType<typeof createMemoryRetrieval>;
