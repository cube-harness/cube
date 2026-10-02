import { randomUUID } from "node:crypto";
import type { MemoryStorage } from "@mastra/core/storage";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { IMastraLogger } from "@mastra/core/logger";
import { z } from "zod";
import { MEMORY_FILES, MEMORY_LIMITS, MemoryStatusSchema, memoryHash, type CubeConfig, type EvidenceRef, type MemoryEntry, type MemoryStore } from "@cube/workspace";
import { createMemoryAgent } from "./agents/memory.agent.js";
import { estimateTokens, type ContextLimits } from "./context.js";
import { captureSourceTurns, readSourceEvidence, redactMemoryText, type ProjectedEvidence } from "./memory-evidence.js";
import { MEMORY_EXTRACT_PROMPT } from "./prompts/memory-extract.prompt.js";
import { MEMORY_CONSOLIDATE_PROMPT } from "./prompts/memory-consolidate.prompt.js";

const section = z.object({ title: z.string().min(1).max(240), text: z.string().min(1).max(6000), status: MemoryStatusSchema, evidence: z.array(z.number().int().nonnegative()).min(1).max(40) }).strict();
const extraction = z.object({ rollout: z.object({ title: z.string().min(1).max(240), sections: z.array(section).min(1).max(32) }).strict(), candidates: z.array(section).max(32) }).strict();
const consolidation = z.object({ entries: z.array(z.object({ existing: z.number().int().nonnegative().nullable(), title: z.string().min(1).max(240), sections: z.array(section).min(1).max(32) }).strict()).max(64), index: z.array(z.object({ entry: z.number().int().nonnegative(), text: z.string().min(1).max(500) }).strict()).max(64) }).strict();
type Section = z.infer<typeof section>;
type Generation = { text: string; finishReason?: string; toolCalls?: unknown[] };
export function memoryWriterBudget(limits: ContextLimits) {
  const c = limits.context, o = limits.output;
  if (!c || !o || !Number.isFinite(c) || !Number.isFinite(o)) throw new Error("Memory writer has no known context/output limits");
  const output = Math.min(o, 8192, Math.floor(c * 0.05));
  const input = Math.min(32768, Math.floor(c * 0.25), c - output - 1024, limits.input ?? Infinity);
  if (input < 2048 || output < 512) throw new Error("Memory writer has insufficient context/output capacity");
  return { input, output };
}

const refsOf = (entries: MemoryEntry[]) => [...new Map(entries.flatMap(e => e.sections.flatMap(s => s.evidence_refs)).map(ref => [`${ref.thread_id}:${ref.message_id}`, ref])).values()];
const evidenceRef = (m: ProjectedEvidence): EvidenceRef => ({ thread_id: m.thread_id, message_id: m.message_id });

export function makeMemoryEntry(projectId: string, sourceId: string, kind: MemoryEntry["source_type"], title: string, sections: Section[], evidence: EvidenceRef[], secrets: readonly string[] = []): MemoryEntry {
  const lines = [`# ${redactMemoryText(title, secrets)}`, ""];
  const ranges: MemoryEntry["sections"] = [];
  for (const item of sections) {
    const start = lines.length + 1;
    lines.push(`## ${redactMemoryText(item.title, secrets)}`, `Status: ${item.status}`, ...redactMemoryText(item.text, secrets).split("\n"), "");
    const refs = item.evidence.map(slot => {
      const ref = evidence[slot];
      if (!ref) throw new Error("Generated memory references unknown evidence");
      return ref;
    });
    ranges.push({ start_line: start, end_line: lines.length, evidence_refs: [...new Map(refs.map(ref => [JSON.stringify(ref), ref])).values()] });
  }
  const status = sections.some(s => s.status === "unresolved") ? "unresolved" : sections.some(s => s.status === "proposed") ? "proposed" : sections.some(s => s.status === "user_stated") ? "user_stated" : "verified";
  return { source_id: sourceId, source_type: kind, project_id: projectId, title: redactMemoryText(title, secrets), body: lines.join("\n"), sections: ranges, status,
    revision: randomUUID(), updated_at: new Date().toISOString(), incorporated: {} };
}

export function createDurableMemory(options: {
  store: MemoryStore; storage: () => Promise<MemoryStorage>; projectRoot: string;
  config: CubeConfig["memory"]["durable"]; runtimeId: string; logger?: IMastraLogger;
  resolveWriter: () => Promise<{ model: MastraModelConfig; limits: ContextLimits }>;
  secrets: () => Promise<string[]>;
  notice: (notice: { stage: string; threadId?: string; message: string }) => void;
}) {
  let pending: Promise<void> | undefined;
  let requested = false;
  let stopped = false;
  const controller = new AbortController();
  const signal = controller.signal;
  let knownSecrets: string[] = [];
  const reported = new Set<string>();
  function report(stage: string, error: unknown, threadId?: string) {
    if (signal.aborted) return;
    const message = redactMemoryText(error instanceof Error ? error.message : "Memory operation failed", knownSecrets).slice(0, 500);
    const identity = `${stage}:${message}`;
    if (reported.has(identity)) return;
    reported.add(identity);
    options.logger?.warn("Durable memory operation failed", { stage, threadId, message });
    try { options.notice({ stage, threadId, message }); } catch { /* A notice cannot crash the worker. */ }
  }

  async function run() {
    reported.clear();
    const storage = await options.storage();
    const store = options.store;
    const secrets = await options.secrets();
    knownSecrets = secrets;
    let state = await store.read();
    const candidates: string[] = [];
    for (let page = 0; page < 3; page++) {
      const listed = await storage.listThreads({ filter: { resourceId: options.projectRoot }, page, perPage: 100, orderBy: { field: "updatedAt", direction: "DESC" } });
      candidates.push(...listed.threads.map(thread => thread.id));
      if (!listed.hasMore) break;
    }
    let writer: { generate: (prompt: string, instructions: string) => Promise<Generation>; budget: { input: number; output: number } } | undefined;
    async function getWriter() {
      if (writer) return writer;
      signal.throwIfAborted();
      const resolved = await options.resolveWriter();
      const budget = memoryWriterBudget(resolved.limits);
      const agent = createMemoryAgent(resolved.model, options.logger);
      writer = { budget, generate: async (prompt, instructions) => {
        if ((estimateTokens([instructions, prompt]) ?? Infinity) > budget.input) throw new Error("Memory generation input exceeds writer budget");
        const result = await agent.generate(prompt, { instructions, abortSignal: signal, maxSteps: 1, activeTools: [], modelSettings: { maxOutputTokens: budget.output, maxRetries: 0 } });
        signal.throwIfAborted();
        if (result.finishReason !== "stop" || result.toolCalls?.length || !result.text.trim()) throw new Error("Memory generation is incomplete or attempted tools");
        return result;
      } };
      return writer;
    }

    let processed = 0;
    for (const threadId of candidates) {
      if (processed >= 3 || signal.aborted) break;
      let token: string | null = null;
      try {
        token = await store.claimThread(threadId, options.runtimeId);
        if (!token) continue;
        const old = state.entries.find(e => e.source_type === "rollout" && e.thread_id === threadId);
        let captured = await captureSourceTurns(storage, store.projectId, threadId, old?.boundary, secrets);
        if (captured.newest > Date.now() - options.config.min_idle_hours * 3_600_000 || !captured.turns.length) continue;
        if (!old && (captured.turns.length < 2 || captured.turns.flat().reduce((sum, message) => sum + message.content.length + JSON.stringify(message.tools ?? []).length, 0) < 1000)) continue;
        processed++;
        const generation = await getWriter();
        for (let chunk = 0; chunk < 2; chunk++) {
          signal.throwIfAborted();
          state = await store.read();
          const previous = state.entries.filter(e => e.thread_id === threadId && ["rollout", "raw"].includes(e.source_type));
          const priorRefs = captured.changed ? [] : refsOf(previous);
          const evidence = [...priorRefs];
          const selected: ProjectedEvidence[] = [];
          const makeInput = () => redactMemoryText(JSON.stringify({ prior: captured.changed ? [] : previous,
            evidence: evidence.map((ref, slot) => ({ slot, ...ref })), messages: selected.map(m => ({ ...m, slot: evidence.findIndex(ref => ref.message_id === m.message_id && ref.thread_id === m.thread_id) })) }), secrets);
          let turns = 0;
          for (const turn of captured.turns) {
            const priorEvidenceLength = evidence.length;
            selected.push(...turn);
            for (const m of turn) if (!evidence.some(ref => ref.message_id === m.message_id && ref.thread_id === m.thread_id)) evidence.push(evidenceRef(m));
            if ((estimateTokens([MEMORY_EXTRACT_PROMPT, makeInput()]) ?? Infinity) > generation.budget.input) {
              selected.splice(selected.length - turn.length); evidence.splice(priorEvidenceLength); break;
            }
            turns++;
          }
          if (!selected.length) throw new Error("A complete source turn cannot fit the memory writer budget");
          const output = extraction.parse(JSON.parse((await generation.generate(makeInput(), MEMORY_EXTRACT_PROMPT)).text));
          const rolloutId = `rollout_${memoryHash(threadId)}`;
          const rollout = makeMemoryEntry(store.projectId, rolloutId, "rollout", output.rollout.title, output.rollout.sections, evidence, secrets);
          const raw = makeMemoryEntry(store.projectId, `raw_${memoryHash(threadId)}`, "raw", output.rollout.title, output.candidates, evidence, secrets);
          // Revalidate originals and source age after generation, before publication.
          const fresh = await captureSourceTurns(storage, store.projectId, threadId, old?.boundary, secrets);
          if (fresh.newest !== captured.newest || fresh.changed !== captured.changed || !(await store.checkClaim(threadId, token))) throw new Error("Source changed or activated during memory generation");
          const priorIds = captured.changed ? [] : (previous.find(e => e.source_type === "rollout")?.boundary?.ids ?? []);
          const coveredIds = [...priorIds, ...selected.map(m => m.message_id)];
          const covered = await readSourceEvidence(storage, store.projectId, coveredIds.map(message_id => ({ thread_id: threadId, message_id })), secrets);
          if (covered.some(m => m.status !== "available")) throw new Error("Memory source evidence was deleted");
          if (memoryHash(JSON.stringify(covered.slice(priorIds.length))) !== memoryHash(JSON.stringify(selected))) throw new Error("Source content changed during memory generation");
          if (priorIds.length && memoryHash(JSON.stringify(covered.slice(0, priorIds.length))) !== previous.find(e => e.source_type === "rollout")?.boundary?.fingerprint) throw new Error("Prior source evidence changed during memory generation");
          rollout.thread_id = raw.thread_id = threadId;
          rollout.boundary = raw.boundary = { ids: coveredIds, fingerprint: memoryHash(JSON.stringify(covered)) };
          await readSourceEvidence(storage, store.projectId, refsOf([rollout, raw]), secrets);
          await store.publish({ revision: state.revision, claim: { threadId, token }, replacements: {
            [`rollout_summaries/${threadId}.md`]: [rollout],
            [MEMORY_FILES.raw]: [...state.entries.filter(e => e.source_type === "raw" && e.thread_id !== threadId), raw],
          } }, signal);
          try {
            const thread = await storage.getThreadById({ threadId });
            if (thread) await storage.patchThread({ id: threadId, metadata: { ...thread.metadata, cubeDurableMemory: rollout.boundary } });
          } catch (error) { report("checkpoint", error, threadId); }
          if (turns === captured.turns.length && !captured.more) break;
          captured = await captureSourceTurns(storage, store.projectId, threadId, rollout.boundary, secrets);
          if (!captured.turns.length) break;
        }
      } catch (error) { report("extract", error, threadId); }
      finally { if (token) await store.releaseClaim(threadId, token).catch(error => report("release", error, threadId)); }
    }

    signal.throwIfAborted();
    state = await store.read();
    const index = state.entries.find(e => e.source_type === "index");
    const pendingRaw = state.entries.filter(e => e.source_type === "raw" && e.sections.length && index?.incorporated[e.source_id] !== e.revision);
    if (!pendingRaw.length) return;
    const generation = await getWriter();
    const existing = state.entries.filter(e => e.source_type === "handbook");
    const selectedRaw: MemoryEntry[] = [];
    let relevant = existing;
    if ((estimateTokens([MEMORY_CONSOLIDATE_PROMPT, existing, pendingRaw[0]]) ?? Infinity) > generation.budget.input) {
      const terms = new Set((pendingRaw[0]!.body.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? []).slice(0, 100));
      relevant = existing.filter(entry => [...terms].some(term => entry.title.toLowerCase().includes(term)));
    }
    const untouched = existing.filter(entry => !relevant.includes(entry));
    const inputFor = () => redactMemoryText(JSON.stringify({ candidates: selectedRaw, existing: relevant.map((entry, slot) => ({ ...entry, slot })), evidence: refsOf([...relevant, ...selectedRaw]).map((ref, slot) => ({ slot, ...ref })) }), secrets);
    for (const raw of pendingRaw) {
      selectedRaw.push(raw);
      if ((estimateTokens([MEMORY_CONSOLIDATE_PROMPT, inputFor()]) ?? Infinity) > generation.budget.input) { selectedRaw.pop(); break; }
    }
    if (!selectedRaw.length) throw new Error("Consolidation input exceeds writer budget; existing memory preserved");
    const refs = refsOf([...relevant, ...selectedRaw]);
    const original = await readSourceEvidence(storage, store.projectId, refs, secrets);
    if (original.some(e => e.status !== "available")) throw new Error("Consolidation evidence is unavailable");
    const output = consolidation.parse(JSON.parse((await generation.generate(inputFor(), MEMORY_CONSOLIDATE_PROMPT)).text));
    const slots = output.entries.flatMap(entry => entry.existing === null ? [] : [entry.existing]);
    if (new Set(slots).size !== slots.length || slots.length !== relevant.length || slots.some(slot => !relevant[slot])) throw new Error("Consolidation omitted or duplicated existing knowledge");
    const entries = output.entries.map(entry => makeMemoryEntry(store.projectId, entry.existing === null ? `memory_${randomUUID()}` : relevant[entry.existing].source_id, "handbook", entry.title, entry.sections, refs, secrets));
    if (new Set(output.index.map(item => item.entry)).size !== entries.length) throw new Error("Consolidation index omitted knowledge entries");
    const indexBody = output.index.map(item => {
      const entry = entries[item.entry];
      if (!entry) throw new Error("Consolidation index references unknown entry");
      return `- ${redactMemoryText(item.text, secrets)} [source_id: ${entry.source_id}]`;
    }).concat(untouched.map(entry => `- ${redactMemoryText(entry.title, secrets)} [source_id: ${entry.source_id}]`)).join("\n");
    if (Array.from(indexBody).length > MEMORY_LIMITS.snapshot - 1200) throw new Error("Consolidation index exceeds snapshot budget");
    const nextIndex: MemoryEntry = { source_id: `index_${memoryHash(store.projectId)}`, source_type: "index", project_id: store.projectId,
      title: "Project memory index", status: "unresolved", body: indexBody, sections: [], revision: randomUUID(), updated_at: new Date().toISOString(),
      incorporated: { ...index?.incorporated, ...Object.fromEntries(selectedRaw.map(e => [e.source_id, e.revision])) } };
    const rechecked = await readSourceEvidence(storage, store.projectId, refs, secrets);
    if (memoryHash(JSON.stringify(rechecked)) !== memoryHash(JSON.stringify(original))) throw new Error("Consolidation evidence changed during generation");
    await store.publish({ revision: state.revision, replacements: { [MEMORY_FILES.handbook]: [...untouched, ...entries], [MEMORY_FILES.index]: [nextIndex] } }, signal);
  }

  return {
    check() {
      if (stopped || !options.config.enabled) return;
      requested = true;
      if (pending) return;
      pending = (async () => {
        // One additional coalesced lifecycle check, never an autonomous retry loop.
        for (let pass = 0; pass < 2 && requested && !stopped; pass++) {
          requested = false;
          try { await run(); } catch (error) { report("worker", error); }
        }
      })().finally(() => { pending = undefined; requested = false; });
    },
    cancel() { stopped = true; requested = false; controller.abort(); },
    async drain() { await pending; },
  };
}
export type DurableMemory = ReturnType<typeof createDurableMemory>;
