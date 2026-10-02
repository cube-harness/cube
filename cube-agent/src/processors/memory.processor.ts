import type { InputProcessor } from "@mastra/core/processors";
import { MEMORY_LIMITS, type MemorySnapshot } from "@cube/workspace";
import { MEMORY_RECALL_PROMPT } from "../prompts/memory-recall.prompt.js";

export function formatMemorySnapshot(snapshot: MemorySnapshot | undefined): string {
  if (!snapshot?.text.trim()) return "";
  const text = `<durable_memory>\n${MEMORY_RECALL_PROMPT}\n${snapshot.text.replaceAll("<", "&lt;")}\n</durable_memory>`;
  if (Array.from(text).length > MEMORY_LIMITS.snapshot) throw new Error("Memory snapshot exceeds its context limit");
  return text;
}

export const createMemoryProcessor = (
  readSnapshot: () => MemorySnapshot | undefined,
  protectedMessages: WeakSet<object>,
): InputProcessor => ({
  id: "cube-durable-memory",
  processLLMRequest({ prompt }) {
    const text = formatMemorySnapshot(readSnapshot());
    if (!text) return;
    let index = 0;
    while (index < prompt.length && (prompt[index]!.role === "system" || protectedMessages.has(prompt[index]!))) index++;
    const message = { role: "user" as const, content: [{ type: "text" as const, text }] };
    protectedMessages.add(message);
    return { prompt: [...prompt.slice(0, index), message, ...prompt.slice(index)] };
  },
});
