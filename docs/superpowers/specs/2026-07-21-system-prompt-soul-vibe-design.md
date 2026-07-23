# System Prompt And Store-Backed SOUL Design

> Superseded by `docs/superpowers/specs/2026-07-22-store-backed-system-prompt-design.md`.
> The older file-based `SOUL.md` write design below is obsolete and must not be used for implementation.

Date: 2026-07-21
Scope: System prompt composition and the first prompt-facing learning tool for the TypeScript LangGraph agent.

## Purpose

This spec defines the first system prompt foundation for the agent. The goal is to build a stable OpenClaw-style prompt assembly from bootstrap files and add one narrow learning surface: updating the learned `Vibe` section in `SOUL.md`.

This phase does not implement long-term memory read/write, vector search, background memory extraction, or database persistence. It only establishes prompt composition and a controlled soul management tool group that can read `SOUL.md` and update the prompt-facing `Vibe` layer.

## Current State

The project already has prompt files under `src/workflow/main/prompt`:

- `SOUL.md`
- `AGENT.md`
- `system.prompt.ts`
- `store.prompt.ts`

`SOUL.md` contains an OpenClaw-style identity template with `Core Truths`, `Boundaries`, and `Vibe`. `AGENT.md` and `store.prompt.ts` are empty. `agent.node.ts` still creates a hardcoded `SystemMessage("You are a helpful assistant.")`.

The current implementation therefore does not yet use the prompt files as the runtime system prompt.

## Design Principles

`SOUL.md` is the agent identity file. It defines who the agent is and how it should feel to interact with.

`AGENT.md` is the runtime behavior file. It defines how the agent should operate in this application: language behavior, tool-use expectations, safety constraints, and boundaries between one-turn instructions and durable learned behavior.

`system.prompt.ts` is a pure prompt composer. It reads the prompt source files and returns the final system prompt text used by `agent.node.ts`.

`store.prompt.ts` defines the prompt/rules used by the learned `Vibe` update workflow. It does not own file I/O, memory storage, memory namespaces, retrieval, or long-term memory classification.

Future long-term memory implementation belongs under the `memory/` capability boundary. Prompt files may describe how prompt-facing learning should behave, but they must not become the home for semantic, episodic, procedural, snapshot, recall, or memory-store code.

The first learned prompt state is limited to `Vibe`. The tool must not update `Core Truths`, `Boundaries`, `Continuity`, `AGENT.md`, or any tool/security policy.

## SOUL.md Contract

`SOUL.md` should contain these sections:

- `Core Truths`: stable identity principles. Static.
- `Boundaries`: privacy and safety boundary. Static.
- `Vibe`: personality, tone, and interaction style. Partly learned.
- `Continuity`: short explanation that the learned `Vibe` can evolve through interaction. Static.

Only this bounded block can be machine-updated:

```md
<!-- LEARNED_VIBE_START -->
...
<!-- LEARNED_VIBE_END -->
```

The update tool fails if the block is missing, duplicated, or malformed.

## AGENT.md Contract

`AGENT.md` should define runtime behavior, not personality. It should cover:

- The agent replies in Vietnamese by default.
- English is allowed for class names, methods, properties, file paths, commands, and code snippets.
- The agent should be direct and concrete.
- The agent should avoid flattery and filler.
- Tool calls should be used only when they serve the user request.
- The agent may learn durable interaction style into `Vibe`, but must not learn secrets or unsafe policy changes.
- The agent should treat one-turn instructions as temporary unless the user expresses durable intent.
- Prompt-facing learning is limited to `Vibe`; semantic, episodic, procedural, recall, and snapshot memory belong to the future `memory/` module.

`AGENT.md` is not auto-updated by the first learning tool.

## System Prompt Composition

`system.prompt.ts` should expose a function, not only exported constants. The composer should read `SOUL.md` and `AGENT.md`, then return a single system prompt string.

Expected section order:

```text
<SOUL>
...
</SOUL>

<AGENT>
...
</AGENT>

<RUNTIME_CONTEXT>
...
</RUNTIME_CONTEXT>
```

The runtime context may include values already validated by the graph context guardrail, such as `userId`, `timeZone`, and `locale`. The composer should not validate context. Validation remains owned by `guardrail`.

`agent.node.ts` should call the composer and pass `new SystemMessage(systemPrompt)` into the model invocation instead of using the hardcoded helpful-assistant prompt.

## manage_soul Tool Group

Soul prompt tools should live together in one capability-level file, following the same pattern as `src/tools/system/tavily.tool.ts`.

The file should be:

```text
src/tools/system/manage-soul.tool.ts
```

This file should export individual tools and one grouped array:

```ts
export const getSoulTool = ...
export const updateSoulVibeTool = ...
export const manageSoulTools = [getSoulTool, updateSoulVibeTool];
```

The first soul tools are:

```text
get_soul
update_soul_vibe
```

`get_soul` reads the current `SOUL.md` content for inspection/debugging.

`update_soul_vibe` updates only the learned `Vibe` block in `SOUL.md`. It should accept concise learned vibe guidance, normalize it into a bounded bullet list, and rewrite only the text between `LEARNED_VIBE_START` and `LEARNED_VIBE_END`.

`update_soul_vibe` does not require user approval. This is safe only because the writable surface is narrow and prompt-facing.

The soul tool group must be registered through the same tool registry and guardrail path as every other tool. It must not bypass `resolveTools` or create a separate ad hoc tool injection path. If runtime enablement needs to be configurable, add a condition flag and register the tool group with that flag.

Suggested group shape:

```ts
{
  name: "prompt",
  tools: manageSoulTools,
  isEnabled: promptLearningEnabled,
}
```

The first implementation can use an always-on condition only if it still flows through the guardrail API:

```ts
isEnabled: () => true
```

`update_soul_vibe` must reject:

- Attempts to update `Core Truths`, `Boundaries`, `Continuity`, `AGENT.md`, or system/tool policy.
- Secrets, credentials, tokens, private keys, or API keys.
- One-turn instructions.
- Business/domain facts that belong in semantic memory.
- Events/decisions that belong in episodic memory.
- Workflow rules that belong in procedural memory or guardrails.
- Instructions that weaken safety, privacy, permission, or tool constraints.

After a successful update, the agent should report the change briefly:

```text
Đã cập nhật Vibe: <summary>.
```

## Namespace Convention For Future Store Integration

This phase does not write to LangGraph Store, but the prompt-facing learned state should align with the future namespace contract.

Prompt-facing `Vibe` state:

```ts
["users", userId, "agents", agentId, "prompt", "soul", "vibe"]
```

Long-term memory state:

```ts
["users", userId, "memory", "semantic"]
["users", userId, "memory", "episodic"]
["users", userId, "memory", "procedural"]
["users", userId, "memory", "snapshot"]
```

`thread_id` must not be part of long-term memory namespaces. If traceability is needed later, store `sourceThreadId` in item metadata.

## Write Semantics

The prompt-facing `Vibe` update is a bounded patch, not append-only.

Future write semantics should be:

- `semantic`: upsert or merge by stable key.
- `episodic`: append-only event records.
- `procedural`: upsert or replace by rule domain.
- `snapshot`: overwrite the `current` compiled view.
- `prompt/soul/vibe`: patch bounded learned section.

This prevents prompt bloat, duplicate learned behavior, and conflicting durable instructions.

## Data Flow

Runtime response flow:

```text
agent.node.ts
  -> validateContext(config.context)
  -> buildMainSystemPrompt(context)
  -> model.invoke([SystemMessage, ...messages], config)
```

Learning flow:

```text
agent decides a durable style update is needed
  -> calls update_soul_vibe
  -> tool call is available only through tool-registry + guardrail resolution
  -> tool validates scope
  -> tool rewrites only learned Vibe block
  -> agent reports update briefly
```

## Error Handling

The prompt composer should fail clearly when required prompt files cannot be read.

`get_soul` should return a clear rejected result when `SOUL.md` cannot be read.

`update_soul_vibe` should return a clear rejected result when:

- The learned `Vibe` markers are missing.
- Multiple marker pairs are found.
- The proposed update is empty after normalization.
- The proposed update contains out-of-scope content.
- The file write fails.

The tool should not silently create a new `SOUL.md` if the file is missing.

## Testing

Add focused tests for:

- The prompt composer includes both `SOUL.md` and `AGENT.md`.
- The prompt composer includes runtime context fields in a deterministic format.
- The update tool rewrites only the learned `Vibe` block.
- The update tool rejects missing or duplicate markers.
- The update tool rejects out-of-scope content.
- The tool registry exposes `get_soul` and `update_soul_vibe` only through the normal guardrail-enabled group resolution path.

Run `npm test` after implementation. No runtime server validation is required for this phase unless prompt/tool registration causes a graph loading failure.

## Out Of Scope

- LangGraph Store persistence.
- MongoDB/Postgres memory implementation.
- A `memory/` module implementation.
- `semantic`, `episodic`, or `procedural` memory writing.
- Background memory graph.
- Memory snapshot rebuild.
- Vector search or recall.
- User approval workflow for `Vibe` updates.

## Acceptance Criteria

- `agent.node.ts` no longer uses the hardcoded helpful-assistant system prompt.
- `SOUL.md` contains a machine-managed learned `Vibe` block.
- `AGENT.md` contains runtime behavior rules.
- `system.prompt.ts` composes the final system prompt from prompt files and runtime context.
- `get_soul` can read the current `SOUL.md` content.
- `update_soul_vibe` can update only the learned `Vibe` block.
- Soul tools are implemented in `src/tools/system/manage-soul.tool.ts`.
- `manageSoulTools` is registered through the normal tool guardrail path.
- `store.prompt.ts` remains prompt-scoped and does not contain memory-store logic.
- Tests cover composer behavior and marker-safe `Vibe` updates.
