import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { HomeManager } from "../home-manager.js";
import { atomicWriteFile, withFileLock } from "./atomic-write.js";

export const MEMORY_FILES = { handbook: "MEMORY.md", raw: "raw_memories.md", index: "memory_summary.md" } as const;
export const MEMORY_LIMITS = { file: 8 * 1024 * 1024, rollout: 512 * 1024, journal: 32 * 1024 * 1024, entry: 32 * 1024, snapshot: 8000 } as const;
export const memoryHash = (text: string) => createHash("sha256").update(text).digest("hex");
export const normalizeProjectId = (root: string) => {
  const normalized = path.resolve(root).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const sourceId = z.string().regex(/^(?:memory|rollout|raw|index)_[a-zA-Z0-9-]+$/);
export const EvidenceRefSchema = z.object({ thread_id: z.string().min(1).max(160), message_id: z.string().min(1).max(160) }).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export const MemoryStatusSchema = z.enum(["verified", "user_stated", "proposed", "unresolved"]);
export const MemorySectionSchema = z.object({ start_line: z.number().int().positive(), end_line: z.number().int().positive(), evidence_refs: z.array(EvidenceRefSchema).max(1000) }).strict();
export const MemoryEntrySchema = z.object({
  source_id: sourceId,
  source_type: z.enum(["handbook", "rollout", "raw", "index"]),
  project_id: z.string().min(1),
  title: z.string().min(1).max(240),
  status: MemoryStatusSchema,
  updated_at: z.string().datetime(),
  revision: z.string().min(1).max(100),
  thread_id: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).optional(),
  boundary: z.object({ ids: z.array(z.string()).max(10000), fingerprint: z.string().length(64) }).strict().optional(),
  incorporated: z.record(z.string(), z.string()).default({}),
  sections: z.array(MemorySectionSchema).max(100),
  body: z.string().max(MEMORY_LIMITS.entry),
}).strict().superRefine((entry, ctx) => {
  const lines = entry.body.split("\n").length;
  const prefix = entry.source_type === "handbook" ? "memory" : entry.source_type;
  if (!entry.source_id.startsWith(`${prefix}_`)) ctx.addIssue({ code: "custom", message: "Memory source ID/type mismatch" });
  if (Buffer.byteLength(entry.body) > MEMORY_LIMITS.entry || entry.sections.some(s => s.end_line < s.start_line || s.end_line > lines))
    ctx.addIssue({ code: "custom", message: "Invalid memory body or evidence line range" });
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type MemorySnapshot = { text: string; revision: string } | null;
export type MemoryState = { entries: MemoryEntry[]; revision: string };
const begin = "<!-- cube-memory ";
const end = "<!-- /cube-memory -->";
const escapeBody = (text: string) => text.replace(/<!--\s*\/?cube-memory/g, match => match.replace("<", "&lt;"));

export function renderMemory(entries: MemoryEntry[]): string {
  return entries.map(value => {
    const { body, ...header } = MemoryEntrySchema.parse(value);
    const json = JSON.stringify(header).replace(/[-<>]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return `${begin}${json} -->\n${escapeBody(body)}\n${end}\n`;
  }).join("\n");
}

export function parseMemory(text: string): MemoryEntry[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const entries: MemoryEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const line = lines[index];
    if (!line.startsWith(begin) || !line.endsWith(" -->")) throw new Error("Malformed memory entry header");
    const header = JSON.parse(line.slice(begin.length, -4));
    const body: string[] = [];
    while (++index < lines.length && lines[index] !== end) body.push(lines[index]);
    if (index === lines.length) throw new Error("Unterminated memory entry");
    const entry = MemoryEntrySchema.parse({ ...header, body: body.join("\n") });
    if (entries.some(e => e.source_id === entry.source_id)) throw new Error("Duplicate memory source ID");
    entries.push(entry);
  }
  return entries;
}

const fixedFiles = new Set<string>(Object.values(MEMORY_FILES));
const validFile = (file: string) => fixedFiles.has(file) || /^rollout_summaries\/[a-zA-Z0-9_-]{1,160}\.md$/.test(file);
const fileKind = (file: string) => file === MEMORY_FILES.handbook ? "handbook" : file === MEMORY_FILES.raw ? "raw" : file === MEMORY_FILES.index ? "index" : "rollout";
const journalSchema = z.array(z.object({ file: z.string().refine(validFile), before: z.string().length(64).nullable(), after: z.string().length(64), text: z.string() }).strict()).max(5);
const ownerSchema = z.object({ runtime: z.string(), host: z.string(), pid: z.number().int().positive(), kind: z.enum(["foreground", "worker"]), token: z.string().optional() }).strict();
type Owner = z.infer<typeof ownerSchema>;
const ownersSchema = z.array(ownerSchema).max(100);
const isAlive = (owner: Owner) => {
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const revision = (entries: MemoryEntry[]) => memoryHash(JSON.stringify(entries.sort((a, b) => a.source_id.localeCompare(b.source_id))));

export function createMemoryStore(home: HomeManager, projectRoot: string) {
  const root = path.resolve(home.getMemoryDir());
  const projectId = normalizeProjectId(projectRoot);
  const mutex = path.join(root, MEMORY_FILES.handbook);
  const journal = "memory-publish.tmp";
  const target = (file: string) => path.join(root, file);

  async function safePath(file: string) {
    const absolute = target(file);
    if (!absolute.startsWith(root + path.sep)) throw new Error("Memory path is outside its store");
    for (const directory of [root, ...(file.includes("/") ? [path.dirname(absolute)] : [])]) {
      try {
        if ((await lstat(directory)).isSymbolicLink()) throw new Error("Memory symlinks are not permitted");
        if (path.resolve(await realpath(directory)) !== path.resolve(directory)) throw new Error("Memory path escapes its store");
      } catch (error) { if (!missing(error)) throw error; }
    }
    try { if ((await lstat(absolute)).isSymbolicLink()) throw new Error("Memory symlinks are not permitted"); }
    catch (error) { if (!missing(error)) throw error; }
    return absolute;
  }

  async function bytes(file: string, cap = MEMORY_LIMITS.file): Promise<string | null> {
    const absolute = await safePath(file);
    try {
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > cap) throw new Error("Memory file exceeds its safety limit or is not regular");
      return await readFile(absolute, "utf8");
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  async function recover() {
    const text = await bytes(journal, MEMORY_LIMITS.journal);
    if (text === null) return;
    const records = journalSchema.parse(JSON.parse(text));
    if (new Set(records.map(r => r.file)).size !== records.length) throw new Error("Duplicate publication target");
    for (const record of records) {
      if (Buffer.byteLength(record.text) > (record.file.startsWith("rollout") ? MEMORY_LIMITS.rollout : MEMORY_LIMITS.file) || memoryHash(record.text) !== record.after)
        throw new Error("Invalid memory publication contents");
      if (parseMemory(record.text).some(entry => entry.source_type !== fileKind(record.file))) throw new Error("Memory source/file kind mismatch");
      const current = await bytes(record.file);
      const hash = current === null ? null : memoryHash(current);
      if (hash !== record.before && hash !== record.after) throw new Error("Memory recovery revision conflict");
    }
    for (const record of records) {
      const absolute = await safePath(record.file);
      await mkdir(path.dirname(absolute), { recursive: true });
      await atomicWriteFile(absolute, record.text, { mode: 0o600 });
    }
    await unlink(target(journal));
  }

  async function coordinated<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await safePath(MEMORY_FILES.handbook);
    await mkdir(root, { recursive: true });
    return withFileLock(mutex, async () => { await recover(); return operation(); }, { signal });
  }

  async function files(includeRollouts = true): Promise<Map<string, MemoryEntry[]>> {
    const names: string[] = [...fixedFiles];
    if (includeRollouts) {
      await safePath("rollout_summaries/placeholder.md");
      let listed: string[] = [];
      try { listed = await readdir(target("rollout_summaries")); }
      catch (error) { if (!missing(error)) throw error; }
      if (listed.length > 1000) throw new Error("Too many rollout files; memory requires maintenance");
      names.push(...listed.filter(name => /^[a-zA-Z0-9_-]{1,160}\.md$/.test(name)).map(name => `rollout_summaries/${name}`));
    }
    const result = new Map<string, MemoryEntry[]>();
    for (const file of names) {
      const text = await bytes(file, file.startsWith("rollout") ? MEMORY_LIMITS.rollout : MEMORY_LIMITS.file);
      const parsed = text === null ? [] : parseMemory(text);
      if (parsed.some(entry => entry.source_type !== fileKind(file))) throw new Error("Memory source/file kind mismatch");
      result.set(file, parsed);
    }
    return result;
  }

  async function readState(): Promise<MemoryState> {
    const entries = [...(await files()).values()].flat().filter(entry => entry.project_id === projectId);
    if (new Set(entries.map(entry => entry.source_id)).size !== entries.length) throw new Error("Duplicate project memory source ID");
    return { entries, revision: revision(entries) };
  }

  const ownerFile = (threadId: string) => `.thread-${memoryHash(threadId)}.tmp`;
  async function readOwners(threadId: string) {
    const text = await bytes(ownerFile(threadId), 32768);
    return (text === null ? [] : ownersSchema.parse(JSON.parse(text))).filter(isAlive);
  }
  async function writeOwners(threadId: string, owners: Owner[]) {
    const file = ownerFile(threadId);
    if (owners.length) await atomicWriteFile(await safePath(file), JSON.stringify(ownersSchema.parse(owners)), { mode: 0o600 });
    else await unlink(target(file)).catch(error => { if (!missing(error)) throw error; });
  }

  return {
    projectId,
    read: () => coordinated(readState),
    snapshot: (): Promise<MemorySnapshot> => coordinated(async () => {
      const all = [...(await files(false)).values()].flat().filter(e => e.project_id === projectId);
      const index = all.find(e => e.source_type === "index");
      if (!index) return null;
      if (Array.from(index.body).length > MEMORY_LIMITS.snapshot) throw new Error("Memory index exceeds snapshot limit");
      return { text: index.body, revision: index.revision };
    }),
    sources: (): Promise<MemoryEntry[]> => coordinated(async () => (await readState()).entries.filter(e => e.source_type === "handbook" || e.source_type === "rollout")),
    source: (id: string): Promise<MemoryEntry | null> => coordinated(async () => {
      sourceId.parse(id);
      return (await readState()).entries.find(e => e.source_id === id && (e.source_type === "handbook" || e.source_type === "rollout")) ?? null;
    }),
    publish: (change: { revision: string; replacements: Record<string, MemoryEntry[]>; claim?: { threadId: string; token: string } }, signal: AbortSignal) => coordinated(async () => {
      signal.throwIfAborted();
      const all = await files();
      const scoped = [...all.values()].flat().filter(e => e.project_id === projectId);
      if (revision(scoped) !== change.revision) throw new Error("Memory publication is stale; retry at a later check");
      if (change.claim && !(await readOwners(change.claim.threadId)).some(o => o.kind === "worker" && o.token === change.claim!.token)) throw new Error("Memory source claim is stale");
      const records = [];
      for (const [file, incoming] of Object.entries(change.replacements)) {
        if (!validFile(file) || incoming.some(e => e.project_id !== projectId || e.source_type !== fileKind(file))) throw new Error("Invalid memory publication scope");
        const existing = all.get(file) ?? [];
        if (file.startsWith("rollout") && existing.some(e => e.project_id !== projectId)) throw new Error("Rollout belongs to another project");
        const next = [...existing.filter(e => e.project_id !== projectId), ...incoming];
        const text = renderMemory(next);
        parseMemory(text);
        if (Buffer.byteLength(text) > (file.startsWith("rollout") ? MEMORY_LIMITS.rollout : MEMORY_LIMITS.file)) throw new Error("Memory publication exceeds disk limit");
        const previous = await bytes(file);
        records.push({ file, before: previous === null ? null : memoryHash(previous), after: memoryHash(text), text });
      }
      const prepared = JSON.stringify(journalSchema.parse(records));
      if (Buffer.byteLength(prepared) > MEMORY_LIMITS.journal) throw new Error("Memory publication exceeds journal limit");
      signal.throwIfAborted();
      await atomicWriteFile(await safePath(journal), prepared, { mode: 0o600 });
      await recover();
    }, signal),
    registerThread: (threadId: string, runtimeId: string) => coordinated(async () => {
      const owners = (await readOwners(threadId)).filter(o => o.kind === "foreground" && o.runtime !== runtimeId);
      await writeOwners(threadId, [...owners, { runtime: runtimeId, host: hostname(), pid: process.pid, kind: "foreground" }]);
    }),
    releaseThread: (threadId: string, runtimeId: string) => coordinated(async () => writeOwners(threadId, (await readOwners(threadId)).filter(o => o.runtime !== runtimeId))),
    claimThread: (threadId: string, runtimeId: string): Promise<string | null> => coordinated(async () => {
      if ((await readOwners(threadId)).length) return null;
      const token = randomUUID();
      await writeOwners(threadId, [{ runtime: runtimeId, host: hostname(), pid: process.pid, kind: "worker", token }]);
      return token;
    }),
    checkClaim: (threadId: string, token: string) => coordinated(async () => (await readOwners(threadId)).some(o => o.kind === "worker" && o.token === token)),
    releaseClaim: (threadId: string, token: string) => coordinated(async () => writeOwners(threadId, (await readOwners(threadId)).filter(o => o.token !== token))),
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
