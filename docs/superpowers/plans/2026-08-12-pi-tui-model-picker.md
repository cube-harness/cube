# Native pi-tui Input and Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cube's hand-written prompt editor with pi-tui `Editor`/`CombinedAutocompleteProvider`, and make `/model` open a cancellable, searchable `SelectList` overlay that switches and persists the selected model safely.

**Architecture:** `@cube/tui` owns native pi-tui composition and overlay lifecycle, while `@cube/cli` owns catalog discovery, Mastra session switching, and config persistence. Catalog discovery becomes a pure, concurrently executed module; the TUI receives callbacks and normalized model IDs so it never imports agent or workspace runtime APIs.

**Tech Stack:** TypeScript 5.7, Node.js test runner through `tsx`, `@earendil-works/pi-tui@0.83.0`, `@mastra/core@1.56.0`, pnpm workspaces, Chalk 5.

## Global Constraints

- Keep `@earendil-works/pi-tui` pinned to `0.83.0`; use the exact installed type declarations instead of newer undocumented APIs.
- Preserve the current main-screen `TUI` renderer and terminal scrollback; do not introduce an alternate-screen renderer.
- `@cube/tui` must not import `@cube/agent`, Mastra controllers, or `@cube/workspace` configuration functions.
- Model IDs remain `ollama/<name>` for the direct Ollama adapter and `google/<name>` for the Mastra router.
- Keep `/model <model-id>` as a non-interactive compatibility path.
- Switch the session before calling `writeConfig`; a failed switch must never persist.
- Keep `MessageList` ownership of streaming state and scroll offsets.
- Every production behavior must be preceded by a focused failing test and a verified RED result.
- The checkout currently has an incomplete `.git` directory without `HEAD` or `config`; never fabricate Git metadata or claim a commit succeeded.

---

## File Structure

- Create `cube-tui/src/themes/pi-tui.theme.ts`: adapt Cube colors to pi-tui `EditorTheme`, `SelectListTheme`, and `MarkdownTheme`.
- Create `cube-tui/src/components/prompt-editor.ts`: configure the native `Editor` and slash/file autocomplete.
- Create `cube-tui/src/components/prompt-editor.test.ts`: verify native autocomplete and submission.
- Delete `cube-tui/src/components/input-box.ts`: remove the hand-written editor after replacement tests pass.
- Delete `cube-tui/src/components/input-box.test.ts`: replace tests tied to the old implementation.
- Create `cube-tui/src/components/model-picker.ts`: compose `Input` and `SelectList` into a searchable focused overlay component.
- Create `cube-tui/src/components/model-picker.test.ts`: verify initial selection, filtering, selection, cancellation, and inline errors.
- Modify `cube-tui/src/screens/chat.screen.ts`: mount `Editor`, use pi-tui key matching, and return it as `promptEditor`.
- Modify `cube-tui/src/index.ts`: export the new components and expose `openModelPicker()` with deterministic overlay cleanup.
- Create `cube-tui/src/index.test.ts`: verify loading cancellation and focus restoration.
- Create `cube-cli/src/model/model-catalog.ts`: concurrently merge Ollama and direct Google model sources with warnings.
- Create `cube-cli/src/model/model-catalog.test.ts`: verify partial success, total failure, sorting, deduplication, and abort behavior.
- Modify `cube-cli/src/slash-commands/model.slash-command.ts`: open the picker for an empty argument and retain direct switching for an explicit ID.
- Modify `cube-cli/src/slash-commands/model.slash-command.test.ts`: verify picker dispatch and switch-before-persist failure safety.
- Modify `cube-cli/src/index.ts`: wire catalog discovery and picker callbacks without embedding discovery logic in the entrypoint.
- Modify `cube-tui/src/components/message-list.ts`: render assistant/system bodies with native `Markdown` while retaining transcript state.
- Create `cube-tui/src/components/message-list.test.ts`: verify Markdown rendering and width safety.
- Modify `cube-tui/src/dev.ts`: supply sample slash commands so the TUI preview exercises native autocomplete.

---

### Task 1: Replace the hand-written prompt editor with native pi-tui Editor

**Files:**
- Create: `cube-tui/src/themes/pi-tui.theme.ts`
- Create: `cube-tui/src/components/prompt-editor.ts`
- Create: `cube-tui/src/components/prompt-editor.test.ts`
- Modify: `cube-tui/src/screens/chat.screen.ts`
- Modify: `cube-tui/src/index.ts`
- Delete after GREEN: `cube-tui/src/components/input-box.ts`
- Delete after GREEN: `cube-tui/src/components/input-box.test.ts`

**Interfaces:**
- Consumes: `TuiInputEvent`, `TuiSlashCommand`, pi-tui `TUI`, `Editor`, and `CombinedAutocompleteProvider`.
- Produces: `createPromptEditor(tui, onEvent, slashCommands, basePath?): Editor` and `createEditorTheme(): EditorTheme`.

- [ ] **Step 1: Write the failing prompt-editor tests**

Create `cube-tui/src/components/prompt-editor.test.ts` with a minimal terminal stub and tests against the desired public factory:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { TUI, type Terminal } from "@earendil-works/pi-tui";
import { createPromptEditor } from "./prompt-editor.js";

const terminal: Terminal = {
  columns: 100,
  rows: 30,
  start: () => undefined,
  stop: () => undefined,
  write: () => undefined,
  moveBy: () => undefined,
  hideCursor: () => undefined,
  showCursor: () => undefined,
  clearLine: () => undefined,
  clearFromCursor: () => undefined,
  clearScreen: () => undefined,
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("uses native slash autocomplete without duplicating the slash", async () => {
  const tui = new TUI(terminal);
  const editor = createPromptEditor(tui, undefined, [
    { name: "/compact", description: "Compact memory" },
    { name: "/model", description: "Switch model" },
  ], process.cwd());

  editor.handleInput("/");
  await settle();
  assert.equal(editor.isShowingAutocomplete(), true);

  editor.handleInput("\t");
  await settle();
  assert.equal(editor.getText(), "/compact ");
});

test("submits non-empty text through the Cube event contract", () => {
  const tui = new TUI(terminal);
  const events: unknown[] = [];
  const editor = createPromptEditor(tui, (event) => events.push(event), []);

  editor.setText("hello cube");
  editor.onSubmit?.(editor.getText());

  assert.deepEqual(events, [{ type: "user_input", payload: "hello cube" }]);
  assert.equal(editor.getText(), "");
});
```

- [ ] **Step 2: Run the TUI tests and verify RED**

Run: `pnpm --filter @cube/tui test`

Expected: FAIL because `./prompt-editor.js` does not exist. This is the required feature-missing failure.

- [ ] **Step 3: Add exact pi-tui theme adapters**

Create `cube-tui/src/themes/pi-tui.theme.ts`:

```ts
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import { getTheme } from "./color.schema.js";

export const createSelectListTheme = (): SelectListTheme => {
  const theme = getTheme();
  return {
    selectedPrefix: theme.primary,
    selectedText: theme.primary,
    description: theme.muted,
    scrollInfo: theme.muted,
    noMatch: theme.warning,
  };
};

export const createEditorTheme = (): EditorTheme => ({
  borderColor: getTheme().border,
  selectList: createSelectListTheme(),
});

export const createMarkdownTheme = (): MarkdownTheme => {
  const theme = getTheme();
  return {
    heading: theme.primary,
    link: theme.secondary,
    linkUrl: theme.muted,
    code: theme.warning,
    codeBlock: theme.system,
    codeBlockBorder: theme.border,
    quote: theme.muted,
    quoteBorder: theme.border,
    hr: theme.border,
    listBullet: theme.primary,
    bold: theme.primary,
    italic: theme.secondary,
    strikethrough: theme.muted,
    underline: theme.secondary,
  };
};
```

- [ ] **Step 4: Implement the minimal native prompt-editor factory**

Create `cube-tui/src/components/prompt-editor.ts`:

```ts
import {
  CombinedAutocompleteProvider,
  Editor,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TuiInputEvent, TuiSlashCommand } from "../index.js";
import { createEditorTheme } from "../themes/pi-tui.theme.js";

export const createPromptEditor = (
  tui: TUI,
  onEvent?: (event: TuiInputEvent) => void,
  slashCommands: TuiSlashCommand[] = [],
  basePath: string = process.cwd(),
): Editor => {
  const editor = new Editor(tui, createEditorTheme(), {
    paddingX: 1,
    autocompleteMaxVisible: 8,
  });

  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
    slashCommands.map(({ name, description }) => ({
      name: name.slice(1),
      description,
    })),
    basePath,
  ));

  editor.onSubmit = (text) => {
    const value = text.trim();
    if (!value) return;
    editor.addToHistory(value);
    onEvent?.({ type: "user_input", payload: value });
    editor.setText("");
  };

  return editor;
};
```

- [ ] **Step 5: Mount `Editor` and remove raw key parsing owned by the old InputBox**

Modify `cube-tui/src/screens/chat.screen.ts` so it calls `createPromptEditor(tui, onEvent, slashCommands)` and adds the returned editor. Import `Key` and `matchesKey`, then replace the raw comparisons with `matchesKey(data, Key.ctrl("c"))`, `matchesKey(data, Key.pageUp)`, and `matchesKey(data, Key.pageDown)`. These exact helpers are present in the installed `0.83.0` `keys.d.ts`. Return the property as `promptEditor`.

Modify `cube-tui/src/index.ts` to export `prompt-editor.ts` and `pi-tui.theme.ts`, destructure `promptEditor`, return it from `createApp`, and remove the `input-box.ts` export.

Delete `cube-tui/src/components/input-box.ts` and its test only after the new prompt tests are GREEN.

- [ ] **Step 6: Verify GREEN and the package build**

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: prompt-editor tests pass, old InputBox tests are gone, and TypeScript accepts the exact installed pi-tui APIs.

- [ ] **Step 7: Record or commit Task 1**

Run `git rev-parse --is-inside-work-tree`. If it still fails because `.git/HEAD` and `.git/config` are absent, record `Task 1 commit skipped: incomplete Git metadata` and continue without modifying `.git`. If Git is valid, run:

```powershell
git add cube-tui/src/components cube-tui/src/screens/chat.screen.ts cube-tui/src/themes cube-tui/src/index.ts
git commit -m "refactor(tui): use native pi-tui editor"
```

---

### Task 2: Build a searchable ModelPicker from native Input and SelectList

**Files:**
- Create: `cube-tui/src/components/model-picker.ts`
- Create: `cube-tui/src/components/model-picker.test.ts`
- Modify: `cube-tui/src/index.ts`

**Interfaces:**
- Consumes: normalized model ID strings, current model ID, Cube select-list theme.
- Produces: `ModelPicker`, `ModelPickerOptions`, `setError(message?)`, `setWarning(message?)`, `onSelect`, and `onCancel` behavior.

- [ ] **Step 1: Write failing picker behavior tests**

Create `cube-tui/src/components/model-picker.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { ModelPicker } from "./model-picker.js";

const models = [
  "google/gemini-2.5-flash",
  "ollama/llama3.2:3b",
  "ollama/qwen2.5:7b",
];

test("initially selects the active model", () => {
  const picker = new ModelPicker({ models, currentModel: "ollama/qwen2.5:7b" });
  assert.equal(picker.getSelectedModel(), "ollama/qwen2.5:7b");
});

test("filters by the search input and selects with Enter", () => {
  let selected: string | undefined;
  const picker = new ModelPicker({ models, currentModel: models[0] });
  picker.onSelect = (modelId) => { selected = modelId; };

  picker.handleInput("o");
  picker.handleInput("l");
  picker.handleInput("l");
  picker.handleInput("a");
  picker.handleInput("m");
  picker.handleInput("a");
  picker.handleInput("/");
  picker.handleInput("q");
  picker.handleInput("\r");

  assert.equal(selected, "ollama/qwen2.5:7b");
});

test("Escape cancels and inline errors remain visible", () => {
  let cancelled = false;
  const picker = new ModelPicker({ models, currentModel: models[0] });
  picker.onCancel = () => { cancelled = true; };
  picker.setError("Model authentication failed.");

  assert.match(picker.render(80).join("\n"), /Model authentication failed/);
  picker.handleInput("\u001b");
  assert.equal(cancelled, true);
});
```

- [ ] **Step 2: Run TUI tests and verify RED**

Run: `pnpm --filter @cube/tui test`

Expected: FAIL because `ModelPicker` is not implemented.

- [ ] **Step 3: Implement ModelPicker as a thin composition**

Create `cube-tui/src/components/model-picker.ts` with these exact public members:

```ts
import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { getTheme } from "../themes/color.schema.js";
import { createSelectListTheme } from "../themes/pi-tui.theme.js";

export interface ModelPickerOptions {
  models: string[];
  currentModel: string;
  warning?: string;
}

export class ModelPicker implements Component, Focusable {
  private readonly search = new Input();
  private readonly list: SelectList;
  private error?: string;
  private warning?: string;
  onSelect?: (modelId: string) => void;
  onCancel?: () => void;

  constructor(options: ModelPickerOptions) {
    this.warning = options.warning;
    const items = options.models.map((modelId) => ({
      value: modelId,
      label: modelId,
      description: modelId === options.currentModel ? "current" : undefined,
    }));
    this.list = new SelectList(items, 12, createSelectListTheme());
    this.list.setSelectedIndex(Math.max(0, items.findIndex(
      (item) => item.value === options.currentModel,
    )));
    this.list.onSelect = (item) => this.onSelect?.(item.value);
    this.list.onCancel = () => this.onCancel?.();
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }

  getSelectedModel(): string | null {
    return this.list.getSelectedItem()?.value ?? null;
  }

  setError(message?: string): void { this.error = message; }
  setWarning(message?: string): void { this.warning = message; }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.list.handleInput(data);
      return;
    }
    this.search.handleInput(data);
    this.list.setFilter(this.search.getValue());
  }

  invalidate(): void {
    this.search.invalidate();
    this.list.invalidate();
  }

  render(width: number): string[] {
    const theme = getTheme();
    return [
      theme.primary("Select model"),
      ...this.search.render(width),
      ...(this.warning ? [truncateToWidth(theme.warning(this.warning), width)] : []),
      ...(this.error ? [truncateToWidth(theme.error(this.error), width)] : []),
      ...this.list.render(width),
      theme.muted("Type to filter • Enter select • Esc cancel"),
    ].map((line) => truncateToWidth(line, width));
  }
}
```

If the test shows that sending one character at a time is not decoded by `Input`, use the exact printable sequence accepted by the installed component; do not add manual editing state.

- [ ] **Step 4: Export ModelPicker and verify GREEN**

Export `model-picker.ts` from `cube-tui/src/index.ts`.

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: all picker tests pass and every rendered line remains within the requested width.

- [ ] **Step 5: Record or commit Task 2**

If Git remains invalid, record `Task 2 commit skipped: incomplete Git metadata`. Otherwise:

```powershell
git add cube-tui/src/components/model-picker.ts cube-tui/src/components/model-picker.test.ts cube-tui/src/index.ts
git commit -m "feat(tui): add searchable model picker"
```

---

### Task 3: Add cancellable loading and deterministic overlay lifecycle

**Files:**
- Create: `cube-tui/src/index.test.ts`
- Modify: `cube-tui/src/index.ts`

**Interfaces:**
- Consumes: `ModelPicker`, `CancellableLoader`, `TUI.showOverlay()`, and the mounted prompt editor.
- Produces: `ModelCatalogView`, `OpenModelPickerOptions`, and `openModelPicker(options): Promise<string | null>` on the object returned by `createApp()`.

- [ ] **Step 1: Write failing overlay lifecycle tests**

Add tests using a terminal stub and a `createApp` overload or injectable `Terminal` so tests do not touch the real process terminal:

```ts
test("loads models, switches the selection, and restores prompt focus", async () => {
  const app = createApp(() => undefined, [], terminal);
  const selected: string[] = [];
  const pending = app.openModelPicker({
    currentModel: "ollama/qwen2.5:7b",
    loadModels: async () => ({
      models: ["ollama/qwen2.5:7b", "google/gemini-2.5-flash"],
      warnings: [],
    }),
    selectModel: async (modelId) => { selected.push(modelId); },
  });

  await settle();
  assert.equal(app.tui.hasOverlay(), true);
  app.modelPicker?.handleInput("\r");
  assert.equal(await pending, "ollama/qwen2.5:7b");
  assert.deepEqual(selected, ["ollama/qwen2.5:7b"]);
  assert.equal(app.promptEditor.focused, true);
});

test("keeps the picker open when switching fails", async () => {
  const app = createApp(() => undefined, [], terminal);
  void app.openModelPicker({
    currentModel: "ollama/qwen2.5:7b",
    loadModels: async () => ({ models: ["ollama/qwen2.5:7b"], warnings: [] }),
    selectModel: async () => { throw new Error("Missing API key"); },
  });

  await settle();
  app.modelPicker?.handleInput("\r");
  await settle();
  assert.equal(app.tui.hasOverlay(), true);
  assert.match(app.modelPicker?.render(80).join("\n") ?? "", /Missing API key/);
});

test("Escape during loading resolves as cancelled and restores focus", async () => {
  const app = createApp(() => undefined, [], terminal);
  const pending = app.openModelPicker({
    currentModel: "ollama/qwen2.5:7b",
    loadModels: () => new Promise(() => undefined),
    selectModel: async () => undefined,
  });

  app.loadingOverlay?.handleInput("\u001b");
  assert.equal(await pending, null);
  assert.equal(app.tui.hasOverlay(), false);
  assert.equal(app.promptEditor.focused, true);
});
```

Return readonly diagnostic getters from `createApp` with these exact types so tests can drive the focused components without exposing overlay handles: `get modelPicker(): ModelPicker | undefined` and `get loadingOverlay(): CancellableLoader | undefined`.

- [ ] **Step 2: Run TUI tests and verify RED**

Run: `pnpm --filter @cube/tui test`

Expected: FAIL because `createApp` has no terminal injection or `openModelPicker` API.

- [ ] **Step 3: Define the TUI picker contract**

Add these interfaces to `cube-tui/src/index.ts`:

```ts
import type { Terminal } from "@earendil-works/pi-tui";

export interface ModelCatalogView {
  models: string[];
  warnings: string[];
}

export interface OpenModelPickerOptions {
  currentModel: string;
  loadModels: (signal: AbortSignal) => Promise<ModelCatalogView>;
  selectModel: (modelId: string) => Promise<void>;
}
```

Change the factory signature without breaking existing callers:

```ts
export const createApp = (
  onEvent: (event: TuiInputEvent) => void,
  slashCommands: TuiSlashCommand[] = [],
  terminal: Terminal = new ProcessTerminal(),
) => { /* existing body */ };
```

- [ ] **Step 4: Implement loading, cancellation, selection, and cleanup**

Inside `createApp`, add an `openModelPicker` method that:

1. Creates `CancellableLoader(tui, theme.primary, theme.muted, "Loading models...")`.
2. Shows it with `tui.showOverlay(loader, { width: "70%", minWidth: 40, anchor: "center", margin: 2 })` and calls `loader.start()`.
3. Races `options.loadModels(loader.signal)` against the loader's `onAbort`, attaching both resolve and reject handlers so late rejection cannot become unhandled.
4. Always calls `loader.dispose()` and hides the loading overlay.
5. Returns `null` on cancellation and throws `new Error("No models are currently available.")` for an empty catalog.
6. Creates `ModelPicker` with a newline-joined warning, shows it using the same centered overlay dimensions, and assigns the picker callback before returning its pending promise.
7. On selection, clears prior inline errors, awaits `options.selectModel(modelId)`, then hides the picker, focuses `promptEditor`, and resolves with the ID.
8. On selection failure, calls `picker.setError(error instanceof Error ? error.message : String(error))` and keeps the promise and overlay active.
9. On Escape, hides the picker, focuses `promptEditor`, and resolves `null`.

Use one local idempotent cleanup function per overlay. Do not call `process.exit`, session APIs, or `writeConfig` in this TUI method.

- [ ] **Step 5: Verify GREEN, cancellation, and type safety**

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: loading appears before catalog completion, cancellation resolves without waiting for late work, failed selection stays visible, and all closing paths restore prompt focus.

- [ ] **Step 6: Record or commit Task 3**

If Git remains invalid, record `Task 3 commit skipped: incomplete Git metadata`. Otherwise:

```powershell
git add cube-tui/src/index.ts cube-tui/src/index.test.ts
git commit -m "feat(tui): manage model picker overlays"
```

---

### Task 4: Extract catalog discovery and wire `/model` to the picker

**Files:**
- Create: `cube-cli/src/model/model-catalog.ts`
- Create: `cube-cli/src/model/model-catalog.test.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.test.ts`
- Modify: `cube-cli/src/index.ts`

**Interfaces:**
- Consumes: Ollama base URL, `fetch`, Mastra `listAvailableModels()` callback, `app.openModelPicker`, session model switching, and `writeConfig`.
- Produces: `discoverModelCatalog(input): Promise<ModelCatalogResult>` and picker-aware `runModelSlashCommand(input): Promise<string | null>`.

- [ ] **Step 1: Write failing catalog tests**

Create `cube-cli/src/model/model-catalog.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { discoverModelCatalog } from "./model-catalog.js";

test("merges, deduplicates, and sorts Ollama and direct Google models", async () => {
  const result = await discoverModelCatalog({
    listOllamaModels: async () => ["ollama/qwen2.5:7b"],
    listMastraModels: async () => [
      { id: "google/gemini-2.5-flash" },
      { id: "netlify/gemini/gemini-2.5-flash" },
      { id: "google/gemini-2.5-flash" },
    ],
  });

  assert.deepEqual(result, {
    models: ["google/gemini-2.5-flash", "ollama/qwen2.5:7b"],
    warnings: [],
  });
});

test("returns partial catalog with a source warning", async () => {
  const result = await discoverModelCatalog({
    listOllamaModels: async () => { throw new Error("offline"); },
    listMastraModels: async () => [{ id: "google/gemini-2.5-flash" }],
  });
  assert.deepEqual(result.models, ["google/gemini-2.5-flash"]);
  assert.match(result.warnings[0] ?? "", /Ollama: offline/);
});

test("throws an actionable aggregate error when both sources fail", async () => {
  await assert.rejects(
    discoverModelCatalog({
      listOllamaModels: async () => { throw new Error("offline"); },
      listMastraModels: async () => { throw new Error("gateway down"); },
    }),
    /Ollama: offline.*Mastra: gateway down/s,
  );
});

test("does not publish a catalog after cancellation", async () => {
  const controller = new AbortController();
  const pending = discoverModelCatalog({
    signal: controller.signal,
    listOllamaModels: async () => ["ollama/qwen2.5:7b"],
    listMastraModels: async () => [{ id: "google/gemini-2.5-flash" }],
  });
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof DOMException && error.name === "AbortError");
});
```

- [ ] **Step 2: Write failing slash-command picker and persistence tests**

Replace the old "lists models" assertion in `model.slash-command.test.ts` with:

```ts
test("opens the picker when no argument is provided", async () => {
  let opened = 0;
  const output = await runModelSlashCommand({
    argument: "",
    openPicker: async () => { opened += 1; return "ollama/qwen2.5:7b"; },
    persistModel: () => undefined,
    switchModel: async () => undefined,
  });
  assert.equal(opened, 1);
  assert.equal(output, "Model changed to ollama/qwen2.5:7b.");
});

test("does not persist when an explicit model switch fails", async () => {
  let persisted = false;
  await assert.rejects(runModelSlashCommand({
    argument: "google/gemini-2.5-flash",
    openPicker: async () => null,
    persistModel: () => { persisted = true; },
    switchModel: async () => { throw new Error("Missing API key"); },
  }), /Missing API key/);
  assert.equal(persisted, false);
});
```

- [ ] **Step 3: Run CLI tests and verify RED**

Run: `pnpm --filter @cube/cli test`

Expected: FAIL because `model-catalog.ts` and the `openPicker` contract do not exist.

- [ ] **Step 4: Implement concurrent catalog discovery**

Create `cube-cli/src/model/model-catalog.ts`:

```ts
export interface AvailableModelRecord { id: string; }
export interface ModelCatalogResult { models: string[]; warnings: string[]; }

export const discoverModelCatalog = async (input: {
  listOllamaModels: () => Promise<string[]>;
  listMastraModels: () => Promise<AvailableModelRecord[]>;
  signal?: AbortSignal;
}): Promise<ModelCatalogResult> => {
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const [ollama, mastra] = await Promise.allSettled([
    input.listOllamaModels(),
    input.listMastraModels(),
  ]);
  if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const warnings: string[] = [];
  const models = new Set<string>();

  if (ollama.status === "fulfilled") {
    ollama.value.forEach((id) => models.add(id));
  } else {
    warnings.push(`Ollama: ${ollama.reason instanceof Error ? ollama.reason.message : String(ollama.reason)}`);
  }

  if (mastra.status === "fulfilled") {
    mastra.value
      .filter((model) => model.id.startsWith("google/"))
      .forEach((model) => models.add(model.id));
  } else {
    warnings.push(`Mastra: ${mastra.reason instanceof Error ? mastra.reason.message : String(mastra.reason)}`);
  }

  if (ollama.status === "rejected" && mastra.status === "rejected") {
    throw new Error(warnings.join("\n"));
  }

  return { models: [...models].sort(), warnings };
};
```

Keep the existing `listOllamaModels(baseUrl, fetcher)` in `model.slash-command.ts` unless moving it to the catalog module materially improves imports; do not duplicate it.

- [ ] **Step 5: Make `/model` dispatch the picker**

Change `runModelSlashCommand` to this contract:

```ts
export const runModelSlashCommand = async (input: {
  argument: string;
  openPicker: () => Promise<string | null>;
  persistModel: (modelId: string) => void;
  switchModel: (modelId: string) => Promise<void>;
}): Promise<string | null> => {
  const modelId = input.argument.trim();
  if (!modelId) {
    const selected = await input.openPicker();
    return selected ? `Model changed to ${selected}.` : null;
  }
  if (!modelId.startsWith("ollama/") && !modelId.startsWith("google/")) {
    return "Supported model prefixes are ollama/ and google/.";
  }
  await input.switchModel(modelId);
  input.persistModel(modelId);
  return `Model changed to ${modelId}.`;
};
```

- [ ] **Step 6: Wire the CLI entrypoint through the new boundaries**

In `cube-cli/src/index.ts`:

1. Import `discoverModelCatalog`.
2. Replace the inline `Set`, failure collection, and sequential discovery block.
3. Define one local `switchAndPersistModel(modelId)` that awaits `session.model.switch({ modelId, scope: "global" })` and then calls `writeConfig({ ...config, model: modelId })`.
4. Pass `openPicker` to `runModelSlashCommand`:

```ts
openPicker: () => app.openModelPicker({
  currentModel: session.model.get() || config.model,
  loadModels: (signal) => discoverModelCatalog({
    signal,
    listOllamaModels: () => listOllamaModels(config.providers.ollama.base_url),
    listMastraModels: () => cubeController.listAvailableModels(),
  }),
  selectModel: switchAndPersistModel,
}),
```

5. Pass `switchModel` and `persistModel` for the explicit argument path without changing their order.
6. Call `showSystemMessage(output)` only when `output` is a non-empty string.

- [ ] **Step 7: Verify GREEN and both package builds**

Run:

```powershell
pnpm --filter @cube/cli test
pnpm --filter @cube/tui test
pnpm --filter @cube/cli build
```

Expected: catalog tests cover partial/total failure, command tests prove picker dispatch and persistence safety, and the entrypoint compiles without cyclic imports.

- [ ] **Step 8: Record or commit Task 4**

If Git remains invalid, record `Task 4 commit skipped: incomplete Git metadata`. Otherwise:

```powershell
git add cube-cli/src/model cube-cli/src/slash-commands cube-cli/src/index.ts
git commit -m "feat(cli): open model picker from slash command"
```

---

### Task 5: Render assistant and system content with native Markdown

**Files:**
- Create: `cube-tui/src/components/message-list.test.ts`
- Modify: `cube-tui/src/components/message-list.ts`

**Interfaces:**
- Consumes: existing `ChatMessage`, `createMarkdownTheme()`, and pi-tui `Markdown`.
- Produces: unchanged `MessageList` public mutation and scroll APIs with improved body rendering.

- [ ] **Step 1: Write failing Markdown rendering tests**

Create `cube-tui/src/components/message-list.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MessageList } from "./message-list.js";

test("renders assistant Markdown instead of literal markers", () => {
  const messages = new MessageList();
  messages.addMessage({ role: "assistant", content: "Use **native** rendering." });
  const output = messages.render(80).join("\n");
  assert.match(output, /native/);
  assert.doesNotMatch(output, /\*\*native\*\*/);
});

test("never returns a line wider than the viewport", () => {
  const messages = new MessageList();
  messages.addMessage({
    role: "assistant",
    content: "`a-very-long-code-token-without-spaces-that-must-be-contained`",
  });
  assert.equal(messages.render(30).every((line) => visibleWidth(line) <= 30), true);
});
```

- [ ] **Step 2: Run TUI tests and verify RED**

Run: `pnpm --filter @cube/tui test`

Expected: the literal Markdown marker assertion fails against the current `wrapTextWithAnsi` renderer.

- [ ] **Step 3: Delegate body rendering to pi-tui Markdown**

Modify `MessageList` so `assistant` and `system` messages render their body using:

```ts
const markdown = new Markdown(
  msg.content,
  2,
  0,
  createMarkdownTheme(),
);
allLines.push(truncateToWidth(prefix.trimEnd(), availableWidth));
allLines.push(...markdown.render(availableWidth));
```

Keep the existing user/tool wrapping path, `addMessage`, `updateLastMessage`, `clear`, `pageUp`, `pageDown`, `scrollToBottom`, and scroll indicator calculations unchanged. Do not move message state into pi-tui components.

- [ ] **Step 4: Verify GREEN and regression behavior**

Run:

```powershell
pnpm --filter @cube/tui test
pnpm --filter @cube/tui build
```

Expected: Markdown semantics render without literal markers, width safety passes, and existing streaming mutation APIs compile unchanged.

- [ ] **Step 5: Record or commit Task 5**

If Git remains invalid, record `Task 5 commit skipped: incomplete Git metadata`. Otherwise:

```powershell
git add cube-tui/src/components/message-list.ts cube-tui/src/components/message-list.test.ts
git commit -m "refactor(tui): render messages with native markdown"
```

---

### Task 6: Full verification and interactive smoke test

**Files:**
- Modify: `cube-tui/src/dev.ts`
- Verify only: all package sources and generated build output

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: verified monorepo and documented runtime evidence; no new runtime abstraction.

- [ ] **Step 1: Make the TUI preview exercise native slash autocomplete**

Change `cube-tui/src/dev.ts` to call `createApp` with representative metadata:

```ts
const app = createApp(
  (_event) => { /* pure UI preview */ },
  [
    { name: "/compact", description: "Finalize observational memory" },
    { name: "/exit", description: "Exit Cube" },
    { name: "/model", description: "List or switch the active model" },
  ],
);
```

- [ ] **Step 2: Run the full automated verification sequence**

Run:

```powershell
pnpm peers check
pnpm --recursive --if-present test
pnpm run build
node --check cube-cli/dist/index.js
```

Expected: peer check is clean, every package test passes, all four workspace packages build, and the CLI artifact parses.

- [ ] **Step 3: Smoke the configured Ollama catalog**

Run a focused Node/TypeScript smoke using `listOllamaModels(config.providers.ollama.base_url)` and assert the result contains at least one `ollama/` ID. On the current machine the expected known result is `ollama/qwen2.5:7b`; report a different non-empty local catalog as current state rather than forcing that model name.

- [ ] **Step 4: Exercise the model catalog boundary**

Run `discoverModelCatalog` against the configured Ollama endpoint and `cubeController.listAvailableModels()`, with a 15-second diagnostic timeout and explicit process cleanup. Verify the result contains the configured Ollama ID and at least one direct `google/` ID when the Mastra gateway is reachable.

- [ ] **Step 5: Run the interactive CLI smoke in a real terminal**

Run: `pnpm dev`

Verify manually:

1. Typing `/` opens native slash autocomplete.
2. Up/Down and Tab complete a command without producing `//model`.
3. Submitting `/model` immediately displays `Loading models...`.
4. The model picker shows the active model, local Ollama models, and available direct Google models.
5. Typing `ollama/q` filters the list; Up/Down navigate; Escape closes and returns focus.
6. Reopen `/model`, select a model with Enter, and confirm the footer changes.
7. Restart Cube and confirm the successfully selected model is read from config.
8. If selecting an unauthenticated Google model fails, confirm the picker stays open with the error and `config.yaml` remains unchanged.

- [ ] **Step 6: Inspect generated artifacts and final source state**

Run:

```powershell
Get-ChildItem cube-agent,cube-cli,cube-tui,cube-workspace -Recurse -Include *.tsbuildinfo | Select-Object FullName
Get-ChildItem cube-agent,cube-cli,cube-tui,cube-workspace -Directory -Filter dist | Select-Object FullName
```

Do not delete build output unless explicitly requested. Report which artifacts were produced by verification.

- [ ] **Step 7: Record or commit Task 6**

If Git remains invalid, report that integration was verified but no commit was possible. Otherwise:

```powershell
git add cube-tui/src/dev.ts
git commit -m "test(tui): add native component smoke preview"
git status --short
```

Expected final handoff: changed-file summary, exact test/build counts, catalog smoke evidence, interactive behaviors verified or explicitly marked as requiring the user's real terminal, and no claim that Git operations succeeded when metadata is unavailable.
