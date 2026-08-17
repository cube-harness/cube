# Tool Approval, Markdown Tool Output, and Lazy Threads

Date: 2026-08-14

> Thread startup and log identity in this document are superseded by
> `2026-08-16-thread-log-identity-design.md`. The approval and tool-rendering
> sections remain historical phase design.

## Goal

Correct Cube's approval resume path, render tool activity as structured Markdown,
and start each CLI process with a fresh conversation without creating additional
empty database threads merely because the process was opened.

## Scope

This change covers three related runtime/UI behaviors:

1. Respond to `tool_approval_required` through the AgentController approval gate.
2. Render tool commands and results with pi-tui's Markdown component.
3. Use a lazy fresh-thread lifecycle on CLI startup and provide `/new` for an
   explicit thread transition.

It does not add a tool `reason` argument, a thread history picker, rename/delete
thread commands, or change global model ownership.

## Approval flow

Cube renders the live agent state from `session.displayState`. It subscribes to
`display_state_changed` instead of rebuilding tool state from raw
`tool_start`, `tool_update`, `shell_output`, and `tool_end` events.

When `displayState.pendingApproval` is present and
`session.approval.isArmed()` is true, Cube stops the Working indicator and shows
the inline `Approve / Decline` selector below the prompt. The prompt remains
unfocused until the user chooses.

The decision will be sent through:

```ts
session.respondToToolApproval({
  decision: approved ? "approve" : "decline",
  toolCallId,
});
```

This resolves the approval promise owned by the still-active `followUp()` run.
Cube must not call `approveToolCall()` or `declineToolCall()` directly for this
live event. Those lower-level methods bypass the live approval gate and can
execute the tool while leaving the original UI run waiting.

After a decision, `session.approval.isArmed()` becomes false and Working follows
`displayState.isRunning` again. `runAgentTurn` and its independent Working state
are removed; `displayState` is the sole source of live run status.

## Tool rendering

Assistant and tool messages both use pi-tui's `Markdown` component, with their
own role colors. The TUI receives Mastra's generic active-tool fields (`name`,
`args`, `status`, `partialResult`, `result`, and `shellOutput`) and presents
them without recognizing individual tool names. Tool presentation uses this
structure:

````md
**mastra_workspace_execute_command**

```shell
node -e "..."
```

```text
command output
```

Completed.
````

Arguments remain visible before approval and throughout running and completion
states. Shell output is taken directly from `ActiveToolState.shellOutput`; Cube
does not check for `mastra_workspace_execute_command` or any other tool ID.
Long Markdown-rendered lines must remain within the terminal width.

The approval selector itself continues to use the native pi-tui `SelectList`
and plain themed detail lines; it is inline below the prompt, not an overlay.

## Lazy fresh-thread lifecycle

Every new CLI process represents a fresh conversation. Mastra's
`createSession()` always binds the most recent thread or creates one when none
exists, so Cube implements freshness as a logical pending-new state without
creating an additional thread at startup.

Calling `createSession()` with a random `id` does not select a new conversation:
for the same `resourceId`, Mastra uses the resource's session and binds its most
recent thread. Thread creation is therefore an explicit conversation lifecycle
operation, not a side effect of Cube's process/session UUID.

The empty-thread branch is not the normal steady-state path. It exists only for
bootstrap (Mastra must create an initial thread when storage has none), an
explicit `/new` followed by exit before a prompt, and empty legacy rows created
before this lifecycle existed. Once a normal first prompt succeeds, subsequent
process launches bind a non-empty latest thread and create exactly one new
thread only when that process receives its first prompt.

Startup behavior:

- The UI displays `new thread`.
- Cube inspects the thread bound by `createSession()`.
- If that thread already has messages, it is hidden as a pending-new
  conversation and is not used for the process's first user turn.
- If that thread is empty, Cube reuses it as the pending fresh conversation.
- Slash commands such as `/model` and `/exit` do not create a thread.
- `/compact` reports that there is no active thread until the process has a
  conversation thread.

First prompt behavior:

1. Reuse the bound thread when it is empty; otherwise create and switch to one
   new thread through `session.thread.create()`.
2. Update the displayed thread ID.
3. Send the prompt through `session.followUp()`.

If thread creation fails, the prompt is not sent and the error is shown. A retry
may try thread creation again. Concurrent submissions share the same in-flight
creation promise so one first prompt cannot create multiple threads.

`/new` behavior:

- Reject the command with an actionable message while an agent turn is active;
  do not abort the active run.
- Otherwise create and switch to a new thread immediately.
- Clear the visible transcript and update the displayed thread ID.
- Repeated explicit `/new` calls may create multiple empty threads; this is an
  intentional user action, unlike passive process startup.

Cube does not automatically delete legacy empty threads. They are harmless to
selection once a newer populated thread exists, and deleting persisted history
is outside this runtime fix. Any cleanup must be a separate explicit operation.

`/exit` only closes Cube and storage. It neither creates nor deletes a thread.
On the next process, the lazy fresh-thread behavior applies again.

## Ownership

- Mastra `session.displayState`: owns current message, active tool, approval,
  output, status, and running state reduction.
- `cube-cli/src/index.ts`: coordinates startup lifecycle, forwards
  `display_state_changed` snapshots to the TUI, sends approval decisions, and
  handles thread creation.
- `cube-cli/src/slash-commands/new.slash-command.ts`: implements `/new` guards
  and output contract.
- `cube-cli/src/slash-commands/registry.ts`: owns `/new` metadata and handler.
- `cube-tui/src/components/message-list.ts`: generically renders assistant and
  active-tool snapshot data as Markdown.
- Existing `ApprovalPicker` remains the inline decision component.

`cube-cli/src/tool-display.ts`, its test, `cube-cli/src/turn-runner.ts`, and its
test are removed. Cube does not add an agent-side tool presentation registry.

## Verification

Automated tests must prove:

- An approval decision calls `respondToToolApproval`, not the lower-level resume
  APIs.
- `displayState.isRunning` drives Working; an armed approval temporarily hides
  it; deciding resumes it; agent completion stops it.
- `display_state_changed` upserts current assistant/tool content without a
  parallel raw-event tool reducer.
- Generic tool arguments and results render as Markdown code blocks and do not
  exceed the viewport width.
- No Cube source compares a tool name to
  `mastra_workspace_execute_command`.
- Repeated startup and exit without a prompt do not increase the thread count.
- The first prompt reuses a bound empty thread or creates exactly one new thread
  before `followUp()` when the hydrated thread contains history.
- Concurrent first submissions do not create duplicate threads.
- `/model` and `/exit` before the first prompt create no thread.
- `/new` creates and switches immediately, clears messages, and rejects while a
  turn is active.
- The recursive test suite, forced TypeScript build, and CLI syntax check pass.

Runtime verification should use a harmless approved command and confirm the
sequence `Waiting for approval` -> `Running` -> output -> `Completed`, followed
by the assistant response. After storage has its initial Mastra-bound thread,
opening and exiting Cube without a prompt must leave the thread count unchanged.
