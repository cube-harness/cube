# Cube Package Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Cube into a one-way four-package architecture with an explicit agent runtime, presentation-only TUI, isolated CLI command handlers, consistent lifecycle flow, accurate dependencies, and an accurate root README.

**Architecture:** `cube-cli` is the executable composition root. It obtains persistent state from `cube-workspace`, creates a headless runtime through `cube-agent`, creates `cube-tui`, and maps typed TUI actions and Mastra Session events between them. Slash commands are individually implemented in `cube-cli` and centrally registered; tool approval behavior remains deferred.

**Tech Stack:** TypeScript 5.7, Node.js >=22.13.0, pnpm workspace, Mastra 1.x, AI SDK 6.0.241, `@earendil-works/pi-tui` 0.83.0, Node test runner through `tsx`.

## Global Constraints

- Keep all existing zero-byte future-phase files present and unchanged.
- Do not implement or redesign tool approval; remove only the custom CLI `approval-flow` orchestration and retain passive display code.
- Do not change model catalog/provider semantics, memory policy, or lazy thread creation.
- Global `config.yaml` remains the only model source of truth; do not add per-thread model persistence.
- New factories, handlers, mappers, and bootstrap functions use arrow-function exports. A custom pi-tui component may use a class when it extends a library class.
- `cube-tui` must not import `@cube/agent`, `@cube/workspace`, or Mastra types.
- `cube-agent` must not load `.env`, choose the workspace with `process.cwd()`, exit the process, or initialize runtime resources at import time.
- Only `cube-cli` may decide to exit the process.
- Do not upgrade unrelated dependency versions.
- The current `D:\cube` checkout is not recognized as a Git worktree. Treat task boundaries as review checkpoints and do not claim commits. If Git becomes usable during execution, use the suggested commit command at each checkpoint.

---

## File Structure

### Create

- `cube-agent/src/runtime.test.ts` — validates explicit runtime creation and cleanup.
- `cube-cli/src/slash-commands/exit.slash-command.test.ts` — validates isolated `/exit` behavior.
- `cube-cli/src/slash-commands/registry.test.ts` — validates registration, execution, unknown commands, and autocomplete projection.
- `cube-cli/src/session-events.ts` — maps one Mastra Session subscription to named TUI rendering methods.
- `cube-cli/src/session-events.test.ts` — validates pure message/display mapping where possible.
- `cube-cli/src/lifecycle.ts` — owns idempotent shutdown and active-run cancellation decisions.
- `cube-cli/src/lifecycle.test.ts` — validates abort-versus-shutdown and repeated shutdown calls.

### Modify

- `cube-workspace/src/workspace.ts`, `cube-workspace/src/workspace.test.ts`, `cube-workspace/src/index.ts` — own and export workspace identity/resource ID.
- `cube-agent/src/memory.ts`, `cube-agent/src/index.ts` — remove identity ownership and singleton initialization; expose `createCubeRuntime`.
- `cube-tui/src/components/prompt-editor.ts`, `cube-tui/src/components/prompt-editor.test.ts` — implement typed actions and blinking hardware-cursor-compatible rendering.
- `cube-tui/src/screens/chat.screen.ts`, `cube-tui/src/index.ts`, `cube-tui/src/index.test.ts` — remove process lifecycle ownership, use named render methods, and manage cursor lifecycle.
- `cube-tui/src/components/banner.ts` — remove caller-CWD asset probing.
- `cube-cli/src/slash-commands/model.slash-command.ts`, `cube-cli/src/slash-commands/model.slash-command.test.ts` — expose the complete model command handler.
- `cube-cli/src/slash-commands/compact.slash-command.ts`, `cube-cli/src/slash-commands/compact.slash-command.test.ts` — expose the complete compact command handler.
- `cube-cli/src/slash-commands/exit.slash-command.ts` — expose the exit handler.
- `cube-cli/src/slash-commands/registry.ts` — become the single name/description/handler registration point.
- `cube-cli/src/index.ts` — become composition and routing only.
- `cube-tui/package.json`, `cube-tui/tsconfig.json`, `pnpm-lock.yaml` — remove the invalid TUI-to-agent dependency and stale dev script.
- `README.md` — describe only the implemented package architecture and current flow.

### Delete

- `cube-cli/src/approval-flow.ts`
- `cube-cli/src/approval-flow.test.ts`

---

### Task 1: Move workspace identity ownership to `cube-workspace`

**Files:**
- Modify: `cube-workspace/src/workspace.test.ts`
- Modify: `cube-workspace/src/workspace.ts`
- Modify: `cube-workspace/src/index.ts`
- Modify: `cube-agent/src/memory.ts`
- Modify: `cube-agent/src/index.ts`

**Interfaces:**
- Produces: `WorkspaceIdentity`, `createWorkspaceResourceId(canonicalPath, platform?)`, and `resolveWorkspaceIdentity(workspacePath)` from `@cube/workspace`.
- Consumed by: `CreateCubeRuntimeInput.identity` in Task 2 and CLI bootstrap in Task 6.

- [ ] **Step 1: Add failing workspace identity tests**

Add imports and tests to `cube-workspace/src/workspace.test.ts`:

```ts
import {
  createWorkspaceResourceId,
  resolveWorkspaceIdentity,
} from "./workspace.js";

test("derives a stable workspace resource ID from the canonical path", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cube-identity-"));
  try {
    const project = path.join(root, "project");
    mkdirSync(project);
    const first = resolveWorkspaceIdentity(project);
    const second = resolveWorkspaceIdentity(path.join(project, "."));
    assert.equal(first.canonicalPath, second.canonicalPath);
    assert.equal(first.resourceId, second.resourceId);
    assert.match(first.resourceId, /^workspace:[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes Windows path casing for resource identity", () => {
  assert.equal(
    createWorkspaceResourceId("C:\\Cube\\Project", "win32"),
    createWorkspaceResourceId("c:\\cube\\project", "win32"),
  );
});
```

- [ ] **Step 2: Run the focused test and verify the new exports are missing**

Run: `pnpm --filter @cube/workspace test`

Expected: FAIL because `createWorkspaceResourceId` and `resolveWorkspaceIdentity` are not exported from `workspace.ts`.

- [ ] **Step 3: Move identity implementation into `cube-workspace`**

Add `createHash` to `cube-workspace/src/workspace.ts`, then add:

```ts
export interface WorkspaceIdentity {
  canonicalPath: string;
  resourceId: string;
}

export const createWorkspaceResourceId = (
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  const identityPath = workspaceComparisonKey(canonicalPath, platform);
  return `workspace:${createHash("sha256").update(identityPath, "utf8").digest("hex")}`;
};

export const resolveWorkspaceIdentity = (
  workspacePath: string,
): WorkspaceIdentity => {
  const canonicalPath = canonicalizeWorkspacePath(workspacePath);
  return {
    canonicalPath,
    resourceId: createWorkspaceResourceId(canonicalPath),
  };
};
```

Export these symbols from `cube-workspace/src/index.ts`. Remove their implementations, Node path/hash imports, and `WorkspaceIdentity` from `cube-agent/src/memory.ts`. Remove their re-exports from `cube-agent/src/index.ts`; Task 2 will rebuild that entrypoint without singletons.

- [ ] **Step 4: Run workspace and agent typechecks/tests**

Run:

```powershell
pnpm --filter @cube/workspace test
pnpm --filter @cube/workspace build
pnpm --filter @cube/agent test
```

Expected: workspace tests/build PASS; existing agent tests PASS after identity exports are removed from agent internals.

- [ ] **Step 5: Record the checkpoint**

Changed responsibility: workspace-global identity is exported only by `@cube/workspace`. If Git is available: `git add cube-workspace/src cube-agent/src/memory.ts cube-agent/src/index.ts && git commit -m "refactor: move workspace identity ownership"`.

---

### Task 2: Replace agent import-time singletons with an explicit runtime factory

**Files:**
- Create: `cube-agent/src/runtime.test.ts`
- Modify: `cube-agent/src/index.ts`

**Interfaces:**
- Consumes: `CubeConfig`, `CubePaths`, and `WorkspaceIdentity` from `@cube/workspace`.
- Produces: `CreateCubeRuntimeInput`, `CubeRuntime`, and `createCubeRuntime(input): Promise<CubeRuntime>`.
- `CubeRuntime` exposes `session`, `listAvailableModels`, `finalizeThreadMemory`, and `close`.

- [ ] **Step 1: Add a failing runtime factory integration test**

Create `cube-agent/src/runtime.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCubePaths,
  ensureCubeHome,
  readConfig,
  resolveWorkspaceIdentity,
} from "@cube/workspace";
import { createCubeRuntime } from "./index.js";

test("creates and closes an explicit Cube runtime", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cube-runtime-"));
  const project = path.join(root, "project");
  const cubePaths = createCubePaths(path.join(root, ".cube"));
  mkdirSync(project);
  ensureCubeHome(cubePaths);

  const runtime = await createCubeRuntime({
    config: readConfig(cubePaths),
    identity: resolveWorkspaceIdentity(project),
    cubePaths,
    readInstructions: () => "You are Cube.",
  });

  try {
    assert.equal(runtime.session.model.get(), readConfig(cubePaths).model);
    assert.equal(typeof runtime.listAvailableModels, "function");
    assert.equal(typeof runtime.finalizeThreadMemory, "function");
  } finally {
    await runtime.close();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test and verify the factory is missing**

Run: `pnpm --filter @cube/agent test`

Expected: FAIL because `createCubeRuntime` is not exported and importing the current entrypoint initializes global resources.

- [ ] **Step 3: Rebuild `cube-agent/src/index.ts` around explicit input**

Define:

```ts
export interface CreateCubeRuntimeInput {
  config: CubeConfig;
  identity: WorkspaceIdentity;
  cubePaths: CubePaths;
  readInstructions: () => string;
}

export interface CubeRuntime {
  session: Awaited<ReturnType<ReturnType<typeof createController>["createSession"]>>;
  listAvailableModels: () => ReturnType<ReturnType<typeof createController>["listAvailableModels"]>;
  finalizeThreadMemory: (threadId: string) => Promise<FinalizeMemoryResult>;
  close: () => Promise<void>;
}
```

Implement `createCubeRuntime` as an arrow function. Inside it, generate `sessionId`, create logger with `input.cubePaths`, create agent workspace from `input.identity.canonicalPath`, create storage from `input.cubePaths.memoryDb`, initialize storage, create memory/agent/controller/Mastra, initialize controller, and create the configured Session using `input.identity.resourceId` for owner/resource IDs. Pass `input.readInstructions` to `createDefaultAgent`.

Use one close guard:

```ts
let closePromise: Promise<void> | undefined;
const close = (): Promise<void> => {
  closePromise ??= storage.close();
  return closePromise;
};
```

If initialization throws after storage creation, `await storage.close().catch(() => undefined)` before rethrowing the contextual initialization error.

Return controller access only through:

```ts
listAvailableModels: () => cubeController.listAvailableModels(),
finalizeThreadMemory: (threadId) => finalizeObservationalMemory(memory, {
  threadId,
  resourceId: input.identity.resourceId,
}),
```

Keep reusable factory exports (`createDefaultAgent`, `createController`, `createMemory`, `createAgentWorkspace`) but remove all exported initialized values such as `config`, `identity`, `storage`, `cubeController`, and `session`.

- [ ] **Step 4: Run focused agent verification**

Run:

```powershell
pnpm --filter @cube/agent test
pnpm --filter @cube/agent build
```

Expected: all agent tests PASS; importing the module itself no longer creates `~/.cube`, storage, controller, or Session.

- [ ] **Step 5: Record the checkpoint**

Changed responsibility: `cube-agent` constructs runtime resources only through `createCubeRuntime`. If Git is available: `git add cube-agent/src && git commit -m "refactor: create agent runtime explicitly"`.

---

### Task 3: Make the TUI contract typed and presentation-only

**Files:**
- Modify: `cube-tui/src/components/prompt-editor.test.ts`
- Modify: `cube-tui/src/components/prompt-editor.ts`
- Modify: `cube-tui/src/screens/chat.screen.ts`
- Modify: `cube-tui/src/index.test.ts`
- Modify: `cube-tui/src/index.ts`
- Modify: `cube-tui/src/components/banner.ts`

**Interfaces:**
- Produces: `TuiAction`, `SlashCommandSuggestion`, and `createApp(options)` with `onAction`, `slashCommands`, `basePath`, and optional `terminal`.
- Produces named UI methods: `addMessage`, `setInfo`, `setModel`, `setWorkspace`, and `renderAgentDisplay`.
- Consumed by: CLI command suggestions, action routing, and Session event mapping in Tasks 5 and 6.

- [ ] **Step 1: Replace the prompt submission test with typed prompt/command tests**

Update `prompt-editor.test.ts` to instantiate `new PromptEditor(...)` and assert:

```ts
test("emits typed prompt and command actions", () => {
  const tui = new TUI(terminal);
  const actions: TuiAction[] = [];
  const editor = new PromptEditor({
    tui,
    onAction: (action) => actions.push(action),
    slashCommands: [],
    basePath: "C:\\workspace",
  });

  editor.onSubmit?.("hello cube");
  editor.onSubmit?.("/model google/gemini-3-flash");

  assert.deepEqual(actions, [
    { type: "prompt_submit", content: "hello cube" },
    {
      type: "command_submit",
      name: "/model",
      argument: "google/gemini-3-flash",
    },
  ]);
});
```

Retain the native slash autocomplete test, but pass `SlashCommandSuggestion[]` and an explicit base path.

- [ ] **Step 2: Add failing cancellation and named-render tests**

In `cube-tui/src/index.test.ts`, replace positional `createApp` calls with the options object and add a fake terminal that captures `onInput`. Assert that sending Ctrl+C while `PromptEditor` is focused emits `{ type: "cancel" }`. Assert that `app.setInfo(...)` and `app.setModel(...)` update the footer/info box without calling generic `dispatch`.

Expected contract:

```ts
const app = createApp({
  onAction: (action) => actions.push(action),
  slashCommands: [{ name: "/model", description: "Switch model" }],
  basePath: "C:\\workspace",
  terminal,
});
```

- [ ] **Step 3: Run the TUI tests and verify the new contract is missing**

Run: `pnpm --filter @cube/tui test`

Expected: FAIL because `PromptEditor`, typed action variants, options-based `createApp`, and named render methods do not yet exist.

- [ ] **Step 4: Implement `PromptEditor` as a custom class**

Replace `createPromptEditor` with:

```ts
export class PromptEditor extends Editor {
  constructor(private readonly options: PromptEditorOptions) {
    super(options.tui, createEditorTheme(), {
      paddingX: 1,
      autocompleteMaxVisible: 8,
    });

    this.setAutocompleteProvider(new CombinedAutocompleteProvider(
      options.slashCommands.map(({ name, description }) => ({
        name: name.slice(1),
        description,
      })),
      options.basePath,
    ));

    this.onSubmit = (text) => {
      const value = text.trim();
      if (!value) return;
      this.addToHistory(value);
      if (value.startsWith("/")) {
        const [name, ...argumentParts] = value.split(/\s+/);
        this.options.onAction({
          type: "command_submit",
          name: name as `/${string}`,
          argument: argumentParts.join(" "),
        });
      } else {
        this.options.onAction({ type: "prompt_submit", content: value });
      }
      this.setText("");
    };
  }
}
```

Override `handleInput(data)` to emit `{ type: "cancel" }` when `matchesKey(data, Key.ctrl("c"))`; otherwise call `super.handleInput(data)`. This lets focused pickers consume Ctrl+C themselves and removes process exit from the global screen listener.

- [ ] **Step 5: Replace generic TUI events with explicit APIs**

In `cube-tui/src/index.ts`:

```ts
export type TuiAction =
  | { type: "prompt_submit"; content: string }
  | { type: "command_submit"; name: `/${string}`; argument: string }
  | { type: "cancel" };

export interface SlashCommandSuggestion {
  name: `/${string}`;
  description: string;
}
```

Use `CreateAppOptions` instead of positional arguments. Remove `TuiRenderEvent` and `dispatch`. Add named arrow methods to the returned app:

```ts
addMessage: (message) => { messageList.addMessage(message); tui.requestRender(); },
setInfo: (info) => { infoBox.setInfo(info); footer.setInfo(info); tui.requestRender(); },
setModel: (model) => { infoBox.setInfo({ model }); footer.setInfo({ model }); tui.requestRender(); },
setWorkspace: (workspace) => {
  infoBox.setInfo({ workspace });
  footer.setInfo({ workspace });
  tui.requestRender();
},
```

Rename `inlineControls` to `inlineControlHost` in the mounted screen, app return value, picker/loader code, and tests. In `chat.screen.ts`, keep PageUp/PageDown handling but remove Ctrl+C, `process.exit`, and all process lifecycle behavior.

In `banner.ts`, use the embedded wordmark directly and remove `node:fs`, `node:path`, and `process.cwd()` probing. Convert touched helper declarations to arrow functions.

- [ ] **Step 6: Run typed action and presentation tests**

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: typed prompt/command/cancel tests, picker tests, autocomplete tests, and named-render tests PASS; no TUI production source contains `process.exit` or `process.cwd()`.

- [ ] **Step 7: Record the checkpoint**

Changed responsibility: TUI emits structural actions and renders structural data only. If Git is available: `git add cube-tui/src && git commit -m "refactor: clarify tui action contract"`.

---

### Task 4: Add the blinking vertical hardware caret

**Files:**
- Modify: `cube-tui/src/components/prompt-editor.test.ts`
- Modify: `cube-tui/src/components/prompt-editor.ts`
- Modify: `cube-tui/src/index.test.ts`
- Modify: `cube-tui/src/index.ts`

**Interfaces:**
- Consumes: pi-tui `Editor`, `CURSOR_MARKER`, `TUI.setShowHardwareCursor`, and public `TUI.terminal`.
- Produces: a `PromptEditor.render(width)` that retains the marker but removes only the inverse-video fake cursor, plus app start/stop cursor lifecycle.

- [ ] **Step 1: Add failing cursor rendering and lifecycle tests**

Add to `prompt-editor.test.ts`:

```ts
test("keeps the cursor marker without the inverse software cursor", () => {
  const tui = new TUI(terminal);
  const editor = new PromptEditor({
    tui,
    onAction: () => undefined,
    slashCommands: [],
    basePath: "C:\\workspace",
  });
  editor.focused = true;
  editor.setText("cube");
  const output = editor.render(80).join("\n");
  assert.match(output, new RegExp(CURSOR_MARKER));
  assert.equal(output.includes(`${CURSOR_MARKER}\x1b[7m`), false);
});
```

In `index.test.ts`, capture terminal writes and assert:

```ts
app.start();
assert.equal(app.tui.getShowHardwareCursor(), true);
assert.equal(writes.includes("\x1b[5 q"), true);
app.stop();
assert.equal(writes.includes("\x1b[0 q"), true);
```

- [ ] **Step 2: Run the focused TUI tests and verify they fail**

Run: `pnpm --filter @cube/tui test`

Expected: FAIL because the standard Editor still emits an inverse fake cursor and app lifecycle does not configure cursor shape.

- [ ] **Step 3: Suppress only the fake cursor in `PromptEditor.render`**

Add a focused helper that finds `CURSOR_MARKER`, verifies the immediately following `\x1b[7m`, finds its matching `\x1b[0m`, and removes those two SGR sequences while keeping the grapheme or trailing space between them. Use it in:

```ts
override render(width: number): string[] {
  return super.render(width).map(removeSoftwareCursorAfterMarker);
}
```

Do not remove `CURSOR_MARKER`; pi-tui needs it to position the hardware cursor and IME candidate window.

- [ ] **Step 4: Configure and restore terminal cursor style**

In `createApp`, implement lifecycle methods with constants:

```ts
const BLINKING_BAR_CURSOR = "\x1b[5 q";
const DEFAULT_CURSOR = "\x1b[0 q";

start: () => {
  tui.setShowHardwareCursor(true);
  tui.terminal.write(BLINKING_BAR_CURSOR);
  tui.start();
},
stop: () => {
  tui.terminal.write(DEFAULT_CURSOR);
  tui.stop();
},
```

Do not add a timer; terminal cursor blinking is native.

- [ ] **Step 5: Run TUI tests and build**

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: cursor marker, cursor style, autocomplete, picker, and display tests all PASS.

- [ ] **Step 6: Record the checkpoint**

Changed behavior: prompt cursor is a terminal-native blinking bar and resets on stop. If Git is available: `git add cube-tui/src && git commit -m "feat: use blinking bar prompt cursor"`.

---

### Task 5: Isolate each slash command and centralize registration

**Files:**
- Modify: `cube-cli/src/slash-commands/model.slash-command.test.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.ts`
- Modify: `cube-cli/src/slash-commands/compact.slash-command.test.ts`
- Modify: `cube-cli/src/slash-commands/compact.slash-command.ts`
- Create: `cube-cli/src/slash-commands/exit.slash-command.test.ts`
- Modify: `cube-cli/src/slash-commands/exit.slash-command.ts`
- Create: `cube-cli/src/slash-commands/registry.test.ts`
- Modify: `cube-cli/src/slash-commands/registry.ts`

**Interfaces:**
- Produces: `SlashCommandHandler`, `SlashCommandDefinition`, and `createSlashCommandRegistry(input)` returning `execute` and `suggestions`.
- Produces: `createModelCommandHandler`, `createCompactCommandHandler`, and `createExitCommandHandler`.
- Consumed by: `command_submit` routing in Task 6 and TUI autocomplete.

The command factories use these narrow dependency shapes:

```ts
export interface ModelCommandDependencies {
  getCurrentModel: () => string;
  ollamaBaseUrl: string;
  listMastraModels: () => Promise<AvailableModelRecord[]>;
  openModelPicker: (options: OpenModelPickerOptions) => Promise<string | null>;
  switchModel: (modelId: string) => Promise<void>;
  persistModel: (modelId: string) => void;
  showMessage: (message: string) => void;
}

export interface CompactCommandDependencies {
  getThreadId: () => string | null;
  isTurnActive: () => boolean;
  finalizeMemory: (threadId: string) => Promise<FinalizeMemoryResult>;
  showMessage: (message: string) => void;
}

export interface ExitCommandDependencies {
  shutdown: () => Promise<void>;
}
```

- [ ] **Step 1: Add failing complete-handler tests for model, compact, and exit**

Extend the existing model tests to assert `createModelCommandHandler` shows output and opens the picker for an empty argument. Extend compact tests to assert `createCompactCommandHandler` handles a missing thread itself. These factories are exported for focused tests but are imported for application wiring only by `registry.ts`. Create the exit test:

```ts
test("runs graceful shutdown through the exit handler", async () => {
  let shutdowns = 0;
  const handler = createExitCommandHandler({
    shutdown: async () => { shutdowns += 1; },
  });
  await handler("");
  assert.equal(shutdowns, 1);
});
```

- [ ] **Step 2: Add failing registry tests**

Create `registry.test.ts` with injected handlers and assert:

```ts
test("executes registered commands and projects autocomplete suggestions", async () => {
  const calls: string[] = [];
  const registry = createSlashCommandRegistry({
    model: {
      getCurrentModel: () => "ollama/qwen2.5:7b",
      ollamaBaseUrl: "http://127.0.0.1:11434/api",
      listMastraModels: async () => [],
      openModelPicker: async () => null,
      switchModel: async (modelId) => { calls.push(`switch:${modelId}`); },
      persistModel: (modelId) => { calls.push(`persist:${modelId}`); },
      showMessage: (message) => { calls.push(message); },
    },
    exit: {
      shutdown: async () => { calls.push("exit"); },
    },
    compact: {
      getThreadId: () => null,
      isTurnActive: () => false,
      finalizeMemory: async () => ({ status: "no-op" }),
      showMessage: (message) => { calls.push(message); },
    },
    showMessage: (message) => calls.push(message),
  });

  await registry.execute("/model", "google/gemini-3-flash");
  assert.deepEqual(calls, [
    "switch:google/gemini-3-flash",
    "persist:google/gemini-3-flash",
    "Model changed to google/gemini-3-flash.",
  ]);
  assert.deepEqual(registry.suggestions.map(({ name }) => name), [
    "/compact",
    "/exit",
    "/model",
  ]);
});

test("reports an unregistered command", async () => {
  const messages: string[] = [];
  const registry = createSlashCommandRegistry({
    model: {
      getCurrentModel: () => "ollama/qwen2.5:7b",
      ollamaBaseUrl: "http://127.0.0.1:11434/api",
      listMastraModels: async () => [],
      openModelPicker: async () => null,
      switchModel: async () => undefined,
      persistModel: () => undefined,
      showMessage: (message) => { messages.push(message); },
    },
    exit: { shutdown: async () => undefined },
    compact: {
      getThreadId: () => null,
      isTurnActive: () => false,
      finalizeMemory: async () => ({ status: "no-op" }),
      showMessage: (message) => { messages.push(message); },
    },
    showMessage: (message) => { messages.push(message); },
  });
  await registry.execute("/missing", "");
  assert.deepEqual(messages, ["Unknown command: /missing"]);
});
```

- [ ] **Step 3: Run CLI tests and verify the new factories/registry API are missing**

Run: `pnpm --filter @cube/cli test`

Expected: FAIL because complete handler factories and `registry.execute/suggestions` do not exist.

- [ ] **Step 4: Implement complete per-command handlers**

Keep pure helpers such as `listOllamaModels` and `runModelSlashCommand`, then add `createModelCommandHandler(dependencies): SlashCommandHandler`. The model command file imports `discoverModelCatalog` and owns catalog loading by combining `listOllamaModels(dependencies.ollamaBaseUrl)` with `dependencies.listMastraModels()`. The handler must call `runModelSlashCommand`, provide an `openPicker` callback that supplies current model/catalog/select behavior, and show the returned system message when non-null.

Add `createCompactCommandHandler(dependencies)` around `runCompactSlashCommand`; it owns the no-thread message, busy-turn value, finalization call, and output display. Add `createExitCommandHandler({ shutdown })` to the existing zero-byte exit file.

All three exports are arrow functions. Their dependencies are narrow callbacks; command files do not import initialized global singletons.

- [ ] **Step 5: Replace registry business logic with registration only**

Define:

```ts
export type SlashCommandHandler = (argument: string) => Promise<void>;

export interface SlashCommandDefinition {
  name: `/${string}`;
  description: string;
  handler: SlashCommandHandler;
}
```

`registry.ts` imports `createModelCommandHandler`, `createExitCommandHandler`, and `createCompactCommandHandler`. `createSlashCommandRegistry` accepts grouped `model`, `exit`, and `compact` dependency objects plus `showMessage`, binds the three handlers inside the registry, registers the definitions, exposes `execute(name, argument)`, and derives `suggestions` by mapping only `{ name, description }`. Do not register any zero-byte future command. `cube-cli/src/index.ts` imports only the registry, never individual command handlers.

- [ ] **Step 6: Run focused command tests**

Run:

```powershell
pnpm --filter @cube/cli test
pnpm --filter @cube/cli build
```

Expected at this intermediate point: command unit tests PASS; CLI build may remain blocked by the old `index.ts` contract until Task 6, and that known compiler error must refer only to the changed runtime/TUI/registry APIs.

- [ ] **Step 7: Record the checkpoint**

Changed responsibility: each command owns its logic and registry owns only registration/resolution. If Git is available: `git add cube-cli/src/slash-commands && git commit -m "refactor: isolate slash command handlers"`.

---

### Task 6: Rebuild CLI composition, Session mapping, and lifecycle

**Files:**
- Create: `cube-cli/src/lifecycle.test.ts`
- Create: `cube-cli/src/lifecycle.ts`
- Create: `cube-cli/src/session-events.test.ts`
- Create: `cube-cli/src/session-events.ts`
- Modify: `cube-cli/src/index.ts`
- Delete: `cube-cli/src/approval-flow.test.ts`
- Delete: `cube-cli/src/approval-flow.ts`

**Interfaces:**
- Consumes: `createCubeRuntime`, workspace identity/config APIs, `createApp`, typed `TuiAction`, named TUI render methods, and command registry.
- Produces: one explicit startup flow, one Session subscription, exhaustive action routing, and idempotent graceful shutdown.

- [ ] **Step 1: Add failing lifecycle tests**

Create `lifecycle.test.ts`:

```ts
test("aborts an active run and shuts down only when idle", async () => {
  const calls: string[] = [];
  let running = true;
  const lifecycle = createCliLifecycle({
    isRunning: () => running,
    abort: () => { calls.push("abort"); },
    stopTui: () => { calls.push("stop-tui"); },
    closeRuntime: async () => { calls.push("close-runtime"); },
  });

  await lifecycle.cancel();
  running = false;
  await lifecycle.cancel();
  await lifecycle.shutdown();

  assert.deepEqual(calls, ["abort", "stop-tui", "close-runtime"]);
});
```

The repeated `shutdown()` call must reuse the same promise and not stop/close twice.

- [ ] **Step 2: Add focused pure Session display mapping tests**

Create `session-events.test.ts` for exported arrow helpers that extract assistant text/role and map `session.displayState.get()` into `AgentDisplaySnapshot`. Include text-part content and a pending-approval tool status case. Do not test or add approval response behavior.

- [ ] **Step 3: Run CLI tests and verify lifecycle/session modules are missing**

Run: `pnpm --filter @cube/cli test`

Expected: FAIL because `createCliLifecycle` and Session mapping helpers do not exist.

- [ ] **Step 4: Implement idempotent CLI lifecycle**

In `lifecycle.ts`, export `createCliLifecycle` as an arrow function. `cancel()` calls `abort()` and returns when running; otherwise it awaits `shutdown()`. `shutdown()` memoizes one promise that calls `stopTui()` before `closeRuntime()`.

- [ ] **Step 5: Move Session event mapping out of the entrypoint**

In `session-events.ts`, export arrow helpers for message text/role and:

```ts
export const subscribeToSession = (input: SubscribeToSessionInput) =>
  input.session.subscribe((event) => {
    if (event.type === "display_state_changed") {
      input.app.renderAgentDisplay(toAgentDisplaySnapshot(input.session));
    } else if (event.type === "model_changed") {
      input.app.setModel(event.modelId);
    } else if (event.type === "info") {
      input.showSystemMessage(event.message);
    } else if (event.type === "error") {
      input.showSystemMessage(event.error.message);
    }
  });
```

Passive tool display/pending status mapping may remain. Do not import or invoke `runApprovalFlow`, open the approval picker, deduplicate approval IDs, or respond to approval.

- [ ] **Step 6: Rewrite `cube-cli/src/index.ts` as composition only**

Use this order:

```ts
loadCubeEnv();
ensureCubeHome();
const config = readConfig();
const identity = resolveWorkspaceIdentity(process.cwd());
const runtime = await createCubeRuntime({
  config,
  identity,
  cubePaths: paths,
  readInstructions: () => readSoul(paths),
});
```

After runtime creation, declare `let app: ReturnType<typeof createApp>`. Create `showSystemMessage`, lifecycle callbacks, and model-picker callbacks as closures that reference `app` but are not invoked during construction. Then build grouped dependency objects for model, exit, and compact and pass them to `createSlashCommandRegistry`; the registry imports and binds the individual handler factories. Finally create `app` with the registry's `suggestions`, canonical `basePath`, and an `onAction` callback. This resolves the dependency cycle without duplicating command metadata:

```ts
let app: ReturnType<typeof createApp>;

const showSystemMessage = (content: string): void => {
  app.addMessage({ role: "system", content });
};

const lifecycle = createCliLifecycle({
  isRunning: () => runtime.session.run.isRunning(),
  abort: () => runtime.session.abort(),
  stopTui: () => app.stop(),
  closeRuntime: () => runtime.close(),
});

const commandRegistry = createSlashCommandRegistry({
  model: {
    getCurrentModel: () => runtime.session.model.get() || config.model,
    ollamaBaseUrl: config.providers.ollama.base_url,
    listMastraModels: () => runtime.listAvailableModels(),
    openModelPicker: (options) => app.openModelPicker(options),
    switchModel: (modelId) => runtime.session.model.switch({
      modelId,
      scope: "global",
    }),
    persistModel: (modelId) => writeConfig({ ...config, model: modelId }),
    showMessage: showSystemMessage,
  },
  exit: { shutdown: lifecycle.shutdown },
  compact: {
    getThreadId: () => runtime.session.thread.getId(),
    isTurnActive: () => runtime.session.run.isRunning(),
    finalizeMemory: runtime.finalizeThreadMemory,
    showMessage: showSystemMessage,
  },
  showMessage: showSystemMessage,
});
```

Route actions exhaustively:

```ts
const handleTuiAction = async (action: TuiAction): Promise<void> => {
  switch (action.type) {
    case "prompt_submit":
      app.addMessage({ role: "user", content: action.content });
      await runtime.session.followUp({ content: action.content });
      return;
    case "command_submit":
      await commandRegistry.execute(action.name, action.argument);
      return;
    case "cancel":
      await lifecycle.cancel();
      return;
  }
};
```

Assign `app = createApp({ onAction, slashCommands: commandRegistry.suggestions, basePath: identity.canonicalPath })` only after `handleTuiAction` and the registry exist. The closures referencing `app` are safe because no user action, command handler, or system message runs before `app.start()`. Do not restore dynamic import ordering or agent singletons.

Subscribe exactly once through `subscribeToSession`. Initialize TUI info with named `setInfo`. `/exit` and SIGTERM call the same lifecycle shutdown; only the CLI performs final process exit. Wrap startup/fatal failure so any created app/runtime is closed and terminal cursor style restored.

Delete `approval-flow.ts`, its test, import, invocation, and `handledApprovalId`.

- [ ] **Step 7: Run CLI tests and build all dependent packages**

Run:

```powershell
pnpm --filter @cube/cli test
pnpm --filter @cube/workspace build
pnpm --filter @cube/agent build
pnpm --filter @cube/tui build
pnpm --filter @cube/cli build
```

Expected: CLI tests PASS, all four packages build, and `rg -n "approval-flow|handledApprovalId|process\.exit" cube-agent cube-tui cube-cli/src` reports `process.exit` only in the CLI entrypoint and no approval-flow artifacts.

- [ ] **Step 8: Record the checkpoint**

Changed responsibility: CLI is composition/routing only and owns shutdown. If Git is available: `git add cube-cli/src && git commit -m "refactor: align cli runtime flow"`.

---

### Task 7: Clean dependencies, scripts, lockfile, and README

**Files:**
- Modify: `cube-tui/package.json`
- Modify: `cube-tui/tsconfig.json`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`

**Interfaces:**
- Produces: the approved one-way package graph and accurate project-level documentation.

- [ ] **Step 1: Assert the current stale dependency and README claims**

Run:

```powershell
rg -n '"@cube/agent"|src/dev\.ts' cube-tui/package.json cube-tui/tsconfig.json
rg -n 'taskey|credentials|Keychain|file locks|MCP client/server|Node\.js.*20' README.md
```

Expected before edits: both commands find stale entries.

- [ ] **Step 2: Remove the invalid TUI dependency and script**

Remove `@cube/agent` from `cube-tui/package.json`, remove the missing `src/dev.ts` script, and remove the `../cube-agent` reference from `cube-tui/tsconfig.json`. Keep pi-tui and chalk unchanged.

- [ ] **Step 3: Regenerate only the required lockfile importer state**

Run: `pnpm install --lockfile-only --offline`

Expected: PASS using the existing local store; `pnpm-lock.yaml` no longer lists `@cube/agent` under the `cube-tui` importer and unrelated resolved versions do not change.

- [ ] **Step 4: Replace README with the approved overview**

Write these high-level sections:

1. Current Cube purpose as an interactive coding-agent CLI/TUI.
2. Four package responsibilities.
3. The dependency diagram `cube-workspace <- cube-agent <- cube-cli -> cube-tui` with CLI also directly consuming workspace.
4. Startup flow, TUI action flow, Session event flow, model switch flow, and graceful shutdown overview.
5. Actual development requirements and commands: Node.js `>=22.13.0`, `pnpm install`, `pnpm dev`, `pnpm --recursive --if-present test`, `pnpm typecheck`, and `pnpm build`.

Do not list internal files or claim `taskey`, keychain/credentials, file locks, completed MCP behavior, or production binary installers.

- [ ] **Step 5: Validate the graph and README claims**

Run:

```powershell
rg -n 'from "@cube/(agent|workspace)"' cube-tui/src
rg -n '"@cube/agent"' cube-tui/package.json cube-tui/tsconfig.json pnpm-lock.yaml
rg -n 'taskey|credentials|Keychain|file locks|MCP client/server|Node\.js.*20' README.md
```

Expected: all three searches return no matches. Confirm the zero-byte placeholders still exist with the same paths and zero lengths.

- [ ] **Step 6: Record the checkpoint**

Changed result: manifests and README match the real package graph. If Git is available: `git add cube-tui/package.json cube-tui/tsconfig.json pnpm-lock.yaml README.md && git commit -m "docs: align Cube package architecture"`.

---

### Task 8: Verify from fresh artifacts and smoke the real CLI boundary

**Files:**
- Verification only; remove only generated `dist` directories and `*.tsbuildinfo` files within the four package directories before rebuilding.

**Interfaces:**
- Consumes all previous tasks.
- Produces deterministic evidence for tests/build/syntax and clearly separated environment-dependent smoke results.

- [ ] **Step 1: Verify exact clean targets before removal**

Resolve and print only:

```text
D:\cube\cube-workspace\dist
D:\cube\cube-agent\dist
D:\cube\cube-tui\dist
D:\cube\cube-cli\dist
```

and `*.tsbuildinfo` files whose resolved paths begin with one of those four package directories. Do not remove anything at the workspace root or outside these targets.

- [ ] **Step 2: Remove generated artifacts and run peer validation**

Use native PowerShell `Remove-Item` only after the path check. Then run: `pnpm peers check`.

Expected: peer validation PASS.

- [ ] **Step 3: Run all package tests**

Run: `pnpm --recursive --if-present test`

Expected: all workspace, agent, TUI, and CLI tests PASS with zero failures.

- [ ] **Step 4: Run fresh typecheck/build and syntax verification**

Run:

```powershell
pnpm typecheck
pnpm build
node --check cube-cli/dist/index.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Run focused source-boundary checks**

Run:

```powershell
rg -n 'process\.exit|process\.cwd' cube-agent/src cube-tui/src
rg -n 'from "@cube/(agent|workspace)"' cube-tui/src
rg -n 'approval-flow|handledApprovalId|runApprovalFlow' cube-cli/src
rg -n 'createCubeRuntime|session\.subscribe|commandRegistry\.execute' cube-cli/src cube-agent/src
```

Expected: first three commands return no matches; the last command shows explicit runtime creation, one Session subscription helper, and registry execution routing.

- [ ] **Step 6: Smoke CLI startup and provider behavior proportionally**

Run the built CLI with the current global config long enough to confirm it reaches TUI startup without an initial Anthropic API-key error caused by import-time defaults. Exit through `/exit` or idle Ctrl+C and confirm terminal cursor style is restored.

If local Ollama is reachable, list its models and run the existing real `generateText` smoke expecting `CUBE_OK`. Run Gemini smoke only when a valid Google API key and currently available model are configured. Report unavailable external services separately; do not mark them passed.

- [ ] **Step 7: Confirm no source-masking artifacts remain after reporting**

After verification, retain required build output only if needed to run the CLI; otherwise remove the four package `dist` directories and generated `*.tsbuildinfo` files using the same verified target list. Report exactly what was removed.

- [ ] **Step 8: Final checkpoint**

Summarize changed files, deterministic test counts, build/syntax results, smoke results, deferred tool approval, and Git unavailability. If Git becomes usable: `git add README.md package.json pnpm-lock.yaml cube-workspace cube-agent cube-tui cube-cli docs/superpowers && git commit -m "refactor: align Cube package boundaries"`.
