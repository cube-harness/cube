# Session Display State and Lazy Threads Implementation Plan

> Task 3 thread lifecycle is superseded by
> `../specs/2026-08-16-thread-log-identity-design.md` and
> `2026-08-16-thread-log-identity.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Mastra's canonical Session display state in Cube, resume live approvals correctly, and create fresh conversations lazily without empty-thread spam.

**Architecture:** Mastra `session.displayState` is the only reducer for message, tool, approval, output, and running state. `cube-cli` forwards snapshots and decisions; `cube-tui` generically renders snapshot fields without recognizing tool IDs. Thread lifecycle remains a small CLI concern because it controls when persisted conversations are created.

**Tech Stack:** TypeScript 5.7, Node.js 22, Mastra `@mastra/core` 1.56.0, pi-tui 0.83.0, pnpm workspaces.

## Global Constraints

- Subscribe to `display_state_changed`; do not rebuild tool state from raw tool events.
- Use `session.respondToToolApproval()` and `session.approval.isArmed()` for approval.
- `displayState.isRunning` is the sole run-state source for Working.
- Tool rendering is generic over `name`, `args`, `status`, `partialResult`, `result`, and `shellOutput`; never compare a tool-name string.
- Remove `cube-cli/src/tool-display.ts`, `cube-cli/src/turn-runner.ts`, and their tests.
- Startup, `/model`, `/compact`, and `/exit` must not create an additional thread.
- `/new` creates immediately and rejects without aborting while a turn is active.
- Do not delete legacy empty threads, change global model ownership, or add dependencies.
- `D:\cube` is not a Git worktree; record file/test checkpoints instead of commits.

---

### Task 1: Render generic Mastra display snapshots in pi-tui

**Files:**
- Modify: `cube-tui/src/components/message-list.ts`
- Modify: `cube-tui/src/components/message-list.test.ts`
- Modify: `cube-tui/src/index.ts`
- Modify: `cube-tui/src/index.test.ts`

**Interfaces:**
- Consumes: a structural snapshot containing `isRunning`, `approvalPending`, `currentMessage`, and an array of active tools.
- Produces: `MessageList.upsertMessage()`, `MessageList.upsertTool()`, and `app.renderAgentDisplay(snapshot)`.

- [ ] **Step 1: Add failing MessageList tests**

Add tests that call the desired public API with an arbitrary tool name:

```ts
test("upserts generic tool state as Markdown without tool-name branches", () => {
  const messages = new MessageList();
  messages.upsertTool({
    id: "call-1",
    name: "arbitrary_external_tool",
    args: { command: "Get-Date" },
    status: "completed",
    shellOutput: "16:40:12\n",
  });
  const output = messages.render(80).join("\n");
  assert.match(output, /arbitrary_external_tool/);
  assert.match(output, /Get-Date/);
  assert.match(output, /16:40:12/);
  assert.doesNotMatch(output, /```/);
});

test("keeps generic tool Markdown inside the viewport", () => {
  const messages = new MessageList();
  messages.upsertTool({
    id: "call-2",
    name: "external_tool",
    args: { value: "a-very-long-token-without-spaces-that-must-wrap" },
    status: "running",
  });
  assert.equal(messages.render(30).every((line) => visibleWidth(line) <= 30), true);
});
```

The production mutation caught by these tests is restoring the plain-text tool path or adding a name-specific branch.

- [ ] **Step 2: Run the MessageList tests and verify RED**

Run outside the sandbox because `tsx`/esbuild requires child-process spawn:

```powershell
.\node_modules\.bin\tsx.cmd --test --test-isolation=none cube-tui\src\components\message-list.test.ts
```

Expected: TypeScript/runtime failure because `upsertTool` does not exist.

- [ ] **Step 3: Implement generic upsert/render APIs**

Add these structural types to `message-list.ts`:

```ts
export interface DisplayTool {
  id: string;
  name: string;
  args: unknown;
  status: "streaming_input" | "waiting_approval" | "running" | "completed" | "error";
  partialResult?: string;
  result?: unknown;
  shellOutput?: string;
}
```

Implement `upsertMessage()` by updating an existing ID or adding it, and implement `upsertTool()` by serializing arbitrary values with `JSON.stringify(value, null, 2)` plus a circular-value fallback. Build Markdown using only generic fields:

```md
**tool-name**

```json
{"input":"value"}
```

```text
output
```

Completed.
```

Select output in this order: `shellOutput`, `partialResult`, `result`. Map statuses to `Reading input...`, `Waiting for approval...`, `Running...`, `Completed.`, and `Failed.`. Render both assistant and tool roles through pi-tui `Markdown` using their role colors.

- [ ] **Step 4: Add a failing app-level snapshot test**

Add to `cube-tui/src/index.test.ts`:

```ts
test("renders one canonical agent display snapshot", () => {
  const app = createApp(() => undefined, [], terminal);
  app.renderAgentDisplay({
    isRunning: true,
    approvalPending: false,
    currentMessage: {
      id: "assistant-1",
      content: "Working on it",
      status: "streaming",
    },
    activeTools: [{
      id: "call-1",
      name: "arbitrary_tool",
      args: { input: "value" },
      status: "running",
    }],
  });
  assert.match(app.workingIndicator.render(80).join("\n"), /Working/);
  assert.deepEqual(app.messageList.getMessages().map(({ id }) => id), [
    "assistant-1",
    "call-1",
  ]);
});
```

Add a second test with `isRunning: true, approvalPending: true` and assert Working renders nothing.

- [ ] **Step 5: Implement `renderAgentDisplay`**

Define `AgentDisplaySnapshot` in `cube-tui/src/index.ts` using `DisplayTool`. Implement:

```ts
renderAgentDisplay: (snapshot: AgentDisplaySnapshot) => {
  setWorking(snapshot.isRunning && !snapshot.approvalPending);
  if (snapshot.currentMessage) {
    messageList.upsertMessage({
      ...snapshot.currentMessage,
      role: "assistant",
    });
  }
  for (const tool of snapshot.activeTools) messageList.upsertTool(tool);
  tui.requestRender();
},
```

- [ ] **Step 6: Run TUI tests and verify GREEN**

Run:

```powershell
pnpm --filter @cube/tui test
```

Expected: all TUI tests pass with no line exceeding its viewport.

---

### Task 2: Replace Cube's raw tool reducer with Session display state

**Files:**
- Delete: `cube-cli/src/tool-display.ts`
- Delete: `cube-cli/src/tool-display.test.ts`
- Delete: `cube-cli/src/turn-runner.ts`
- Delete: `cube-cli/src/turn-runner.test.ts`
- Delete: `cube-cli/src/tool-approval.test.ts`
- Create: `cube-cli/src/approval-flow.ts`
- Create: `cube-cli/src/approval-flow.test.ts`
- Modify: `cube-cli/src/index.ts`

**Interfaces:**
- Consumes: Mastra `display_state_changed`, `session.displayState.get()`, `session.approval.isArmed()`, and `session.respondToToolApproval()`.
- Produces: `runApprovalFlow(options): Promise<void>` and structural `AgentDisplaySnapshot` calls into the TUI.

- [ ] **Step 1: Write the failing approval-flow tests**

Create `approval-flow.test.ts` with a deferred picker and assert:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { runApprovalFlow } from "./approval-flow.js";

test("responds to the armed gate and resumes Working", async () => {
  const working: boolean[] = [];
  const responses: unknown[] = [];
  await runApprovalFlow({
    toolCallId: "call-1",
    requestDecision: async () => true,
    respond: (response) => { responses.push(response); },
    setWorking: (value) => { working.push(value); },
    isRunning: () => true,
  });
  assert.deepEqual(responses, [{ decision: "approve", toolCallId: "call-1" }]);
  assert.deepEqual(working, [true]);
});
```

Add a decline test expecting `{ decision: "decline", toolCallId: "call-2", declineContext: { reason: "Declined by user" } }`.

- [ ] **Step 2: Verify approval tests RED**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --test --test-isolation=none cube-cli\src\approval-flow.test.ts
```

Expected: module-not-found for `approval-flow.js`.

- [ ] **Step 3: Implement the minimal approval flow**

`runApprovalFlow()` awaits the boolean decision, calls the supplied synchronous `respond()` once, then calls `setWorking(isRunning())`. It never calls lower-level approve/decline APIs and never stops Working in a `finally` block.

- [ ] **Step 4: Replace raw event interpretation in `index.ts`**

Remove `ToolView`, `toolViews`, `declinedToolCalls`, `renderToolView`, `appendToolOutput`, `formatTool*`, `runAgentTurn`, and every raw tool-event branch.

For `display_state_changed`, structurally forward the snapshot:

```ts
const snapshot = event.displayState;
app.renderAgentDisplay({
  isRunning: snapshot.isRunning,
  approvalPending: session.approval.isArmed(),
  currentMessage: snapshot.currentMessage && messageRole(snapshot.currentMessage) === "assistant"
    ? {
        id: snapshot.currentMessage.id,
        content: messageText(snapshot.currentMessage),
        status: snapshot.isRunning ? "streaming" : "done",
      }
    : null,
  activeTools: Array.from(snapshot.activeTools, ([id, tool]) => ({
    id,
    name: tool.name,
    args: tool.args,
    status: snapshot.pendingApproval?.toolCallId === id
      ? "waiting_approval" as const
      : tool.status,
    partialResult: tool.partialResult,
    result: tool.result,
    shellOutput: tool.shellOutput,
  })),
});
```

Keep raw-event branches only for transitions not represented in the rendered snapshot: `model_changed`, `info`, and `error`.

When `snapshot.pendingApproval` is armed and its ID is not already being handled, open one picker with generic JSON argument lines and call `runApprovalFlow()`. Retain the handled ID until `pendingApproval` becomes null so subsequent snapshots cannot open a duplicate picker.

Send normal prompts with `await session.followUp({ content })`; Working is no longer set by the submission wrapper.

- [ ] **Step 5: Delete obsolete reducers and run CLI tests**

Delete the four obsolete production/test files plus the interrupted `tool-approval.test.ts`, then run:

```powershell
pnpm --filter @cube/cli test
```

Expected: all CLI tests pass and no source file contains a comparison against a tool-name literal.

---

### Task 3: Add lazy process conversations and `/new`

**Files:**
- Create: `cube-cli/src/thread-lifecycle.ts`
- Create: `cube-cli/src/thread-lifecycle.test.ts`
- Modify: `cube-cli/src/slash-commands/new.slash-command.ts`
- Create: `cube-cli/src/slash-commands/new.slash-command.test.ts`
- Modify: `cube-cli/src/slash-commands/registry.ts`
- Create: `cube-cli/src/slash-commands/registry.test.ts`
- Modify: `cube-cli/src/index.ts`

**Interfaces:**
- Consumes: `session.thread.getId()`, `listActiveMessages({ limit: 1 })`, and `session.thread.create({ title })`.
- Produces: `createLazyThreadLifecycle()` with `getVisibleThreadId()`, `ensureThreadForPrompt()`, and `startNewThread()`.

- [ ] **Step 1: Write RED lifecycle tests**

Create `thread-lifecycle.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createLazyThreadLifecycle } from "./thread-lifecycle.js";

test("creates one thread for concurrent first prompts over history", async () => {
  let creates = 0;
  const lifecycle = createLazyThreadLifecycle({
    boundThreadId: "thread-old",
    boundThreadIsEmpty: false,
    createThread: async () => ({ id: `thread-new-${++creates}` }),
  });
  assert.equal(lifecycle.getVisibleThreadId(), null);
  assert.deepEqual(await Promise.all([
    lifecycle.ensureThreadForPrompt(),
    lifecycle.ensureThreadForPrompt(),
  ]), ["thread-new-1", "thread-new-1"]);
  assert.equal(creates, 1);
});

test("reuses an empty bound thread", async () => {
  let creates = 0;
  const lifecycle = createLazyThreadLifecycle({
    boundThreadId: "thread-empty",
    boundThreadIsEmpty: true,
    createThread: async () => ({ id: `unexpected-${++creates}` }),
  });
  assert.equal(await lifecycle.ensureThreadForPrompt(), "thread-empty");
  assert.equal(creates, 0);
});

test("explicit new creates and exposes a thread immediately", async () => {
  const lifecycle = createLazyThreadLifecycle({
    boundThreadId: "thread-old",
    boundThreadIsEmpty: false,
    createThread: async () => ({ id: "thread-explicit" }),
  });
  assert.equal(await lifecycle.startNewThread(), "thread-explicit");
  assert.equal(lifecycle.getVisibleThreadId(), "thread-explicit");
});
```

- [ ] **Step 2: Implement the concurrency-safe lifecycle**

Implement this contract; it stores one activation promise, resets it only when
creation rejects, and never creates during construction:

```ts
export interface LazyThreadLifecycle {
  getVisibleThreadId: () => string | null;
  ensureThreadForPrompt: () => Promise<string>;
  startNewThread: () => Promise<string>;
}

export const createLazyThreadLifecycle = (input: {
  boundThreadId: string | null;
  boundThreadIsEmpty: boolean;
  createThread: () => Promise<{ id: string }>;
}): LazyThreadLifecycle => {
  let visibleThreadId: string | null = null;
  let firstPromptActivation: Promise<string> | undefined;
  const create = async () => {
    const thread = await input.createThread();
    visibleThreadId = thread.id;
    return thread.id;
  };
  return {
    getVisibleThreadId: () => visibleThreadId,
    ensureThreadForPrompt: () => {
      if (visibleThreadId) return Promise.resolve(visibleThreadId);
      if (!firstPromptActivation) {
        firstPromptActivation = input.boundThreadIsEmpty && input.boundThreadId
          ? Promise.resolve(input.boundThreadId).then((id) => {
              visibleThreadId = id;
              return id;
            })
          : create();
        firstPromptActivation = firstPromptActivation.catch((error: unknown) => {
          firstPromptActivation = undefined;
          throw error;
        });
      }
      return firstPromptActivation;
    },
    startNewThread: async () => {
      const id = await create();
      firstPromptActivation = Promise.resolve(id);
      return id;
    },
  };
};
```

- [ ] **Step 3: Write and implement `/new` tests**

`runNewSlashCommand()` returns `Cannot start a new thread while an agent turn is active.` without invoking creation when busy. Otherwise it awaits `startNewThread()`, invokes `onCreated(threadId)`, and returns `null`.

Use this implementation after watching equivalent busy/success tests fail:

```ts
export const runNewSlashCommand = async (input: {
  turnActive: boolean;
  startNewThread: () => Promise<string>;
  onCreated: (threadId: string) => void;
}): Promise<string | null> => {
  if (input.turnActive) {
    return "Cannot start a new thread while an agent turn is active.";
  }
  const threadId = await input.startNewThread();
  input.onCreated(threadId);
  return null;
};
```

- [ ] **Step 4: Register `/new` and prove unrelated commands are passive**

Add `/new` metadata to `registry.ts`. A registry test invokes `/model`, `/compact`, and `/exit` with a counted `startNewThread` callback and asserts the count remains zero.

The registry input is:

```ts
newThread: {
  isTurnActive: () => boolean;
  startNewThread: () => Promise<string>;
  onCreated: (threadId: string) => void;
};
```

- [ ] **Step 5: Wire startup and input**

Probe the bound thread once at startup, initialize the visible label as `new thread`, call `ensureThreadForPrompt()` before adding/sending the first user message, use its visible ID for `/compact`, and clear the transcript/update the ID after `/new`.

- [ ] **Step 6: Run focused and full CLI tests**

Run:

```powershell
pnpm --filter @cube/cli test
```

Expected: every CLI test passes, including no passive create and concurrent first-prompt deduplication.

---

### Task 4: Full verification

**Files:** Verify only.

- [ ] **Step 1: Run all tests**

```powershell
pnpm --recursive run test
```

- [ ] **Step 2: Force TypeScript build and syntax check**

```powershell
.\node_modules\.bin\tsc.cmd --build --force --pretty false
node --check cube-cli\dist\index.js
```

- [ ] **Step 3: Check removal of duplicate tool state logic**

```powershell
rg -n "toolViews|declinedToolCalls|toolName ===|approveToolCall|declineToolCall|mastra_workspace_execute_command" cube-cli cube-tui cube-agent -g "*.ts"
```

Expected: no Cube source match. The Mastra constant remains only where workspace approval policy is configured through `WORKSPACE_TOOLS`.

- [ ] **Step 4: Runtime approval smoke**

Run `pnpm dev`, request a harmless command, approve it, and verify: generic args shown, Working hidden during picker, output streams, Working resumes, completed status appears, assistant completes. Repeat with decline and confirm no duplicate picker.

- [ ] **Step 5: Runtime thread-count smoke**

Count threads from copied SQLite snapshots before and after open-plus-`/exit`; counts must match. Then send one first prompt from a launch whose bound thread has history; count must increase by exactly one.
