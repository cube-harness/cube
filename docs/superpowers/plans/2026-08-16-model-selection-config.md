# Capability-Aware Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/model` select, validate, persist, and restore a global model together with only the reasoning-effort configuration supported by that exact model.

**Architecture:** Cube Agent owns a single cached models.dev cloud catalog, fresh Ollama discovery, capability normalization, semantic validation, and provider-option mapping. Cube CLI coordinates the transaction, Cube Workspace owns the YAML schema and atomic file write, and Cube TUI renders a provider-agnostic inline two-step selector.

**Tech Stack:** TypeScript 5.7, Node.js 22, Zod 4, YAML 2.7, Mastra 1.56, AI SDK 6, `@earendil-works/pi-tui` 0.83, Node test runner through `tsx`.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-16-model-selection-config-design.md`.
- Use arrow functions for every new or modified function; TUI components remain exported classes because they implement pi-tui component state.
- Keep tests under each package's `tests/` directory, never beside production files under `src/`.
- Write the tests before the corresponding implementation, but do not run test, build, typecheck, or syntax commands until Task 7.
- Do not make live inference requests. A live provider smoke test requires separate explicit user approval.
- Do not add dependencies; `cube-agent` already has Zod and the other packages already contain the required libraries.
- Do not persist model config in Mastra thread settings. `config.yaml` is the global source of truth and runtime state is process-global.
- Do not apply the selected primary model config to fallback, observational-memory, reflection, title, or other internal model calls.
- Do not initialize Git. `D:\cube` is not a Git repository, so this plan contains review checkpoints instead of commit commands.

---

## File Map

### Create

- `cube-agent/src/model-catalog.ts` — fetches, caches, parses, filters, and normalizes cloud and Ollama catalog entries.
- `cube-agent/src/model-selection.ts` — owns normalized selection types, semantic validation, provider-option mapping, and process-global active selection state.
- `cube-agent/tests/model-catalog.test.ts` — deterministic models.dev/Ollama catalog fixtures.
- `cube-agent/tests/model-selection.test.ts` — validation, mapping, isolation, and transactional runtime-state tests.
- `cube-tui/src/components/model-config-picker.ts` — inline reasoning-effort `SelectList` component.
- `cube-tui/tests/model-picker.test.ts` — model list behavior outside `src`.
- `cube-tui/tests/model-config-picker.test.ts` — effort list and keyboard behavior.
- `cube-tui/tests/model-selection-flow.test.ts` — inline two-step application flow.
- `cube-cli/tests/model.slash-command.test.ts` — command orchestration and rollback tests moved out of `src`.
- `cube-cli/tests/registry.test.ts` — registry test moved out of `src` and updated for the selection contract.
- `cube-cli/tests/compact.slash-command.test.ts` — existing test moved without behavior changes.
- `cube-cli/tests/exit.slash-command.test.ts` — existing test moved without behavior changes.

### Modify

- `cube-workspace/src/schemas/config.schema.ts` — adds `ReasoningEffortSchema`, `ModelConfigSchema`, and `model_config`.
- `cube-workspace/src/cube-home/config.yaml` — adds the packaged `model_config: {}` default.
- `cube-workspace/src/home.ts` — writes config through a same-directory temporary file and atomic rename.
- `cube-workspace/src/index.ts` — exports model-config schemas and their inferred types.
- `cube-workspace/tests/home.test.ts` — covers schema/default/write/recovery behavior.
- `cube-agent/src/agents/default.agent.ts` — resolves the primary entry from active selection state and attaches only mapped provider options.
- `cube-agent/src/index.ts` — constructs the catalog/selection runtime and exposes the new runtime contract and warnings.
- `cube-tui/src/components/model-picker.ts` — consumes catalog view entries rather than raw strings.
- `cube-tui/src/index.ts` — changes the model picker API to return a complete selection and coordinates the second picker inline.
- `cube-tui/package.json` — points the test script at `tests/**/*.test.ts`.
- `cube-cli/src/slash-commands/model.slash-command.ts` — replaces string-only switching with the complete selection transaction.
- `cube-cli/src/slash-commands/registry.ts` — consumes the revised model-command dependencies.
- `cube-cli/src/index.ts` — wires catalog, TUI, prepare/apply/restore, persistence, startup warnings, and current selection.
- `cube-cli/package.json` — points the test script at `tests/**/*.test.ts`.

### Delete after moving

- `cube-cli/src/slash-commands/model.slash-command.test.ts`
- `cube-cli/src/slash-commands/registry.test.ts`
- `cube-cli/src/slash-commands/compact.slash-command.test.ts`
- `cube-cli/src/slash-commands/exit.slash-command.test.ts`

---

### Task 1: Persist the Global Model Config Safely

**Files:**
- Modify: `cube-workspace/src/schemas/config.schema.ts`
- Modify: `cube-workspace/src/cube-home/config.yaml`
- Modify: `cube-workspace/src/home.ts`
- Modify: `cube-workspace/src/index.ts`
- Test: `cube-workspace/tests/home.test.ts`

**Interfaces:**
- Produces: `ReasoningEffort`, `ModelConfig`, and `CubeConfig.model_config` for every later task.
- Produces: existing `workspace.config.write(config)` behavior with atomic replacement and the same `CubeResult<CubeConfig>` contract.

- [ ] **Step 1: Add schema and default tests without running them**

Add cases to `cube-workspace/tests/home.test.ts` proving:

```ts
assert.deepEqual(initial.value.model_config, {});

const writeResult = workspace.config.write({
  ...initial.value,
  model: "openai/gpt-5.1",
  model_config: { reasoning_effort: "high" },
});
assert.equal(writeResult.ok, true);

const invalid = workspace.config.write({
  ...initial.value,
  model_config: { reasoning_effort: "impossible" },
} as never);
assert.equal(invalid.ok, false);
```

Extend the existing valid-write test to reread and assert both `model` and `model_config`. Add an atomic-write test that asserts `config.yaml.tmp` is absent after success. Add a failure test that blocks the temporary path, expects `ok: false`, and verifies the original `config.yaml` content is unchanged.

- [ ] **Step 2: Add the normalized Workspace types**

In `cube-workspace/src/schemas/config.schema.ts`, add and export:

```ts
export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const ModelConfigSchema = z.object({
  reasoning_effort: ReasoningEffortSchema.optional(),
}).strict().default({});

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
```

Add `model_config: ModelConfigSchema` immediately after `model` in `ConfigSchema`. Export `ReasoningEffortSchema`, `ModelConfigSchema`, and the two inferred types from `cube-workspace/src/index.ts`.

- [ ] **Step 3: Update the packaged YAML default**

In `cube-workspace/src/cube-home/config.yaml`, keep the current model and add:

```yaml
model: ollama/qwen2.5:7b
model_config: {}
fallback_model: google/gemini-2.5-flash
```

Do not add config for `fallback_model`.

- [ ] **Step 4: Replace direct writes with same-directory atomic replacement**

In `cube-workspace/src/home.ts`, keep validation before I/O and replace the final direct `writeFileSync(configPath, stringify(validated.data), "utf8")` with a focused arrow helper:

```ts
const writeTextAtomically = (target: string, content: string): void => {
  const temporary = `${target}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) {
      try { rmSync(temporary, { force: true }); } catch { /* original error wins */ }
    }
  }
};
```

Import only `existsSync`, `renameSync`, and `rmSync` in addition to the existing Node filesystem functions. The helper operates on one explicit config path and never recursively removes a directory.

- [ ] **Step 5: Review the Task 1 diff without executing verification**

Confirm `model_config` is strict, defaults to `{}`, and does not appear under `fallback_model`. Confirm the packaged config parses by inspection and the atomic helper never targets a directory outside the selected Cube home.

---

### Task 2: Build One Capability-Aware Model Catalog

**Files:**
- Create: `cube-agent/src/model-catalog.ts`
- Create: `cube-agent/tests/model-catalog.test.ts`
- Modify: `cube-agent/src/index.ts` only to export the new public types/functions; runtime wiring waits for Task 4.

**Interfaces:**
- Consumes: `ReasoningEffort` and `ReasoningEffortSchema` from `@cube/workspace`.
- Produces:

```ts
export interface ModelCatalogEntry {
  id: string;
  provider: string;
  config: {
    reasoningEffort?: { values: ReasoningEffort[] };
  };
}

export interface ModelCatalogResult {
  models: ModelCatalogEntry[];
  warnings: string[];
}

export interface ModelCatalog {
  list: (signal?: AbortSignal) => Promise<ModelCatalogResult>;
  find: (modelId: string, signal?: AbortSignal) => Promise<ModelCatalogEntry | null>;
}

export const createModelCatalog: (input: {
  ollamaBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  modelsDevUrl?: string;
}) => ModelCatalog;
```

- [ ] **Step 1: Write deterministic catalog fixtures without running them**

Create `cube-agent/tests/model-catalog.test.ts` with a first test named `normalizes authenticated cloud and Ollama models`, a fake fetcher, and a fixture containing:

```ts
const modelsDevFixture = {
  google: {
    env: ["GOOGLE_API_KEY"],
    models: {
      "gemini-3.6-flash": {
        reasoning: true,
        reasoning_options: {
          type: "effort",
          values: ["minimal", "low", "medium", "high"],
        },
      },
      "gemini-2.5-pro": {
        reasoning: true,
        reasoning_options: { type: "budget_tokens", min: 128, max: 32768 },
      },
      "gemini-2.0-flash": { reasoning: false },
    },
  },
  openai: {
    env: ["OPENAI_API_KEY"],
    models: {
      "gpt-5.1": {
        reasoning: true,
        reasoning_options: {
          type: "effort",
          values: ["none", "low", "medium", "high"],
        },
      },
    },
  },
  openrouter: {
    env: ["OPENROUTER_API_KEY"],
    models: {
      "openai/gpt-5.1": {
        reasoning: true,
        reasoning_options: {
          type: "effort",
          values: ["none", "low", "medium", "high"],
        },
      },
      "openrouter/free": { reasoning: true },
    },
  },
};
```

Cover authenticated filtering, full nested OpenRouter IDs, effort normalization, budget-only exclusion, non-reasoning exclusion, deprecated-model exclusion, deduplication, stable sorting, Ollama `/tags`, partial source failure, both-source failure, abort behavior, one cloud fetch across repeated `list()` calls, shared in-flight cloud fetch, and a fresh Ollama request on each list.

- [ ] **Step 2: Define minimal passthrough Zod schemas**

In `cube-agent/src/model-catalog.ts`, parse only fields Cube consumes:

```ts
const effortOptionSchema = z.object({
  type: z.literal("effort"),
  values: z.array(z.string()),
}).passthrough();

const reasoningOptionSchema = z.union([
  effortOptionSchema,
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({ type: z.literal("budget_tokens") }).passthrough(),
]);

const modelSchema = z.object({
  reasoning: z.boolean().optional(),
  reasoning_options: z.union([
    reasoningOptionSchema,
    z.array(reasoningOptionSchema),
  ]).optional(),
  status: z.string().optional(),
}).passthrough();
```

Provider entries require `env: string[]` and `models: Record<string, modelSchema>`, while the top level remains a provider record.

- [ ] **Step 3: Normalize exact model capabilities**

Add arrow helpers that:

```ts
const SUPPORTED_MAPPERS = new Set(["openai", "google", "openrouter"]);

const normalizeEfforts = (
  provider: string,
  raw: unknown,
): ReasoningEffort[] => {
  if (!SUPPORTED_MAPPERS.has(provider)) return [];
  const options = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return options
    .filter((option): option is z.infer<typeof effortOptionSchema> =>
      effortOptionSchema.safeParse(option).success,
    )
    .flatMap(({ values }) => values)
    .map((value) => ReasoningEffortSchema.safeParse(value))
    .filter((result) => result.success)
    .map((result) => result.data)
    .filter((value, index, values) => values.indexOf(value) === index);
};
```

Build IDs as `${provider}/${modelName}`. Exclude `status === "deprecated"`. A provider is authenticated when at least one declared environment key has a non-empty trimmed value. Include authenticated models even when config is `{}`.

- [ ] **Step 4: Implement a successful-only cloud cache and fresh local discovery**

Use one closure-scoped `Promise<ModelCatalogEntry[]> | undefined`. Assign it before awaiting so concurrent callers share it. Clear the promise on rejection so a later `/model` can retry. Do not cache abort failures as a permanent catalog failure.

Fetch Ollama independently through `${ollamaBaseUrl.replace(/\/$/, "")}/tags` on every `list()`. Merge cloud and local with `Promise.allSettled`, surface source-specific warnings, and throw the joined warnings only when neither source produces a usable catalog.

Implement `find(modelId, signal)` by calling `list(signal)` once and returning the exact-ID match or `null`. It inherits the same partial-source warnings and cache behavior; it must not perform a second cloud or Ollama request after `list()` within the same call.

- [ ] **Step 5: Export the catalog contract**

Export `createModelCatalog`, `ModelCatalog`, `ModelCatalogEntry`, and `ModelCatalogResult` from `cube-agent/src/index.ts`. Do not expose the raw models.dev response.

- [ ] **Step 6: Review the Task 2 diff without network or test execution**

Confirm no provider list endpoint other than models.dev is called, Ollama is the only URL-configured local provider, cloud auth is environment-only, and `openrouter/openai/gpt-5.1` cannot collapse into `openai/gpt-5.1`.

---

### Task 3: Validate and Map Complete Model Selections

**Files:**
- Create: `cube-agent/src/model-selection.ts`
- Create: `cube-agent/tests/model-selection.test.ts`
- Modify: `cube-agent/src/index.ts` to export selection contracts.

**Interfaces:**
- Consumes: `ModelConfig`, `ReasoningEffort`, and `ModelCatalogEntry`.
- Produces:

```ts
export interface ModelSelection {
  modelId: string;
  config: ModelConfig;
}

export interface PreparedModelSelection {
  selection: ModelSelection;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface SelectionValidationResult {
  prepared: PreparedModelSelection;
  warnings: string[];
}

export const prepareModelSelection: (
  selection: ModelSelection,
  catalogEntry: ModelCatalogEntry | null,
) => SelectionValidationResult;

export const createActiveModelSelection: (
  initial: PreparedModelSelection,
) => {
  get: () => PreparedModelSelection;
  set: (selection: PreparedModelSelection) => void;
};
```

- [ ] **Step 1: Write semantic validation and mapping tests without running them**

Cover:

```ts
prepareModelSelection(
  { modelId: "openai/gpt-5.1", config: { reasoning_effort: "high" } },
  openAiEntry,
).prepared.providerOptions;
// { openai: { reasoningEffort: "high" } }

prepareModelSelection(
  { modelId: "google/gemini-3.6-flash", config: { reasoning_effort: "medium" } },
  googleEntry,
).prepared.providerOptions;
// { google: { thinkingConfig: { thinkingLevel: "medium" } } }

prepareModelSelection(
  { modelId: "openrouter/openai/gpt-5.1", config: { reasoning_effort: "low" } },
  openRouterEntry,
).prepared.providerOptions;
// { openrouter: { reasoning: { effort: "low" } } }
```

Also cover `{}` producing `providerOptions === undefined`, unsupported values being omitted with one warning, a missing catalog entry omitting non-empty config with one warning, model ID mismatch rejection, budget-only entries omitting effort, immutable snapshots, and `set()` replacing the whole selection instead of merging configs.

- [ ] **Step 2: Implement pure semantic preparation**

`prepareModelSelection` must never mutate runtime state. It verifies that the catalog entry ID matches `selection.modelId`; if the config is empty, it accepts the model without needing a capability entry. For non-empty config, it requires the exact effort value in `catalogEntry.config.reasoningEffort.values`.

Unsupported config is normalized to `{}` and produces a message naming both the model and the ignored effort. Do not throw for unsupported user-edited config. Reserve thrown errors for malformed internal contracts such as a mismatched catalog entry.

- [ ] **Step 3: Implement provider-option mapping as one closed switch**

Use the first path segment only to select a mapper:

```ts
const mapProviderOptions = (selection: ModelSelection) => {
  const effort = selection.config.reasoning_effort;
  if (!effort) return undefined;

  const provider = selection.modelId.split("/", 1)[0];
  switch (provider) {
    case "openai":
      return { openai: { reasoningEffort: effort } };
    case "google":
      return { google: { thinkingConfig: { thinkingLevel: effort } } };
    case "openrouter":
      return { openrouter: { reasoning: { effort } } };
    default:
      return undefined;
  }
};
```

Do not inspect model-name substrings. Capability validation has already decided whether the field is legal.

- [ ] **Step 4: Add replace-only active state**

`createActiveModelSelection` uses `structuredClone` for defensive copies of the selection and provider-options objects. `get()` returns a snapshot. `set()` replaces model ID, config, and provider options together so config from the previous model cannot leak.

- [ ] **Step 5: Export selection contracts and review the diff**

Export the public interfaces and arrow factories from `cube-agent/src/index.ts`. Confirm this module imports no TUI or Workspace file APIs and performs no network or persistence calls.

---

### Task 4: Integrate Selection State into Cube Agent Runtime

**Files:**
- Modify: `cube-agent/src/agents/default.agent.ts`
- Modify: `cube-agent/src/index.ts`
- Modify: `cube-agent/tests/runtime-session.test.ts`
- Modify: `cube-agent/tests/model-selection.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog`, `PreparedModelSelection`, and active selection state from Tasks 2-3.
- Produces additions to `CubeRuntime`:

```ts
interface CubeRuntime {
  // existing fields remain
  getModelSelection: () => ModelSelection;
  listAvailableModels: ModelCatalog["list"];
  prepareModelSelection: (
    selection: ModelSelection,
    entry: ModelCatalogEntry | null,
  ) => SelectionValidationResult;
  applyModelSelection: (prepared: PreparedModelSelection) => Promise<void>;
  warnings: string[];
}
```

- [ ] **Step 1: Add runtime integration tests without running them**

Extend `cube-agent/tests/runtime-session.test.ts` and `model-selection.test.ts` to prove:

- initial `config.model_config` reaches the primary model entry;
- fallback entry contains no copied provider options;
- `getModelSelection()` returns the active global selection;
- successful apply updates the session model ID and active config together;
- failed session switch retains the prior active selection;
- a partially changed session ID is restored to the previous ID before apply rejects;
- startup unsupported config yields a warning and active `{}` config;
- observational-memory and actor-model setup do not receive the interactive `providerOptions`.

Use fake catalog and fake session-model functions; do not initialize a live provider.

- [ ] **Step 2: Make the default agent consume active selection state**

Change `createDefaultAgent` input from a fixed primary `model` string to:

```ts
getModelSelection: () => PreparedModelSelection;
```

The dynamic `model` function constructs the primary entry from the current snapshot:

```ts
const active = input.getModelSelection();
const primary = {
  model: input.resolveModel(active.selection.modelId),
  maxRetries: 2,
  ...(active.providerOptions ? { providerOptions: active.providerOptions } : {}),
};
```

Append the fallback entry exactly as today with `{ model, maxRetries: 1 }` and no provider options. Remove request-context/thread-derived model selection from `default.agent.ts`; runtime global state is the source of truth.

- [ ] **Step 3: Construct catalog and normalized initial state in `createCubeRuntime`**

Create one catalog using configured Ollama URL. Build the initial selection from `input.config.model` and `input.config.model_config`.

If initial config is empty, prepare it without a catalog lookup. If it is non-empty, call `catalog.find(modelId)` once. On catalog failure or unsupported config, keep the model ID, normalize config to `{}`, and append an actionable warning instead of failing runtime creation.

Pass `activeSelection.get` into `createDefaultAgent`. Keep `actorModel` and other memory construction unchanged so internal model calls use their existing settings.

- [ ] **Step 4: Implement commit-or-restore runtime apply**

After the session exists, expose an arrow function that captures the old selection and session model ID, switches the Mastra session model with `scope: "global"`, and only then replaces active selection state.

If session switching rejects, compare the current session model ID with the old ID. If it changed, attempt a second session switch back to the old ID. Reject with an error containing both failures when restoration also fails. Active selection state must remain unchanged on every failed path.

- [ ] **Step 5: Replace the old raw model-list export**

Remove the `CubeController["listAvailableModels"]` runtime exposure and return `catalog.list` instead. Return `warnings`, `getModelSelection`, `prepareModelSelection`, and `applyModelSelection` alongside existing session, prompt, memory, and close functions.

- [ ] **Step 6: Review Task 4 boundaries without executing verification**

Confirm model config is process-global, the session only mirrors the model ID, thread settings do not store config, primary provider options are recomputed per turn, and fallback/internal calls cannot inherit them.

---

### Task 5: Render the Inline Two-Step TUI Flow

**Files:**
- Create: `cube-tui/src/components/model-config-picker.ts`
- Create: `cube-tui/tests/model-picker.test.ts`
- Create: `cube-tui/tests/model-config-picker.test.ts`
- Create: `cube-tui/tests/model-selection-flow.test.ts`
- Modify: `cube-tui/src/components/model-picker.ts`
- Modify: `cube-tui/src/index.ts`
- Modify: `cube-tui/package.json`

**Interfaces:**
- Produces provider-agnostic view contracts:

```ts
export interface ModelCatalogItemView {
  id: string;
  reasoningEfforts?: string[];
}

export interface TuiModelSelection {
  modelId: string;
  config: { reasoning_effort?: string };
}

export interface OpenModelPickerOptions {
  currentSelection: TuiModelSelection;
  requestedModelId?: string;
  loadModels: (signal: AbortSignal) => Promise<{
    models: ModelCatalogItemView[];
    warnings: string[];
  }>;
}
```

- Produces: `openModelPicker(options): Promise<TuiModelSelection | null>` with no runtime mutation callback.

- [ ] **Step 1: Write component and flow tests without running them**

Use `VirtualTerminal` or direct component rendering to cover:

- current model marking and filtering;
- model selection with no efforts returning `{ modelId, config: {} }`;
- effort-capable selection opening a second inline `SelectList`;
- Enter returning the selected effort;
- Escape from effort returning to the model list for list-based flow;
- Escape from effort cancelling explicit-ID flow;
- explicit unknown ID showing an error without opening an effort list;
- source warnings rendering inline;
- every rendered line staying within the supplied width.

- [ ] **Step 2: Make `ModelPicker` consume item views**

Change `ModelPickerOptions.models` from `string[]` to `ModelCatalogItemView[]`. Keep its search input and `SelectList`. Store the model ID as `value`, use the ID as label, and retain the current marker. `onSelect` still returns a model ID only.

- [ ] **Step 3: Add `ModelConfigPicker` as an exported class**

Implement `Component` and `Focusable` using pi-tui `SelectList`:

```ts
export interface ModelConfigPickerOptions {
  modelId: string;
  efforts: string[];
  currentEffort?: string;
}

export class ModelConfigPicker implements Component, Focusable {
  onSelect?: (effort: string) => void;
  onBack?: () => void;
  private isFocused = false;
  // focused reads/writes isFocused; input/invalidate/render delegate to SelectList.
}
```

Render `Configure <modelId>`, the effort list, and `Enter select • Esc back`. Truncate every returned line with `truncateToWidth`.

- [ ] **Step 4: Refactor `openModelPicker` into a stateful inline flow**

Keep `CancellableLoader` and `inlineControlHost`. Remove `selectModel` from the options contract. After catalog load:

- for `requestedModelId`, find the exact catalog item or reject with an availability/authentication error;
- otherwise mount `ModelPicker`;
- when the selected item has no efforts, resolve a complete `{ modelId, config: {} }`;
- when efforts exist, replace the model component with `ModelConfigPicker` in the same inline host;
- for list-based flow, config Escape remounts the existing model list and preserves its filter/selection state;
- for explicit flow, config Escape closes and resolves `null`;
- close logic always restores focus to `PromptEditor` and removes only the currently active inline component.

Preselect the current effort only when the chosen ID equals the current model and that effort remains in the supported list. The user must still press Enter to confirm it.

- [ ] **Step 5: Point the TUI test script outside `src`**

Change:

```json
"test": "tsx --test --test-isolation=none tests/**/*.test.ts"
```

- [ ] **Step 6: Review Task 5 rendering and ownership**

Confirm no TUI file imports `@cube/agent` or `@cube/workspace`, no TUI callback persists or switches a model, all controls remain in `inlineControlHost`, and no overlay or centered popup is introduced.

---

### Task 6: Make `/model` Own the Transaction

**Files:**
- Create: `cube-cli/tests/model.slash-command.test.ts`
- Create: `cube-cli/tests/registry.test.ts`
- Create: `cube-cli/tests/compact.slash-command.test.ts`
- Create: `cube-cli/tests/exit.slash-command.test.ts`
- Modify: `cube-cli/src/slash-commands/model.slash-command.ts`
- Modify: `cube-cli/src/slash-commands/registry.ts`
- Modify: `cube-cli/src/index.ts`
- Modify: `cube-cli/package.json`
- Delete: the four corresponding `cube-cli/src/slash-commands/*.test.ts` files after their contents are moved.

**Interfaces:**
- Consumes: Agent `ModelSelection`, `ModelCatalogResult`, `prepareModelSelection`, and `applyModelSelection`; TUI `TuiModelSelection`; Workspace `CubeConfig`.
- Produces revised `ModelCommandDependencies`:

```ts
export interface ModelCommandDependencies {
  getCurrentSelection: () => ModelSelection;
  getPersistedSelection: () => ModelSelection;
  loadCatalog: (signal: AbortSignal) => Promise<ModelCatalogResult>;
  openModelPicker: (
    options: OpenModelPickerOptions,
  ) => Promise<TuiModelSelection | null>;
  prepareSelection: (
    selection: ModelSelection,
    entry: ModelCatalogEntry | null,
  ) => SelectionValidationResult;
  applySelection: (prepared: PreparedModelSelection) => Promise<void>;
  persistSelection: (selection: ModelSelection) => void;
  showMessage: (message: string) => void;
}
```

- [ ] **Step 1: Move all existing CLI tests out of `src` without changing assertions**

Move the compact, exit, registry, and model test contents into `cube-cli/tests`. Update relative imports from `./file.js` to `../src/slash-commands/file.js`. Delete the old test files only after each destination contains the full source test content.

Change the CLI package script to:

```json
"test": "tsx --test --test-isolation=none tests/**/*.test.ts"
```

- [ ] **Step 2: Replace string-switch tests with transaction tests without running them**

Update `cube-cli/tests/model.slash-command.test.ts` to cover:

- empty argument opens model list;
- explicit model ID is forwarded as `requestedModelId` and still opens config UI;
- picker cancellation performs no prepare, persist, or apply;
- successful selection calls prepare, persist, then apply in that exact order;
- success message includes `(reasoning: high)` only when effort exists;
- persistence failure prevents apply;
- apply failure writes the previous selection back;
- rollback restores the previous persisted YAML selection even when startup semantic normalization made the active runtime config `{}`;
- rollback persistence failure reports both errors and never reports success;
- partial catalog warnings remain TUI view data rather than becoming a command failure;
- unauthenticated/unknown explicit IDs are rejected by the TUI catalog match and do not mutate state.

Use callback arrays such as `calls.push("persist:new")` to assert order deterministically.

- [ ] **Step 3: Replace the model command contract and remove direct discovery**

Delete `AvailableModelRecord`, `listOllamaModels`, and `discoverModelCatalog` from `cube-cli/src/slash-commands/model.slash-command.ts`; catalog ownership moved to Cube Agent.

The handler builds `OpenModelPickerOptions` from the current selection, optional trimmed argument, and `loadCatalog`. Its `loadModels` callback stores the loaded Agent catalog in a command-local variable and maps it to TUI view objects. This guarantees the picker and the later semantic lookup use the same catalog result without a second catalog call.

After the picker returns, find the exact entry in that stored result. Convert the TUI's string field back to the Agent union by selecting the same value from `entry.config.reasoningEffort.values`; throw an internal-contract error when the TUI returns a value absent from the entry instead of casting it.

Define the boundary mapper in the command module:

```ts
const toModelCatalogView = (catalog: ModelCatalogResult) => ({
  models: catalog.models.map((entry) => ({
    id: entry.id,
    ...(entry.config.reasoningEffort
      ? { reasoningEfforts: [...entry.config.reasoningEffort.values] }
      : {}),
  })),
  warnings: [...catalog.warnings],
});
```

- [ ] **Step 4: Implement persist-then-apply with persisted rollback**

Use this sequence inside the command handler:

```ts
const current = dependencies.getCurrentSelection();
const previousPersisted = dependencies.getPersistedSelection();
let loadedCatalog: ModelCatalogResult | undefined;
const candidate = await dependencies.openModelPicker({
  currentSelection: current,
  ...(argument ? { requestedModelId: argument } : {}),
  loadModels: async (signal) => {
    loadedCatalog = await dependencies.loadCatalog(signal);
    return toModelCatalogView(loadedCatalog);
  },
});
if (!candidate) return;

const entry = loadedCatalog?.models.find(({ id }) => id === candidate.modelId);
if (!entry) throw new Error(`Selected model is unavailable: ${candidate.modelId}`);

const requestedEffort = candidate.config.reasoning_effort;
const reasoningEffort = requestedEffort
  ? entry.config.reasoningEffort?.values.find((value) => value === requestedEffort)
  : undefined;
if (requestedEffort && !reasoningEffort) {
  throw new Error(`Unsupported reasoning effort returned by TUI: ${requestedEffort}`);
}

const selection: ModelSelection = {
  modelId: candidate.modelId,
  config: reasoningEffort ? { reasoning_effort: reasoningEffort } : {},
};
const validated = dependencies.prepareSelection(selection, entry);
validated.warnings.forEach(dependencies.showMessage);

dependencies.persistSelection(validated.prepared.selection);
try {
  await dependencies.applySelection(validated.prepared);
} catch (applyError) {
  try {
    dependencies.persistSelection(previousPersisted);
  } catch (rollbackError) {
    throw new AggregateError(
      [applyError, rollbackError],
      "Model apply failed and config rollback also failed.",
    );
  }
  throw applyError;
}

const effort = validated.prepared.selection.config.reasoning_effort;
dependencies.showMessage(
  `Model changed to ${validated.prepared.selection.modelId}${
    effort ? ` (reasoning: ${effort})` : ""
  }.`,
);
```

Agent apply already guarantees commit-or-restore for runtime state. The CLI only rolls back disk/config closure state.

- [ ] **Step 5: Wire complete selection persistence in `cube-cli/src/index.ts`**

Replace `getCurrentModel`, raw controller list, string switch, and model-only persistence with:

```ts
getCurrentSelection: activeRuntime.getModelSelection,
getPersistedSelection: () => ({
  modelId: config.model,
  config: config.model_config,
}),
loadCatalog: activeRuntime.listAvailableModels,
prepareSelection: activeRuntime.prepareModelSelection,
applySelection: activeRuntime.applyModelSelection,
persistSelection: (selection) => {
  const writeResult = workspace.config.write({
    ...config,
    model: selection.modelId,
    model_config: selection.config,
  });
  if (!writeResult.ok) throw new Error(writeResult.error);
  config = writeResult.value;
},
```

Wire `openModelPicker` to `app.openModelPicker`; the command handler remains the sole Agent-to-TUI mapper through `toModelCatalogView`. Show every `activeRuntime.warnings` item after `app` exists. Keep `app.setInfo().model` as the active model ID; no thread model config is introduced.

- [ ] **Step 6: Update registry fixtures for the new dependency shape**

Keep `/model` metadata and handler registration in `registry.ts`. Update only the model dependency fixture in `cube-cli/tests/registry.test.ts`; do not move model orchestration into the registry or `index.ts`.

- [ ] **Step 7: Review the Task 6 transaction without executing verification**

Trace cancellation, success, persistence failure, apply failure, and rollback failure by inspection. Confirm the command never calls inference, never retries a prompt, and never writes model config before the user completes every required picker step.

---

### Task 7: Final Verification Only

**Files:**
- Verify all files touched in Tasks 1-6.
- Do not add a live-provider smoke script.

**Interfaces:**
- Consumes every completed implementation and test from Tasks 1-6.
- Produces the only verification evidence for this plan.

- [ ] **Step 1: Confirm test placement before executing anything**

Run:

```powershell
$misplacedTests = rg --files cube-workspace cube-agent cube-cli cube-tui |
  rg "src[/\\].*\.test\.ts$"
if ($LASTEXITCODE -eq 0) {
  $misplacedTests
  throw "Tests remain under src."
}
if ($LASTEXITCODE -ne 1) {
  throw "Unable to inspect test placement."
}
```

Expected: no output.

- [ ] **Step 2: Clean generated build state and perform a fresh build**

Run:

```powershell
pnpm --recursive run clean
pnpm run build
```

Expected: all four packages build successfully from clean outputs and Workspace bootstrap assets are copied into its distribution.

- [ ] **Step 3: Run package tests for the first time in this implementation**

Run:

```powershell
pnpm --filter @cube/workspace test
pnpm --filter @cube/agent test
pnpm --filter @cube/tui test
pnpm --filter @cube/cli test
```

Expected: every package reports zero failing tests. If any test fails, fix the smallest responsible task and rerun the failing package before continuing.

- [ ] **Step 4: Run repository-wide type and syntax checks**

Run:

```powershell
pnpm run typecheck
node --check cube-cli/dist/index.js
```

Expected: TypeScript build mode exits zero and Node reports no syntax error.

- [ ] **Step 5: Run deterministic focused catalog smoke without network**

Use the catalog fixture test through its exact test-name pattern:

```powershell
pnpm --filter @cube/agent exec tsx --test --test-isolation=none --test-name-pattern "normalizes authenticated cloud and Ollama models" tests/model-catalog.test.ts
```

Expected: the focused test passes and confirms nested OpenRouter IDs plus reasoning-effort normalization without accessing the internet.

- [ ] **Step 6: Inspect source ownership and forbidden call paths**

Run:

```powershell
rg -n "listAvailableModels\(|models\.dev/api\.json|reasoningEffort|thinkingLevel|reasoning:\s*\{\s*effort" cube-agent/src cube-cli/src cube-tui/src cube-workspace/src
```

Expected:

- models.dev fetching and provider mapping exist only in `cube-agent`;
- `cube-cli` coordinates contracts but contains no provider-option mapping;
- `cube-tui` contains no provider or Mastra logic;
- `cube-workspace` contains only schema/file ownership.

- [ ] **Step 7: Report verification and explicitly skip live inference**

Record command results, test counts, and any warnings. State that no live OpenAI, Google, OpenRouter, or Ollama inference request was made. Do not claim live-provider compatibility beyond type/unit/integration evidence unless the user separately authorizes a quota-consuming smoke test.

---

## Execution Notes

- Task boundaries are sequential because Workspace types feed Agent contracts, Agent contracts feed TUI/CLI boundaries, and CLI transaction tests depend on all earlier interfaces.
- A reviewer can reject any task independently without requiring unrelated package refactoring.
- If models.dev changes an unconsumed field, passthrough schemas preserve compatibility. If it changes the consumed `env`, `models`, or `reasoning_options` shapes, Cube returns a catalog warning instead of crashing.
- This plan deliberately leaves budget-token controls, Ollama reasoning controls, and arbitrary model settings for later specs.
