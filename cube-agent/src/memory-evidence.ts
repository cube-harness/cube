import type { MastraDBMessage } from "@mastra/core/agent";
import type { MemoryStorage } from "@mastra/core/storage";
import { memoryHash, normalizeProjectId, type EvidenceRef, type MemoryEntry } from "@cube/workspace";

export function redactMemoryText(text: string, secrets: readonly string[] = []): string {
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[Redacted]");
  return text
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*["']?)(?:bearer\s+)?[^\s,"'}]+/gi, "$1[Redacted]")
    .replace(/\b(?:sk-[\w-]{16,}|AIza[\w-]{20,})\b/g, "[Redacted]")
    .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, "[Binary/base64 omitted]");
}

function safeValue(value: unknown, omitted: Set<string>, secrets: readonly string[], depth = 0): unknown {
  if (depth > 6) { omitted.add("deep_payload"); return "[Omitted]"; }
  if (typeof value === "string") {
    if (value.length > 4000) omitted.add("long_text");
    return redactMemoryText(value, secrets).slice(0, 4000);
  }
  if (!value || typeof value !== "object") return value;
  if (value instanceof Uint8Array || (value as { __workspaceMedia?: boolean }).__workspaceMedia || ["file", "image", "media"].includes((value as { type?: string }).type ?? "")) {
    omitted.add("binary_media"); return "[Media omitted]";
  }
  if (Array.isArray(value)) {
    if (value.length > 50) omitted.add("long_array");
    return value.slice(0, 50).map(item => safeValue(item, omitted, secrets, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => {
    if (/authorization|api.?key|access.?token|refresh.?token|password|secret/i.test(key)) return [key, "[Redacted]"];
    if (/^(?:data|base64|reasoning|reasoning_content|thoughtSignature)$/i.test(key)) { omitted.add("binary_reasoning"); return [key, "[Omitted]"]; }
    return [key, safeValue(item, omitted, secrets, depth + 1)];
  }));
}

export type ProjectedEvidence = {
  thread_id: string; message_id: string; role?: string; created_at?: string;
  status: "available" | "unavailable"; content: string;
  tools?: { call_id: string; name: string; args: unknown; result: unknown }[];
  pending_calls?: string[];
  omitted: string[];
};

export function projectMemoryMessage(message: MastraDBMessage, secrets: readonly string[] = []): ProjectedEvidence {
  const omitted = new Set<string>();
  const text: string[] = [];
  const tools: NonNullable<ProjectedEvidence["tools"]> = [];
  const pending: string[] = [];
  for (const part of message.content.parts ?? []) {
    if (part.type === "text") text.push(String(safeValue(part.text, omitted, secrets)));
    else if (part.type === "tool-invocation") {
      const call = part.toolInvocation;
      if (call.state !== "result") { omitted.add("incomplete_tool"); pending.push(call.toolCallId); continue; }
      tools.push({ call_id: call.toolCallId, name: call.toolName, args: safeValue(call.args, omitted, secrets), result: safeValue(call.result, omitted, secrets) });
    } else omitted.add(part.type === "reasoning" ? "hidden_reasoning" : "binary_or_internal_part");
  }
  if (text.join("\n").length > 4000) omitted.add("long_text");
  if (tools.length > 8) omitted.add("extra_tools");
  return { thread_id: message.threadId!, message_id: message.id, role: message.role,
    created_at: new Date(message.createdAt).toISOString(), status: "available",
    content: text.join("\n").slice(0, 4000), ...(tools.length ? { tools: tools.slice(0, 8) } : {}),
    ...(pending.length ? { pending_calls: pending } : {}), omitted: [...omitted] };
}

export async function readSourceEvidence(storage: MemoryStorage, projectId: string, refs: EvidenceRef[], secrets: readonly string[] = []): Promise<ProjectedEvidence[]> {
  if (refs.length > 10000) throw new Error("Too many memory evidence references");
  const unique = [...new Map(refs.map(ref => [`${ref.thread_id}:${ref.message_id}`, ref])).values()];
  const unavailableThreads = new Set<string>();
  for (const threadId of new Set(unique.map(ref => ref.thread_id))) {
    const thread = await storage.getThreadById({ threadId });
    if (!thread) unavailableThreads.add(threadId);
    if (thread && normalizeProjectId(thread.resourceId) !== projectId) throw new Error("Memory evidence belongs to another project");
  }
  const messages: MastraDBMessage[] = [];
  for (let index = 0; index < unique.length; index += 100)
    messages.push(...(await storage.listMessagesById({ messageIds: unique.slice(index, index + 100).map(ref => ref.message_id) })).messages);
  const byId = new Map(messages.map(message => [message.id, message]));
  return unique.map(ref => {
    const message = byId.get(ref.message_id);
    if (!message || unavailableThreads.has(ref.thread_id)) return { ...ref, status: "unavailable", content: "Original message is unavailable", omitted: [] };
    if (message.threadId !== ref.thread_id || !message.resourceId || normalizeProjectId(message.resourceId) !== projectId)
      throw new Error("Invalid memory evidence ownership");
    return projectMemoryMessage(message, secrets);
  });
}

export type SourceChunk = { turns: ProjectedEvidence[][]; boundary: NonNullable<MemoryEntry["boundary"]>; newest: number; more: boolean; changed: boolean };

export async function captureSourceTurns(storage: MemoryStorage, projectId: string, threadId: string, boundary?: MemoryEntry["boundary"], secrets: readonly string[] = []): Promise<SourceChunk> {
  const thread = await storage.getThreadById({ threadId });
  if (!thread || normalizeProjectId(thread.resourceId) !== projectId) throw new Error("Source thread is unavailable in this project");
  let prior: ProjectedEvidence[] = [];
  if (boundary) prior = await readSourceEvidence(storage, projectId, boundary.ids.map(message_id => ({ thread_id: threadId, message_id })), secrets);
  let changed = Boolean(boundary && (prior.some(m => m.status !== "available") || memoryHash(JSON.stringify(prior)) !== boundary.fingerprint));
  // IDs/fingerprints alone cannot detect insertion before an equal-timestamp boundary.
  if (boundary && !changed) {
    for (let page = 0; page * 100 < prior.length; page++) {
      const current = await storage.listMessages({ threadId, resourceId: thread.resourceId, page, perPage: 100, orderBy: { field: "createdAt", direction: "ASC" } });
      const expected = boundary.ids.slice(page * 100, (page + 1) * 100);
      if (JSON.stringify(current.messages.slice(0, expected.length).map(message => message.id)) !== JSON.stringify(expected)) {
        changed = true;
        break;
      }
    }
  }
  if (changed) prior = [];
  const offset = prior.length;
  const messages: MastraDBMessage[] = [];
  for (let page = Math.floor(offset / 100); messages.length < 1000; page++) {
    const result = await storage.listMessages({ threadId, resourceId: thread.resourceId, page, perPage: 100, orderBy: { field: "createdAt", direction: "ASC" } });
    messages.push(...result.messages.slice(page === Math.floor(offset / 100) ? offset % 100 : 0).slice(0, 1000 - messages.length));
    if (!result.hasMore) break;
  }
  const turns: ProjectedEvidence[][] = [];
  let current: ProjectedEvidence[] = [];
  let blocked = false;
  const finish = () => {
    if (!current.length) return;
    const last = current.at(-1);
    const completed = new Set(current.flatMap(message => message.tools?.map(tool => tool.call_id) ?? []));
    const incomplete = current.some(message => message.pending_calls?.some(id => !completed.has(id)));
    if (current[0]?.role === "user" && last?.role === "assistant" && last.content.trim() && !incomplete) turns.push(current);
    else blocked = true;
    current = [];
  };
  for (const message of messages) {
    if (message.role === "user") finish();
    if (blocked) break;
    current.push(projectMemoryMessage(message, secrets));
  }
  // A full capture page may end in the middle of a turn; never checkpoint it.
  if (messages.length < 1000) finish();
  const newest = (await storage.listMessages({ threadId, resourceId: thread.resourceId, page: 0, perPage: 1, orderBy: { field: "createdAt", direction: "DESC" } })).messages[0]?.createdAt;
  const covered = [...prior, ...turns.flat()];
  return { turns, boundary: { ids: covered.map(m => m.message_id), fingerprint: memoryHash(JSON.stringify(covered)) },
    newest: newest ? new Date(newest).getTime() : 0, more: messages.length >= 1000, changed };
}
