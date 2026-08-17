# Lazy Thread and Log Identity

Date: 2026-08-16

## Goal

Reserve one UUID when Cube starts, use it for the run log immediately, and
persist a conversation thread with that exact UUID only when the first prompt
is submitted. Starting and exiting Cube without a prompt must not leave a new
conversation thread.

## Reserved identity

Cube allocates one planned thread identity:

```ts
const threadId = randomUUID();
```

The value is used immediately for `SessionRecord.id`, the logger name, the
structured `threadId` log field, and `logs/agent-${threadId}.json`. It is passed
later to `session.thread.create({ id: threadId })`, so every conversation log
maps to the persisted thread created for that run.

## Startup flow

Cube calls `controller.createSession()` without its `threadId` option. Mastra
requires a bound thread and therefore selects the most recent stored thread or
creates an empty bootstrap thread when storage has none.

Cube immediately normalizes that binding:

- a populated historical thread is detached and its lock is released;
- an empty bound/bootstrap thread is deleted;
- the session finishes startup with `session.thread.getId() === null`;
- the TUI displays `new thread`.

Historical populated threads are never deleted. The empty-thread deletion only
removes the thread Mastra bound to the fresh process before Cube has accepted a
prompt. This phase assumes one Cube CLI process per workspace.

## First-prompt flow

`createSessionSoul()` receives the planned UUID. After SOUL validation succeeds
and no thread is active, it calls:

```ts
session.thread.create({ id: plannedThreadId });
```

It snapshots `SOUL.md` into that thread, then the CLI sends the prompt. If the
SOUL snapshot cannot be persisted, the newly created thread is deleted as an
incomplete conversation. Later prompts reuse the same thread and stored SOUL.

The `thread_created` event updates the TUI from `new thread` to the real UUID.
The first prompt creates exactly one thread, and its UUID equals the run-log ID.

## Close flow

Close only destroys the controller/workspace and closes storage/logger. It does
not perform a global empty-thread scan and does not delete the active
conversation. When no prompt was submitted, the startup normalization already
left the session unbound, so close has no conversation thread to remove.

## Scope

This correction does not implement `/new`, thread history selection, tool
approval, log rotation, or concurrent CLI processes. It adds no production
lifecycle file or dependency.

## Verification

Tests and runtime smoke must prove:

- structured logs and filenames use the reserved UUID;
- populated historical threads are detached, not deleted;
- Mastra's empty bound/bootstrap thread is deleted at startup;
- startup ends with no active thread;
- `preparePrompt()` creates a thread with the reserved UUID;
- the first prompt increases thread count exactly once and updates the TUI ID;
- open plus close without a prompt leaves no new conversation thread;
- recursive tests and the full TypeScript build pass.
