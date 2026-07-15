# Working Memory Design

Date: 2026-07-15
Scope: short-term working memory for the TypeScript LangGraph main agent.

## Goal

Implement short-term working memory as:

```text
LLM input = system prompt(summary, userMemory, locale) + unsummarized recent messages
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

- compute recent unsummarized messages for model input;
- preserve valid message boundaries for tool calls and tool results;
- compute the unsummarized working segment after `summarizedThroughMessageId`;
- decide when that segment has crossed the high token watermark;
- select the older part to summarize while preserving the low token watermark as recent raw context;
- exclude messages already covered by `summarizedThroughMessageId`;

This belongs under `graph/working-memory`, not a generic utility folder, because it is domain policy rather than a generic helper.

### `prepare-summary-input.node.ts`

Deterministic node. It does not call an LLM.

Responsibilities:

- determine which older messages in the unsummarized segment should be compacted;
- select only unsummarized messages that should be compacted into summary;
- enforce the token high/low watermark policy;
- skip summary when there is no safe compaction delta;
- prepare the delta messages for `summarize.node.ts`.

### `summarize.node.ts`

LLM node.

Responsibilities:

- receive existing `summary`;
- receive newly compactable messages prepared by the previous node;
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

## Token Watermarks

`agent.node.ts` must invoke the model with the unsummarized working segment, not raw full history:

```text
model input = SystemMessage(prompt with summary) + unsummarizedRecentMessages
```

Use token watermarks for the working segment:

```ts
WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS
WORKING_MEMORY_RECENT_TOKENS_TO_KEEP
```

`WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS` is the high watermark. When unsummarized messages exceed it, working memory summarizes the older part.

`WORKING_MEMORY_RECENT_TOKENS_TO_KEEP` is the low watermark. After summarization, the graph keeps about this much recent raw context outside the summary.

Token counts measure context size. They must not cut inside message content. The implementation should preserve whole messages and valid tool-call pairing.

Example:

```text
"tôi là phạm hoài phúc"
```

If this message is retained, it remains intact. It must not become:

```text
"tôi là phạm hoài"
```

## Summary Semantics

The summary represents old context already compacted out of the unsummarized working segment.

Example:

```text
Full messages:              A B C D E F G H I J K L M N O P
Existing summary covers:    A B C D
Unsummarized segment:               E F G H I J K L M N O P

If the unsummarized segment crosses the high token watermark:

Summarize delta:                    E F G H
Keep recent raw context:                    I J K L M N O P
Updated summary covers:     A B C D E F G H
```

The summary LLM receives:

```text
existing summary + newly compactable messages
```

It does not receive all raw messages from the beginning of the thread. It receives the previous compressed summary plus only the older unsummarized messages being compacted in this cycle.

## Trigger Rules

Summarization must be high/low watermark-based, not triggered by every single new message.

Run `summarize.node.ts` only when:

- the latest agent message is final and has no `tool_calls`;
- unsummarized messages after `summarizedThroughMessageId` exceed `WORKING_MEMORY_SUMMARY_TRIGGER_TOKENS`;
- there are older unsummarized messages that can be summarized while retaining `WORKING_MEMORY_RECENT_TOKENS_TO_KEEP` as recent raw context;
- the selected delta does not break tool-call / tool-result pairing;
- the graph is not in the middle of an interrupt boundary.

If preserving whole message and tool-call boundaries means keeping slightly more than the low watermark, prefer valid history over an exact token number.

## Non-Goals

- Do not implement long-term memory extraction in this phase.
- Do not write to Store from working-memory summary code.
- Do not add a generic `src/utility` module for working-memory policy.
- Do not delete checkpoint messages with `RemoveMessage`.
- Do not create a custom API server for this feature.

## Testing Strategy

Add focused tests for deterministic boundary logic:

- token watermark selection keeps whole messages;
- tool-call and tool-result pairs are not split;
- no summary runs until the high token watermark is crossed;
- delta summary selects only messages after `summarizedThroughMessageId`;
- the Vietnamese message `"tôi là phạm hoài phúc"` is not truncated when retained.

Run `npm test` after implementation.
