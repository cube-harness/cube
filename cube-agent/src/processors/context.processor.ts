import { MessageList, isUserAuthoredMessage, type MastraDBMessage } from "@mastra/core/agent";
import type { InputProcessor, ProcessLLMRequestArgs } from "@mastra/core/processors";
import type { RequestContext } from "@mastra/core/request-context";
import { asSchema, type FlexibleSchema } from "ai";
import {
  CubeContext,
  estimateTokens,
  OMITTED_OUTPUT,
  type ContextCheckpoint,
  type ContextLimits,
} from "../context.js";
import { buildSummaryContext } from "../prompts/context.prompt.js";

type Prompt = ProcessLLMRequestArgs["prompt"];
type Segment = { id?: string; message: Prompt[number] };
export type RequestFrame = {
  threadId: string;
  limits: ContextLimits;
  requestedOutput?: number;
  requestContext: RequestContext;
  fixedTokens?: number;
  isCurrent(): boolean;
  refresh(messages: MastraDBMessage[]): Promise<RequestFrame>;
  count(prompt: Prompt): number | undefined;
  project(checkpoint: ContextCheckpoint): Prompt;
  select(
    checkpoint: ContextCheckpoint,
    keep: number,
  ): { boundary: string; task?: string; text: string } | undefined;
};

const nonempty = (message: { content: unknown }) =>
  typeof message.content === "string"
    ? message.content.length > 0
    : Array.isArray(message.content) && message.content.length > 0;

function toolIds(message: { content: unknown }): string {
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) =>
          part && typeof part === "object" && "toolCallId" in part ? [part.toolCallId] : [],
        )
        .join("\0")
    : "";
}

/** Match native conversion order and tool identity, never the user's text. */
export function mapRequestSources(
  messages: MastraDBMessage[],
  prompt: Prompt,
  protectedMessages: WeakSet<object>,
): Segment[] {
  const expected = messages.flatMap((message) => {
    const list = new MessageList({ filterIncompleteToolCalls: true });
    list.add([message], "memory");
    return list.get.all.aiV5
      .model()
      .filter(nonempty)
      .map((converted) => ({
        id: message.id,
        role: converted.role,
        tools: toolIds(converted),
      }));
  });
  let index = 0;
  const segments = prompt.map((message): Segment => {
    if (message.role === "system" || protectedMessages.has(message)) return { message };
    const source = expected[index++];
    if (!source || source.role !== message.role || source.tools !== toolIds(message)) {
      throw new Error("Cannot map native request to stored context safely");
    }
    return { id: source.id, message };
  });
  if (index !== expected.length)
    throw new Error("Native request omitted context that cannot be mapped safely");
  return segments;
}

function prunePrompt(prompt: Prompt, ids: Set<string>): Prompt {
  return prompt.map((message) =>
    message.role !== "tool"
      ? message
      : {
          ...message,
          content: message.content.map((part) =>
            part.type === "tool-result" && ids.has(part.toolCallId)
              ? { ...part, output: { type: "text" as const, value: OMITTED_OUTPUT } }
              : part,
          ),
        },
  );
}

export function makeRequestFrame(input: {
  threadId: string;
  messages: MastraDBMessage[];
  prompt: Prompt;
  protectedMessages: WeakSet<object>;
  toolsTokens: number;
  limits: ContextLimits;
  requestedOutput?: number;
  requestContext: RequestContext;
  isCurrent: () => boolean;
}): RequestFrame {
  const segments = mapRequestSources(input.messages, input.prompt, input.protectedMessages);
  const indexById = new Map(input.messages.map((message, index) => [message.id, index]));
  const count = (prompt: Prompt) => {
    const tokens = estimateTokens(prompt);
    return tokens === undefined ? undefined : tokens + input.toolsTokens;
  };
  const locate = (id: string) => {
    const index = indexById.get(id);
    if (index === undefined) throw new Error("Saved context boundary is missing from this thread");
    return index;
  };
  const project = (checkpoint: ContextCheckpoint): Prompt => {
    const boundary = checkpoint.summary ? locate(checkpoint.summary.firstRetainedMessageId) : 0;
    const retained = segments.filter(
      (segment) =>
        segment.id === undefined ||
        locate(segment.id) >= boundary ||
        segment.id === checkpoint.summary?.taskMessageId,
    );
    const prompt = prunePrompt(
      retained.map((segment) => segment.message),
      new Set(checkpoint.prunedToolCallIds),
    );
    if (!checkpoint.summary) return prompt;
    let position = prompt.findIndex(
      (message) => message.role !== "system" && !input.protectedMessages.has(message),
    );
    if (position < 0) position = prompt.length;
    prompt.splice(position, 0, {
      role: "user",
      content: [{ type: "text", text: buildSummaryContext(checkpoint.summary.text) }],
    });
    return prompt;
  };
  return {
    threadId: input.threadId,
    limits: input.limits,
    requestedOutput: input.requestedOutput,
    requestContext: input.requestContext,
    isCurrent: input.isCurrent,
    fixedTokens: count(segments.filter((segment) => !segment.id).map((segment) => segment.message)),
    count,
    project,
    async refresh(messages) {
      // Manual compaction only needs the new persisted suffix of the last request.
      // A changed prefix means the accounting envelope is stale, not permission to guess.
      if (
        messages.length < input.messages.length ||
        input.messages.some(
          (message, index) =>
            messages[index]?.id !== message.id ||
            JSON.stringify(messages[index]?.content) !== JSON.stringify(message.content),
        )
      ) {
        throw new Error(
          "Context changed since the last request; send a turn before retrying /compact.",
        );
      }
      const suffix = messages.slice(input.messages.length);
      const list = new MessageList({ filterIncompleteToolCalls: true });
      list.add(suffix, "memory");
      const tail = suffix.length ? await list.get.all.aiV5.llmPrompt() : [];
      // Native conversion can prepend a Gemini compatibility filler to assistant-only suffixes.
      const firstRole = list.get.all.aiV5.model().filter(nonempty)[0]?.role;
      if (firstRole === "assistant" && tail[0]?.role === "user") tail.shift();
      return makeRequestFrame({ ...input, messages, prompt: [...input.prompt, ...tail] });
    },
    select(checkpoint, keep) {
      const start = checkpoint.summary ? locate(checkpoint.summary.firstRetainedMessageId) : 0;
      const latestTask = input.messages.filter(isUserAuthoredMessage).at(-1);
      const taskIndex = latestTask ? locate(latestTask.id) : -1;
      let boundary = input.messages.length;
      let accumulated = 0;
      for (let i = input.messages.length - 1; i >= start; i--) {
        const id = input.messages[i]!.id;
        const parts = segments
          .filter((segment) => segment.id === id)
          .map((segment) => segment.message);
        if (!parts.length) continue;
        const tokens = estimateTokens(prunePrompt(parts, new Set(checkpoint.prunedToolCallIds)));
        if (tokens === undefined) return;
        if (accumulated && accumulated + tokens > keep) break;
        accumulated += tokens;
        boundary = i;
      }
      if (boundary <= start || boundary === input.messages.length) return;
      const older = segments
        .filter(
          (segment) =>
            segment.id &&
            (locate(segment.id) >= start || segment.id === checkpoint.summary?.taskMessageId) &&
            locate(segment.id) < boundary &&
            segment.id !== latestTask?.id,
        )
        .map((segment) => segment.message);
      if (!older.length) return;
      const pruned = prunePrompt(older, new Set(checkpoint.prunedToolCallIds));
      if (estimateTokens(pruned) === undefined) return;
      return {
        boundary: input.messages[boundary]!.id,
        ...(taskIndex >= 0 && taskIndex < boundary ? { task: latestTask!.id } : {}),
        text: JSON.stringify(pruned),
      };
    },
  };
}

export const createContextProcessor = (
  context: CubeContext,
  readModel: () => Promise<{ limits: ContextLimits }>,
  readRevision: () => string,
): InputProcessor => ({
  id: "cube-context",
  async processInputStep({ messageList, tools, modelSettings, state }) {
    state.contextMessages = structuredClone(messageList.get.all.db());
    state.contextSettings = modelSettings;
    const schemas = await Promise.all(
      Object.entries(tools ?? {}).map(async ([name, tool]) => {
        if (!tool || typeof tool !== "object")
          throw new Error(`Cannot account for tool schema: ${name}`);
        const schema = "inputSchema" in tool ? tool.inputSchema : undefined;
        return {
          name,
          description: "description" in tool ? tool.description : undefined,
          schema: schema ? await asSchema(schema as FlexibleSchema<unknown>).jsonSchema : undefined,
        };
      }),
    );
    state.contextToolsTokens = estimateTokens(schemas);
  },
  async processLLMRequest({ prompt, requestContext, abortSignal, state, abort }) {
    if (!requestContext) return;
    const controller = requestContext.get("controller") as { threadId?: string } | undefined;
    const threadId = controller?.threadId;
    if (!threadId) return;
    try {
      const current = await readModel();
      const revision = readRevision();
      const frame = makeRequestFrame({
        threadId,
        prompt,
        messages: state.contextMessages as MastraDBMessage[],
        toolsTokens: Number(state.contextToolsTokens ?? 0),
        requestedOutput: (state.contextSettings as { maxOutputTokens?: number })?.maxOutputTokens,
        limits: current.limits,
        requestContext,
        protectedMessages: context.protectedMessages,
        isCurrent: () => readRevision() === revision,
      });
      context.remember(frame);
      let projected = frame.project(await context.read(threadId));
      const budget = context.budget(current.limits, frame.requestedOutput);
      const tokens = frame.count(projected);
      if (budget && tokens !== undefined && tokens > budget.input) {
        const result = await context.compact(frame, false, abortSignal);
        if (result.status === "skipped") throw new Error(result.reason);
        projected = frame.project(await context.read(threadId));
      }
      return { prompt: projected };
    } catch (error) {
      abort(error instanceof Error ? error.message : String(error));
    }
  },
});
