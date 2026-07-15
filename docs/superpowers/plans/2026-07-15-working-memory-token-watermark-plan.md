# Working Memory Token Watermark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement short-term working memory using token high/low watermarks, preserving full checkpoint history while sending only `summary + unsummarized recent messages` into LLM calls.

**Architecture:** Keep `main graph` thin and move summary compaction into a dedicated `working-memory` subgraph. `message-window.ts` owns the working-memory policy and is shared by `agent.node.ts` and the subgraph so model input and summary compaction use the same boundaries. The implementation never deletes checkpoint messages with `RemoveMessage`.

**Tech Stack:** TypeScript, Node ESM, LangGraph JS `StateGraph`, LangChain message classes, existing provider factory, `tsx --test` for focused unit tests, `npm test` for final verification.

## Global Constraints

- Reply and implementation notes to the user must be in Vietnamese.
- Keep full `state.messages` in checkpoint history.
- Do not use `RemoveMessage` for working-memory compaction.
- Do not call checkpointer APIs directly from graph nodes.
- Do not write to Store or implement long-term memory in this phase.
- Keep working-memory policy under `src/graph/working-memory`, not `src/utility`.
- Preserve whole message content; token counts decide boundaries but must not truncate text inside a retained message.
- Preserve valid `AIMessage.tool_calls` and matching `ToolMessage` boundaries.
- Use token high/low watermarks: `WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS` and `WORKING_MEMORY_RECENT_TOKENS_TO_KEEP`.
- Run tests only at the end of implementation, unless a task explicitly introduces a focused test runner check.

---

## File Structure

- Create: `src/graph/working-memory/message-window.ts` — deterministic working-memory policy: token counting, unsummarized segment, high/low watermark split, tool-call boundary safety.
- Create: `src/graph/working-memory/node/prepare-summary-input.node.ts` — deterministic graph node that prepares pending summary delta or clears stale pending fields.
- Create: `src/graph/working-memory/node/summarize.node.ts` — LLM node that updates `summary` from existing summary plus compactable delta.
- Create: `src/graph/working-memory/prompt/summarize.prompt.ts` — summary update prompt for delta compaction.
- Create: `src/graph/working-memory/graph.ts` — compiled working-memory subgraph.
- Create: `test/graph/working-memory/message-window.test.ts` — executable unit tests for deterministic boundary logic.
- Modify: `src/config/constant.ts` — replace old summary threshold with token high/low watermark constants.
- Modify: `src/graph/main/state.ts` — add persisted summary marker and transient pending summary fields.
- Modify: `src/graph/main/node/agent.node.ts` — send `summary + unsummarized recent messages` to model instead of full history.
- Modify: `src/graph/main/graph.ts` — wire `working_memory` after final agent response.
- Modify: `package.json` — add `test:unit` and make `npm test` run build plus focused unit tests.

---

### Task 1: State And Config Foundation

**Files:**
- Modify: `src/config/constant.ts`
- Modify: `src/graph/main/state.ts`
- Modify: `package.json`

**Interfaces:**
- Produces constants:
  - `WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS: number`
  - `WORKING_MEMORY_RECENT_TOKENS_TO_KEEP: number`
- Produces state fields:
  - `summarizedThroughMessageId?: string`
  - `pendingSummaryMessages?: BaseMessage[]`
  - `pendingSummaryThroughMessageId?: string`

- [ ] **Step 1: Update constants**

Replace `src/config/constant.ts` with:

```ts
export const SUMMARY_MAX_WORDS = 250;

export const WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS = 6000;
export const WORKING_MEMORY_RECENT_TOKENS_TO_KEEP = 3000;
```

- [ ] **Step 2: Update main state schema**

Modify `src/graph/main/state.ts` to:

```ts
import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import * as z from "zod";

export const MainState = new StateSchema({
  messages: MessagesValue,
  summary: z.string().default("").optional(),
  summarizedThroughMessageId: z.string().optional(),
  pendingSummaryMessages: z.custom<BaseMessage[]>().optional(),
  pendingSummaryThroughMessageId: z.string().optional(),
});

export type MainStateType = typeof MainState.State;
export type MainStateUpdate = typeof MainState.Update;
```

- [ ] **Step 3: Add unit test script**

Modify `package.json` scripts to:

```json
{
  "dev": "langgraphjs dev",
  "build": "tsc --noEmit",
  "test": "npm run build && npm run test:unit",
  "test:unit": "tsx --test \"test/**/*.test.ts\"",
  "graph:render": "tsx src/script/reder_graph.ts"
}
```

- [ ] **Step 4: Do not run tests yet**

Per project workflow, defer full verification until the end. Confirm only that files are edited as specified.

---

### Task 2: Message Window Policy

**Files:**
- Create: `src/graph/working-memory/message-window.ts`
- Create: `test/graph/working-memory/message-window.test.ts`

**Interfaces:**
- Consumes:
  - `BaseMessage[]`
  - `summarizedThroughMessageId?: string`
  - trigger/keep token constants
- Produces:
  - `selectModelInputMessages(args): BaseMessage[]`
  - `prepareSummaryWindow(args): SummaryWindow`

- [ ] **Step 1: Write unit tests**

Create `test/graph/working-memory/message-window.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  prepareSummaryWindow,
  selectModelInputMessages,
} from "../../../src/graph/working-memory/message-window.js";

function human(id: string, content: string): HumanMessage {
  return new HumanMessage({ id, content });
}

function ai(id: string, content: string): AIMessage {
  return new AIMessage({ id, content });
}

test("selectModelInputMessages returns unsummarized messages after marker", () => {
  const messages = [
    human("h1", "old"),
    ai("a1", "old answer"),
    human("h2", "new"),
  ];

  const selected = selectModelInputMessages({
    messages,
    summarizedThroughMessageId: "a1",
  });

  assert.deepEqual(selected.map((m) => m.id), ["h2"]);
});

test("prepareSummaryWindow does not summarize below high watermark", () => {
  const messages = [
    human("h1", "short one"),
    ai("a1", "short two"),
  ];

  const window = prepareSummaryWindow({
    messages,
    summarizedThroughMessageId: undefined,
    triggerTokens: 100,
    recentTokensToKeep: 50,
  });

  assert.equal(window.shouldSummarize, false);
  assert.deepEqual(window.messagesToSummarize, []);
  assert.equal(window.summarizedThroughMessageId, undefined);
});

test("prepareSummaryWindow compacts older messages and keeps recent messages", () => {
  const messages = [
    human("h1", "alpha beta gamma delta"),
    ai("a1", "epsilon zeta eta theta"),
    human("h2", "iota kappa lambda mu"),
    ai("a2", "nu xi omicron pi"),
  ];

  const window = prepareSummaryWindow({
    messages,
    summarizedThroughMessageId: undefined,
    triggerTokens: 12,
    recentTokensToKeep: 6,
  });

  assert.equal(window.shouldSummarize, true);
  assert.deepEqual(window.messagesToSummarize.map((m) => m.id), ["h1", "a1"]);
  assert.equal(window.summarizedThroughMessageId, "a1");
});

test("prepareSummaryWindow keeps tool call and tool result together", () => {
  const toolCallingAi = new AIMessage({
    id: "a1",
    content: "",
    tool_calls: [{ id: "call_1", name: "get_current_time", args: {} }],
  });
  const toolResult = new ToolMessage({
    id: "t1",
    content: "10:00",
    tool_call_id: "call_1",
  });
  const messages = [
    human("h1", "time?"),
    toolCallingAi,
    toolResult,
    ai("a2", "It is 10:00."),
    human("h2", "thanks"),
  ];

  const window = prepareSummaryWindow({
    messages,
    summarizedThroughMessageId: undefined,
    triggerTokens: 8,
    recentTokensToKeep: 3,
  });

  assert.equal(window.shouldSummarize, true);
  assert.deepEqual(window.messagesToSummarize.map((m) => m.id), ["h1", "a1", "t1"]);
  assert.equal(window.summarizedThroughMessageId, "t1");
});

test("retained Vietnamese message is not partially truncated", () => {
  const messages = [
    human("h1", "old old old old old old old old"),
    human("h2", "tôi là phạm hoài phúc"),
  ];

  const selected = selectModelInputMessages({
    messages,
    summarizedThroughMessageId: "h1",
  });

  assert.equal(selected[0]?.content, "tôi là phạm hoài phúc");
});
```

- [ ] **Step 2: Implement message-window policy**

Create `src/graph/working-memory/message-window.ts`:

```ts
import {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";

export interface SelectModelInputMessagesArgs {
  messages: BaseMessage[];
  summarizedThroughMessageId?: string;
}

export interface PrepareSummaryWindowArgs extends SelectModelInputMessagesArgs {
  triggerTokens: number;
  recentTokensToKeep: number;
}

export interface SummaryWindow {
  shouldSummarize: boolean;
  messagesToSummarize: BaseMessage[];
  summarizedThroughMessageId?: string;
}

export function selectModelInputMessages({
  messages,
  summarizedThroughMessageId,
}: SelectModelInputMessagesArgs): BaseMessage[] {
  return getMessagesAfterMarker(messages, summarizedThroughMessageId);
}

export function prepareSummaryWindow({
  messages,
  summarizedThroughMessageId,
  triggerTokens,
  recentTokensToKeep,
}: PrepareSummaryWindowArgs): SummaryWindow {
  const unsummarizedMessages = getMessagesAfterMarker(messages, summarizedThroughMessageId);

  if (countMessageTokens(unsummarizedMessages) <= triggerTokens) {
    return { shouldSummarize: false, messagesToSummarize: [] };
  }

  const keepStartIndex = findRecentWindowStartIndex(unsummarizedMessages, recentTokensToKeep);
  const safeCutIndex = moveCutBeforeInvalidToolBoundary(unsummarizedMessages, keepStartIndex);
  const messagesToSummarize = unsummarizedMessages.slice(0, safeCutIndex);
  const lastMessage = messagesToSummarize.at(-1);

  if (!lastMessage?.id) {
    return { shouldSummarize: false, messagesToSummarize: [] };
  }

  return {
    shouldSummarize: true,
    messagesToSummarize,
    summarizedThroughMessageId: lastMessage.id,
  };
}

function getMessagesAfterMarker(
  messages: BaseMessage[],
  summarizedThroughMessageId?: string
): BaseMessage[] {
  if (!summarizedThroughMessageId) {
    return messages;
  }

  const markerIndex = messages.findIndex((message) => message.id === summarizedThroughMessageId);
  if (markerIndex < 0) {
    return messages;
  }

  return messages.slice(markerIndex + 1);
}

function findRecentWindowStartIndex(messages: BaseMessage[], recentTokensToKeep: number): number {
  let tokenCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokenCount += countMessageTokens([messages[index]!]);

    if (tokenCount > recentTokensToKeep) {
      return index + 1;
    }
  }

  return 0;
}

function moveCutBeforeInvalidToolBoundary(messages: BaseMessage[], cutIndex: number): number {
  if (cutIndex <= 0 || cutIndex >= messages.length) {
    return cutIndex;
  }

  const beforeCut = messages[cutIndex - 1]!;
  const afterCut = messages[cutIndex]!;

  if (AIMessage.isInstance(beforeCut) && beforeCut.tool_calls?.length) {
    return cutIndex - 1;
  }

  if (ToolMessage.isInstance(afterCut)) {
    const toolCallId = afterCut.tool_call_id;
    const matchingAiIndex = findMatchingToolCallMessageIndex(messages, toolCallId);
    if (matchingAiIndex >= 0 && matchingAiIndex < cutIndex) {
      return matchingAiIndex;
    }
  }

  return cutIndex;
}

function findMatchingToolCallMessageIndex(messages: BaseMessage[], toolCallId: string): number {
  return messages.findIndex(
    (message) =>
      AIMessage.isInstance(message) &&
      message.tool_calls?.some((toolCall) => toolCall.id === toolCallId)
  );
}

function countMessageTokens(messages: BaseMessage[]): number {
  return messages.reduce((total, message) => total + countTextTokens(message.text), 0);
}

function countTextTokens(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}
```

- [ ] **Step 3: Run focused unit test**

Run:

```bash
npm run test:unit -- test/graph/working-memory/message-window.test.ts
```

Expected:

```text
pass
```

---

### Task 3: Working Memory Subgraph

**Files:**
- Create: `src/graph/working-memory/prompt/summarize.prompt.ts`
- Create: `src/graph/working-memory/node/prepare-summary-input.node.ts`
- Create: `src/graph/working-memory/node/summarize.node.ts`
- Create: `src/graph/working-memory/graph.ts`
- Delete: `src/graph/main/node/summarize.node.ts`
- Delete: `src/graph/main/prompt/summarize.prompt.ts`

**Interfaces:**
- Consumes:
  - `MainState`
  - `WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS`
  - `WORKING_MEMORY_RECENT_TOKENS_TO_KEEP`
  - `SUMMARY_MAX_WORDS`
- Produces:
  - `workingMemoryGraph`

- [ ] **Step 1: Create prompt**

Create `src/graph/working-memory/prompt/summarize.prompt.ts`:

```ts
import { SUMMARY_MAX_WORDS } from "@/config/constant.js";

export function getUpdateSummaryPrompt(existingSummary: string): string {
  return `
You maintain short-term working memory for the current conversation.

Existing summary:
${existingSummary || "(empty)"}

New messages to compact are provided above.

Rules:
- Update the summary so it covers both the existing summary and the new messages.
- Preserve user preferences, goals, important facts, decisions, and unresolved tasks.
- Remove duplicate or outdated details.
- Keep the summary under ${SUMMARY_MAX_WORDS} words.
- Write the summary in the same language as the conversation.
- Return only the updated summary.
`.trim();
}
```

- [ ] **Step 2: Create prepare node**

Create `src/graph/working-memory/node/prepare-summary-input.node.ts`:

```ts
import type { GraphNode } from "@langchain/langgraph";
import {
  WORKING_MEMORY_RECENT_TOKENS_TO_KEEP,
  WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS,
} from "@/config/constant.js";
import { MainState } from "@/graph/main/state.js";
import type { ContextType } from "@/graph/main/context.js";
import { prepareSummaryWindow } from "../message-window.js";

export const prepareSummaryInputNode: GraphNode<typeof MainState, ContextType> = async (state) => {
  const window = prepareSummaryWindow({
    messages: state.messages,
    summarizedThroughMessageId: state.summarizedThroughMessageId,
    triggerTokens: WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS,
    recentTokensToKeep: WORKING_MEMORY_RECENT_TOKENS_TO_KEEP,
  });

  if (!window.shouldSummarize) {
    return {
      pendingSummaryMessages: undefined,
      pendingSummaryThroughMessageId: undefined,
    };
  }

  return {
    pendingSummaryMessages: window.messagesToSummarize,
    pendingSummaryThroughMessageId: window.summarizedThroughMessageId,
  };
};
```

- [ ] **Step 3: Create summarize node**

Create `src/graph/working-memory/node/summarize.node.ts`:

```ts
import type { GraphNode } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import * as z from "zod";
import { MainState } from "@/graph/main/state.js";
import type { ContextType } from "@/graph/main/context.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";
import { getUpdateSummaryPrompt } from "../prompt/summarize.prompt.js";

const SummarySchema = z.object({
  summary: z.string().describe("The updated short-term summary."),
});

export const summarizeNode: GraphNode<typeof MainState, ContextType> = async (state) => {
  const pendingMessages = state.pendingSummaryMessages ?? [];

  if (!pendingMessages.length || !state.pendingSummaryThroughMessageId) {
    return {};
  }

  const model = getLLMProvider();
  const structuredModel = model.withStructuredOutput(SummarySchema);
  const response = await structuredModel.invoke([
    ...pendingMessages,
    new HumanMessage({
      content: getUpdateSummaryPrompt(state.summary ?? ""),
    }),
  ]);

  return {
    summary: response.summary,
    summarizedThroughMessageId: state.pendingSummaryThroughMessageId,
    pendingSummaryMessages: undefined,
    pendingSummaryThroughMessageId: undefined,
  };
};
```

- [ ] **Step 4: Create subgraph**

Create `src/graph/working-memory/graph.ts`:

```ts
import { END, START, StateGraph } from "@langchain/langgraph";
import { MainContext, type ContextType } from "@/graph/main/context.js";
import { MainState } from "@/graph/main/state.js";
import { prepareSummaryInputNode } from "./node/prepare-summary-input.node.js";
import { summarizeNode } from "./node/summarize.node.js";

function shouldSummarize(state: typeof MainState.State): "summarize" | typeof END {
  return state.pendingSummaryMessages?.length ? "summarize" : END;
}

export const workingMemoryGraph = new StateGraph(MainState, MainContext)
  .addNode("prepare_summary_input", prepareSummaryInputNode)
  .addNode("summarize", summarizeNode)
  .addEdge(START, "prepare_summary_input")
  .addConditionalEdges("prepare_summary_input", shouldSummarize, ["summarize", END])
  .addEdge("summarize", END)
  .compile();
```

- [ ] **Step 5: Remove old main summary files**

Delete:

```text
src/graph/main/node/summarize.node.ts
src/graph/main/prompt/summarize.prompt.ts
```

Use `Remove-Item` only for these two exact files.

---

### Task 4: Main Graph Integration

**Files:**
- Modify: `src/graph/main/node/agent.node.ts`
- Modify: `src/graph/main/graph.ts`

**Interfaces:**
- Consumes:
  - `selectModelInputMessages`
  - `workingMemoryGraph`
- Produces:
  - main graph routes final agent responses through working memory

- [ ] **Step 1: Update agent input selection**

Modify `src/graph/main/node/agent.node.ts`:

```ts
import type { GraphNode } from "@langchain/langgraph";
import { SystemMessage } from "@langchain/core/messages";
import { filterAllowedTools } from "@/middleware/tool_permission.middleware.js";
import { systemTools } from "@/shared/tools/index.js";
import { MainState } from "../state.js";
import { ContextType } from "../context.js";
import { getLLMProvider } from "@/shared/providers/llm.provider.js";
import { getAgentSystemPrompt } from "@/graph/main/prompt/agent.prompt.js";
import { selectModelInputMessages } from "@/graph/working-memory/message-window.js";

export const agentNode: GraphNode<typeof MainState, ContextType> = async (state, runtime) => {
  const { messages, summary, summarizedThroughMessageId } = state;

  const { userRole, userMemory, locale } = runtime.context ?? {};

  const allowedTools = filterAllowedTools(systemTools, userRole);

  const model = getLLMProvider();
  const modelWithTools = model.bindTools(allowedTools);

  const systemPrompt = getAgentSystemPrompt(summary, userMemory, locale);
  const inputMessages = selectModelInputMessages({
    messages,
    summarizedThroughMessageId,
  });

  const response = await modelWithTools.invoke([new SystemMessage(systemPrompt), ...inputMessages]);

  return {
    messages: [response],
  };
};
```

- [ ] **Step 2: Wire working memory graph**

Modify `src/graph/main/graph.ts`:

```ts
import { AIMessage } from "@langchain/core/messages";
import {
  END,
  START,
  StateGraph,
  type ConditionalEdgeRouter,
} from "@langchain/langgraph";
import { agentNode } from "./node/agent.node.js";
import { toolNode } from "./node/tool.node.js";
import { MainContext, type ContextType } from "./context.js";
import { MainState } from "./state.js";
import { getCheckpointer } from "@/shared/memories/checkpointer.js";
import { getStore } from "@/shared/memories/store.js";
import { workingMemoryGraph } from "@/graph/working-memory/graph.js";

const shouldContinue: ConditionalEdgeRouter<
  typeof MainState,
  ContextType,
  "tools" | "working_memory"
> = (state) => {
  const lastMessage = state.messages.at(-1);

  if (AIMessage.isInstance(lastMessage) && lastMessage.tool_calls?.length) {
    return "tools";
  }

  return "working_memory";
};

const checkpointer = await getCheckpointer();
const store = await getStore();
const workflow = new StateGraph(MainState, MainContext)
  .addNode("agent", agentNode)
  .addNode("tools", toolNode)
  .addNode("working_memory", workingMemoryGraph)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, ["tools", "working_memory"])
  .addEdge("tools", "agent")
  .addEdge("working_memory", END);

export const graph = workflow.compile({ checkpointer, store });
```

---

### Task 5: Final Verification

**Files:**
- Verify all files touched in Tasks 1-4.

**Interfaces:**
- Consumes complete implementation.
- Produces verified working-memory implementation.

- [ ] **Step 1: Run unit tests**

Run:

```bash
npm run test:unit
```

Expected:

```text
pass
```

- [ ] **Step 2: Run project verification**

Run:

```bash
npm test
```

Expected:

```text
> agentic-agent@1.0.0 test
> npm run build && npm run test:unit
```

Both build and unit tests must pass.

- [ ] **Step 3: Inspect git diff**

Run:

```bash
git diff --stat
```

Expected changed areas:

```text
src/config/constant.ts
src/graph/main/state.ts
src/graph/main/node/agent.node.ts
src/graph/main/graph.ts
src/graph/working-memory/**
test/graph/working-memory/message-window.test.ts
package.json
```

The pre-existing `src/shared/tools/get_current_time.tool.ts` change remains unrelated and must not be reverted or included unless explicitly requested.

---

## Self-Review

- Spec coverage: token high/low watermark, no message deletion, Agent Server checkpoint boundary, working-memory subgraph, state marker, prompt semantics, and tests are covered.
- Placeholder scan: no `TBD`, `TODO`, or generic implementation placeholders remain.
- Type consistency: `summarizedThroughMessageId`, `pendingSummaryMessages`, `pendingSummaryThroughMessageId`, `selectModelInputMessages`, `prepareSummaryWindow`, and `workingMemoryGraph` are named consistently across tasks.
