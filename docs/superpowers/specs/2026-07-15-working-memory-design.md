# Working Memory Design

Date: 2026-07-15
Scope: short-term working memory for the TypeScript LangGraph main agent.

## Goal

Implement short-term working memory as:

```text
LLM input = system prompt(summary, userMemory, locale) + active recent messages
```

The graph must keep full `state.messages` in checkpoint history. Working memory limits only the messages sent into model calls. It must not delete checkpoint messages with `RemoveMessage`.

## Runtime Boundary

The project uses LangGraph Agent Server as the runtime. Agent Server owns thread state and checkpoint persistence. Graph code should return normal state updates and should not call checkpointer APIs directly.

Working memory is thread-local short-term context. It is separate from long-term memory extraction and Store writes.

## Main Graph Boundary

Keep the main graph thin:

```text
START -> agent
agent -> tools      when the agent emits tool_calls
tools -> agent
agent -> working_memory after a final AIMessage
working_memory -> END
agent -> END        when working_memory is skipped
```

`agent.node.ts` remains responsible for model invocation. It should not know how summary deltas are selected.

## Working Memory Subgraph

Create a dedicated working-memory subgraph:

```text
src/graph/working-memory/graph.ts
src/graph/working-memory/message-window.ts
src/graph/working-memory/node/prepare-summary-input.node.ts
src/graph/working-memory/node/summarize.node.ts
src/graph/working-memory/prompt/summarize.prompt.ts
```

### `message-window.ts`

Owns the working-memory policy shared by `agent.node.ts` and the working-memory subgraph:

- compute active recent messages for model input;
- preserve valid message boundaries for tool calls and tool results;
- compute messages that have fallen outside the active window;
- exclude messages already covered by `summarizedThroughMessageId`;
- apply batch thresholds before summarization.

This belongs under `graph/working-memory`, not a generic utility folder, because it is domain policy rather than a generic helper.

### `prepare-summary-input.node.ts`

Deterministic node. It does not call an LLM.

Responsibilities:

- determine which messages are outside the active context window;
- select only unsummarized evicted messages;
- enforce the summary batch threshold;
- skip summary when there is no safe batch;
- prepare the delta messages for `summarize.node.ts`.

### `summarize.node.ts`

LLM node.

Responsibilities:

- receive existing `summary`;
- receive newly evicted messages prepared by the previous node;
- update the summary so it covers both the previous summary and the new delta;
- update `summarizedThroughMessageId` to the last message covered by the summary.

It must not summarize the entire raw history again.

## State

Extend `MainState` with:

```ts
summary?: string;
summarizedThroughMessageId?: string;
```

If implementation needs transient fields for handoff inside the working-memory subgraph, name them clearly, for example:

```ts
pendingSummaryMessages?: BaseMessage[];
pendingSummaryThroughMessageId?: string;
```

Do not persist these transient fields unless LangGraph requires them for subgraph state handoff. If persisted fields are required, clear them after `summarize.node.ts`.

## Active Window

`agent.node.ts` must invoke the model with active messages, not raw full history:

```text
model input = SystemMessage(prompt with summary) + activeMessages
```

Use token budget for the active window. Token budget measures context size; it must not cut inside message content. The implementation should preserve whole messages and valid tool-call pairing.

Example:

```text
"tôi là phạm hoài phúc"
```

If this message is retained, it remains intact. It must not become:

```text
"tôi là phạm hoài"
```

## Summary Semantics

The summary represents old context that has fallen outside the active window.

Example:

```text
Full messages:     A B C D E F G H I J K L
Active window:             I J K L
Existing summary:  A B C D E F
New delta:                 G H
Updated summary:   A B C D E F G H
```

The summary LLM receives:

```text
existing summary + newly evicted messages
```

It does not receive all raw messages from the beginning of the thread.

## Trigger Rules

Summarization must be batch-based, not triggered by every single message that falls out of the active window.

Run `summarize.node.ts` only when:

- the latest agent message is final and has no `tool_calls`;
- enough unsummarized evicted messages have accumulated;
- the selected delta does not break tool-call / tool-result pairing;
- the graph is not in the middle of an interrupt boundary.

The first implementation should prefer simple thresholds:

```ts
WORKING_MEMORY_ACTIVE_WINDOW_TOKENS
WORKING_MEMORY_SUMMARY_BATCH_MESSAGES
```

Token thresholding can be added to the batch trigger later if message count proves too coarse.

## Non-Goals

- Do not implement long-term memory extraction in this phase.
- Do not write to Store from working-memory summary code.
- Do not add a generic `src/utility` module for working-memory policy.
- Do not delete checkpoint messages with `RemoveMessage`.
- Do not create a custom API server for this feature.

## Testing Strategy

Add focused tests for deterministic boundary logic:

- active window keeps whole messages;
- tool-call and tool-result pairs are not split;
- no summary runs until batch threshold is met;
- delta summary selects only messages after `summarizedThroughMessageId`;
- the Vietnamese message `"tôi là phạm hoài phúc"` is not truncated when retained.

Run `npm test` after implementation.
