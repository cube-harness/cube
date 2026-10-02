import { isUserAuthoredMessage, type MastraDBMessage } from "@mastra/core/agent";
import type { MemoryStorage } from "@mastra/core/storage";
import type { RequestContext } from "@mastra/core/request-context";
import type { CubeConfig } from "@cube/workspace";
import { z } from "zod";
import type { RequestFrame } from "./processors/context.processor.js";
import { buildCompactPrompt, COMPACT_SYSTEM_PROMPT } from "./prompts/compact.prompt.js";

export type ContextPolicy = Omit<CubeConfig["memory"]["compaction"], "model">;
export type ContextLimits = { context?: number; input?: number; output?: number };
export type ContextBudget = { context: number; input: number; reserve: number; summary: number };
export type CompactResult =
  | { status: "compacted"; before: number; after: number }
  | { status: "skipped"; reason: string };

const checkpointSchema = z.object({
  summary: z.object({
    text: z.string().min(1),
    firstRetainedMessageId: z.string().min(1),
    taskMessageId: z.string().min(1).optional(),
  }).strict().optional(),
  prunedToolCallIds: z.array(z.string()),
}).strict();
export type ContextCheckpoint = z.infer<typeof checkpointSchema>;

const positive = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0;

// Pi reserve/summary policy; independently adapted to catalog limits:
// https://github.com/earendil-works/pi/blob/d192bd6dcae78fb87cf5c1c5e2af2790a0296278/packages/coding-agent/src/core/compaction/compaction.ts
export function contextBudget(
  limits: ContextLimits,
  policy: ContextPolicy,
  requestedOutput = 0,
): ContextBudget | undefined {
  if (!positive(limits.context)) return;
  const reserve = Math.max(policy.reserve_tokens, requestedOutput);
  const input = Math.min(positive(limits.input) ? limits.input : Infinity, limits.context - reserve);
  if (input <= 0) return;
  return {
    context: limits.context, input, reserve,
    summary: Math.min(Math.floor(0.8 * reserve), positive(limits.output) ? limits.output : Infinity),
  };
}

// Text estimates, never billing totals. Binary parts have unknown cost; callers
// must not mistake their encoded character length for text tokens.
export function estimateTokens(value: unknown): number | undefined {
  let unknownMedia = false;
  const text = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && (
      ["image", "file", "image-data", "file-data", "media"].includes(item.type) ||
      item.__workspaceMedia === true || item instanceof Uint8Array
    )) {
      unknownMedia = true;
      return "[media]";
    }
    return item;
  });
  return unknownMedia ? undefined : Math.ceil((text?.length ?? 0) / 4);
}

export const OMITTED_OUTPUT = "[Old tool output omitted]";

/** OpenCode prune selection: reverse parts, two user boundaries, 40k/strict >20k.
 * Reference: https://github.com/anomalyco/opencode/blob/dab2637217f188afca5e6631f67b935723e6218a/packages/opencode/src/session/compaction.ts
 * Independently adapted to native Mastra messages; no upstream runtime dependency.
 */
export function selectPrunedTools(
  messages: MastraDBMessage[],
  checkpoint: ContextCheckpoint,
  protectedTools: ReadonlySet<string>,
  count: (output: unknown) => number | undefined = estimateTokens,
): string[] {
  const previous = new Set(checkpoint.prunedToolCallIds);
  let turns = 0, total = 0, candidateTokens = 0;
  const candidates: string[] = [];
  loop: for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (isUserAuthoredMessage(message)) turns++;
    const boundary = message.id === checkpoint.summary?.firstRetainedMessageId;
    if (turns >= 2) {
      const parts = message.content.parts ?? [];
      for (let p = parts.length - 1; p >= 0; p--) {
        const part = parts[p]!;
        if (part.type !== "tool-invocation") continue;
        const call = part.toolInvocation;
        if (call.state !== "result" || call.isError || protectedTools.has(call.toolName)) continue;
        if (previous.has(call.toolCallId)) break loop;
        if (call.result && typeof call.result === "object" && "isError" in call.result && call.result.isError) continue;
        const tokens = count(part.providerMetadata?.mastra?.modelOutput ?? call.result);
        // Unknown media cost cannot establish the protected frontier safely.
        if (tokens === undefined) break loop;
        total += tokens;
        if (total <= 40_000) continue;
        candidates.push(call.toolCallId);
        candidateTokens += tokens;
      }
    }
    if (boundary) break;
  }
  return candidateTokens > 20_000 ? candidates : [];
}

type SummaryOutput = { text: string; finishReason?: string; toolCalls?: unknown[] };
type ContextDependencies = {
  policy: ContextPolicy;
  storage: () => Promise<MemoryStorage>;
  summarize: (input: {
    text: string; maxOutputTokens: number; signal: AbortSignal; requestContext: RequestContext;
  }) => Promise<SummaryOutput>;
  protectedTools: ReadonlySet<string>;
};

export class CubeContext {
  readonly protectedMessages = new WeakSet<object>();
  private envelope?: RequestFrame;
  private operation?: Promise<CompactResult>;
  private controller?: AbortController;
  private listeners = new Set<(active: boolean, automaticResult?: CompactResult) => void>();

  constructor(private readonly dependencies: ContextDependencies) {}

  budget(limits: ContextLimits, requestedOutput?: number): ContextBudget | undefined {
    return contextBudget(limits, this.dependencies.policy, requestedOutput);
  }

  invalidate(): void { this.envelope = undefined; }
  remember(frame: RequestFrame): void { this.envelope = frame; }
  isCompacting(): boolean { return this.operation !== undefined; }
  cancel(): void { this.controller?.abort(); }
  async drain(): Promise<void> { await this.operation?.catch(() => undefined); }
  subscribe(listener: (active: boolean, automaticResult?: CompactResult) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async read(threadId: string): Promise<ContextCheckpoint> {
    const store = await this.dependencies.storage();
    const thread = await store.getThreadById({ threadId });
    if (!thread) throw new Error("Context thread no longer exists");
    return thread.metadata?.cubeContext === undefined
      ? { prunedToolCallIds: [] }
      : checkpointSchema.parse(thread.metadata.cubeContext);
  }

  private async save(threadId: string, checkpoint: ContextCheckpoint, signal?: AbortSignal): Promise<void> {
    const store = await this.dependencies.storage();
    const thread = await store.getThreadById({ threadId });
    if (!thread) throw new Error("Context thread no longer exists");
    // Commit point: cancellation before handing off the atomic write keeps the
    // previous checkpoint. The storage API cannot cancel a write already submitted.
    signal?.throwIfAborted();
    // Unlike Session.setSetting, this propagates write failures and preserves title.
    await store.patchThread({ id: threadId, metadata: { cubeContext: checkpoint } });
  }

  async messages(threadId: string): Promise<MastraDBMessage[]> {
    return (await (await this.dependencies.storage()).listMessages({
      threadId, perPage: false, orderBy: { field: "createdAt", direction: "ASC" },
    })).messages;
  }

  async prune(threadId: string): Promise<void> {
    const checkpoint = await this.read(threadId);
    const candidates = selectPrunedTools(
      await this.messages(threadId), checkpoint, this.dependencies.protectedTools,
    );
    if (!candidates.length) return;
    await this.save(threadId, {
      ...checkpoint, prunedToolCallIds: [...new Set([...checkpoint.prunedToolCallIds, ...candidates])],
    });
  }

  async fork(sourceThreadId: string, title?: string): Promise<{ id: string }> {
    const store = await this.dependencies.storage();
    const checkpoint = await this.read(sourceThreadId);
    const cloned = await store.cloneThread({ sourceThreadId, title });
    try {
      const remap = (id: string): string => {
        const mapped = cloned.messageIdMap?.[id];
        if (!mapped) throw new Error("Retained context was not cloned");
        return mapped;
      };
      const toolIds = new Set(cloned.clonedMessages.flatMap((message) =>
        (message.content.parts ?? []).flatMap((part) => part.type === "tool-invocation"
          ? [part.toolInvocation.toolCallId] : [])));
      await this.save(cloned.thread.id, {
        ...(checkpoint.summary ? { summary: {
          ...checkpoint.summary,
          firstRetainedMessageId: remap(checkpoint.summary.firstRetainedMessageId),
          ...(checkpoint.summary.taskMessageId ? { taskMessageId: remap(checkpoint.summary.taskMessageId) } : {}),
        } } : {}),
        prunedToolCallIds: checkpoint.prunedToolCallIds.filter((id) => toolIds.has(id)),
      });
    } catch (cause) {
      throw new Error(`Context copy failed; incomplete clone ${cloned.thread.id} was not activated.`, { cause });
    }
    return { id: cloned.thread.id };
  }

  async compactManual(input: { threadId: string; signal: AbortSignal }): Promise<CompactResult> {
    const envelope = this.envelope;
    if (!envelope || envelope.threadId !== input.threadId || !envelope.isCurrent()) {
      return { status: "skipped", reason: "Cannot establish the current request budget; send a turn first, then retry /compact." };
    }
    const frame = await envelope.refresh(await this.messages(input.threadId));
    return this.compact(frame, true, input.signal);
  }

  compact(frame: RequestFrame, manual: boolean, signal?: AbortSignal): Promise<CompactResult> {
    if (this.operation) return Promise.reject(new Error("Compaction is already running"));
    this.controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    // Defer the body so ownership is installed before observers can re-enter.
    this.operation = Promise.resolve().then(() => this.performCompact(frame, manual, combined));
    for (const listener of this.listeners) listener(true);
    let completed: CompactResult | undefined;
    return this.operation.then((result) => { completed = result; return result; }).finally(() => {
      this.operation = undefined;
      this.controller = undefined;
      for (const listener of this.listeners) listener(false, manual ? undefined : completed);
    });
  }

  private async performCompact(frame: RequestFrame, manual: boolean, signal: AbortSignal): Promise<CompactResult> {
    const skip = (reason: string): CompactResult => ({ status: "skipped", reason });
    const policy = this.dependencies.policy;
    const budget = contextBudget(frame.limits, policy, frame.requestedOutput);
    if (!budget) return skip("The active model has no usable context budget.");
    const previous = await this.read(frame.threadId);
    const before = frame.count(frame.project(previous));
    if (before === undefined) return skip("Cannot establish context size for this request's media attachments.");
    if (manual && before / budget.context < policy.manual_min_ratio)
      return skip(`Context is below the ${Math.round(policy.manual_min_ratio * 100)}% manual compaction threshold.`);
    const fixed = frame.fixedTokens;
    if (fixed === undefined) return skip("Cannot establish the fixed request overhead.");
    const keep = Math.floor(policy.keep_recent_ratio * Math.max(0, budget.input - fixed - budget.summary - 128));
    const selection = frame.select(previous, keep);
    if (!selection) return skip("No older conversation can be compacted safely.");
    const text = buildCompactPrompt(selection.text, previous.summary?.text);
    const summaryInput = estimateTokens([COMPACT_SYSTEM_PROMPT, text]);
    if (summaryInput === undefined || summaryInput + 128 > budget.input)
      return skip("The summarization request itself exceeds the model input budget.");
    signal.throwIfAborted();
    const output = await this.dependencies.summarize({
      text, maxOutputTokens: budget.summary, signal, requestContext: frame.requestContext,
    });
    signal.throwIfAborted();
    if (!output.text.trim() || output.finishReason !== "stop" || output.toolCalls?.length)
      throw new Error("Compaction did not produce a complete continuation summary");
    const next: ContextCheckpoint = {
      summary: { text: output.text.trim(), firstRetainedMessageId: selection.boundary, taskMessageId: selection.task },
      prunedToolCallIds: previous.prunedToolCallIds,
    };
    const after = frame.count(frame.project(next));
    if (after === undefined || after >= before || after > budget.input)
      throw new Error("Compaction cannot reduce this request to a safe size");
    await this.save(frame.threadId, next, signal);
    return { status: "compacted", before, after };
  }
}
