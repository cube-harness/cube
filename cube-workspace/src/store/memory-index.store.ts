import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { HomeManager } from "../home-manager.js";
import { MEMORY_RETRIEVAL_LIMITS } from "../constants.js";
import { memoryHash } from "./memory.store.js";
import { atomicWriteFile, withFileLock } from "./atomic-write.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chunk = z.object({
  id: hash, vectorId: hash, inputHash: hash,
  sourceId: z.string().min(1).max(100), revision: z.string().min(1).max(256),
  sectionStart: z.number().int().positive(), startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).strict().refine(value => value.sectionStart <= value.startLine && value.startLine <= value.endLine);
const manifestSchema = z.object({
  projectId: z.string().min(1), profile: hash, generation: z.string().uuid(),
  indexName: z.string().regex(/^memory_[a-f0-9_]+$/),
  dimension: z.number().int().positive().max(MEMORY_RETRIEVAL_LIMITS.max_dimensions).nullable(),
  chunks: z.array(chunk), ready: z.array(hash),
  claim: z.object({ runtimeId: z.string().min(1), host: z.string().min(1),
    pid: z.number().int().positive(), token: z.string().uuid() }).strict().nullable(),
}).strict().refine(value => new Set(value.chunks.map(item => item.id)).size === value.chunks.length &&
  new Set(value.ready).size === value.ready.length && (value.dimension !== null || value.ready.length === 0));
export type IndexManifest = z.infer<typeof manifestSchema>;
export type IndexChunk = z.infer<typeof chunk>;

/** Derived cache only. Never repairs or overwrites an invalid manifest. */
export function createMemoryIndexStore(home: HomeManager, projectId: string) {
  const directory = path.join(home.getMemoryRetrievalDir(), "projects");
  const file = path.join(directory, `${memoryHash(projectId)}.json`);
  async function read(): Promise<IndexManifest | null> {
    try {
      if ((await stat(file)).size > MEMORY_RETRIEVAL_LIMITS.manifest_bytes) throw new Error("Memory retrieval manifest exceeds 16 MiB");
      const text = await readFile(file, "utf8");
      if (Buffer.byteLength(text) > MEMORY_RETRIEVAL_LIMITS.manifest_bytes) throw new Error("Memory retrieval manifest exceeds 16 MiB");
      const value = manifestSchema.parse(JSON.parse(text));
      if (value.projectId !== projectId) throw new Error("Memory retrieval manifest belongs to another project");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Memory retrieval cache is invalid or unavailable; inspect its project manifest.", { cause: error });
    }
  }
  return {
    read,
    async update(change: (current: IndexManifest | null) => IndexManifest | null, signal?: AbortSignal) {
      await mkdir(directory, { recursive: true });
      return withFileLock(file, async () => {
        const next = change(await read());
        if (next === null) return null;
        const value = manifestSchema.parse(next);
        if (value.projectId !== projectId) throw new Error("Cannot publish another project's memory retrieval cache");
        const text = JSON.stringify(value);
        if (Buffer.byteLength(text) > MEMORY_RETRIEVAL_LIMITS.manifest_bytes) throw new Error("Memory retrieval manifest exceeds 16 MiB");
        await atomicWriteFile(file, text, { mode: 0o600 });
        return value;
      }, { signal });
    },
  };
}
