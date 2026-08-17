import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelCatalogEntry,
  ModelSelection,
  SelectionValidationResult,
} from "@cube/agent";
import type { TuiModelSelection } from "@cube/tui";
import {
  createModelCommandHandler,
  type ModelCommandDependencies,
} from "../src/slash-commands/model.slash-command.js";

const currentSelection: ModelSelection = {
  modelId: "ollama/qwen2.5:7b",
  config: {},
};
const openAiEntry: ModelCatalogEntry = {
  id: "openai/gpt-5.1",
  provider: "openai",
  config: {
    reasoningEffort: { values: ["none", "low", "medium", "high"] },
  },
};
const catalog = {
  models: [
    {
      id: "ollama/qwen2.5:7b",
      provider: "ollama",
      config: {},
    },
    openAiEntry,
  ],
  warnings: ["Ollama: connection refused"],
};

const prepare = (
  selection: ModelSelection,
): SelectionValidationResult => ({
  prepared: {
    selection,
    ...(selection.config.reasoning_effort
      ? {
          providerOptions: {
            openai: { reasoningEffort: selection.config.reasoning_effort },
          },
        }
      : {}),
  },
  warnings: [],
});

const createDependencies = (
  overrides: Partial<ModelCommandDependencies> = {},
): ModelCommandDependencies => ({
  getCurrentSelection: () => currentSelection,
  getPersistedSelection: () => currentSelection,
  loadCatalog: async () => catalog,
  openModelPicker: async (options) => {
    await options.loadModels(new AbortController().signal);
    return null;
  },
  prepareSelection: (selection) => prepare(selection),
  applySelection: async () => undefined,
  persistSelection: () => undefined,
  showMessage: () => undefined,
  ...overrides,
});

test("empty argument opens the model list", async () => {
  let requestedModelId: string | undefined = "not-called";
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      requestedModelId = options.requestedModelId;
      await options.loadModels(new AbortController().signal);
      return null;
    },
  }));

  await handler("");

  assert.equal(requestedModelId, undefined);
});

test("explicit model ID still opens the picker for config selection", async () => {
  let requestedModelId: string | undefined;
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      requestedModelId = options.requestedModelId;
      await options.loadModels(new AbortController().signal);
      return null;
    },
  }));

  await handler("  openai/gpt-5.1  ");

  assert.equal(requestedModelId, "openai/gpt-5.1");
});

test("picker cancellation performs no prepare, persist, or apply", async () => {
  const calls: string[] = [];
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return null;
    },
    prepareSelection: () => {
      calls.push("prepare");
      return prepare(currentSelection);
    },
    persistSelection: () => { calls.push("persist"); },
    applySelection: async () => { calls.push("apply"); },
  }));

  await handler("");

  assert.deepEqual(calls, []);
});

test("successful selection prepares, persists, and applies in order", async () => {
  const calls: string[] = [];
  const candidate: TuiModelSelection = {
    modelId: openAiEntry.id,
    config: { reasoning_effort: "high" },
  };
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return candidate;
    },
    prepareSelection: (selection, entry) => {
      calls.push(`prepare:${entry?.id}:${selection.config.reasoning_effort}`);
      return prepare(selection);
    },
    persistSelection: (selection) => {
      calls.push(`persist:${selection.modelId}`);
    },
    applySelection: async (selection) => {
      calls.push(`apply:${selection.selection.modelId}`);
    },
    showMessage: (message) => { calls.push(`message:${message}`); },
  }));

  await handler("");

  assert.deepEqual(calls, [
    "prepare:openai/gpt-5.1:high",
    "persist:openai/gpt-5.1",
    "apply:openai/gpt-5.1",
    "message:Model changed to openai/gpt-5.1 (reasoning: high).",
  ]);
});

test("success message omits reasoning when the model has no config", async () => {
  const messages: string[] = [];
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return { modelId: currentSelection.modelId, config: {} };
    },
    showMessage: (message) => { messages.push(message); },
  }));

  await handler("");

  assert.deepEqual(messages, ["Model changed to ollama/qwen2.5:7b."]);
});

test("persistence failure prevents runtime apply", async () => {
  let applied = false;
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return { modelId: currentSelection.modelId, config: {} };
    },
    persistSelection: () => { throw new Error("disk full"); },
    applySelection: async () => { applied = true; },
  }));

  await assert.rejects(handler(""), /disk full/);
  assert.equal(applied, false);
});

test("apply failure restores the previous persisted selection", async () => {
  const persisted: ModelSelection[] = [];
  const previousPersisted: ModelSelection = {
    modelId: "google/gemini-3.6-flash",
    config: { reasoning_effort: "low" },
  };
  const handler = createModelCommandHandler(createDependencies({
    getPersistedSelection: () => previousPersisted,
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return {
        modelId: openAiEntry.id,
        config: { reasoning_effort: "high" },
      };
    },
    persistSelection: (selection) => { persisted.push(structuredClone(selection)); },
    applySelection: async () => { throw new Error("session switch failed"); },
  }));

  await assert.rejects(handler(""), /session switch failed/);

  assert.deepEqual(persisted, [
    {
      modelId: "openai/gpt-5.1",
      config: { reasoning_effort: "high" },
    },
    previousPersisted,
  ]);
});

test("rollback uses persisted YAML even when runtime normalized its config", async () => {
  const restored: ModelSelection[] = [];
  const persistedBeforeStartup: ModelSelection = {
    modelId: "openai/gpt-5.1",
    config: { reasoning_effort: "xhigh" },
  };
  const handler = createModelCommandHandler(createDependencies({
    getCurrentSelection: () => ({ modelId: "openai/gpt-5.1", config: {} }),
    getPersistedSelection: () => persistedBeforeStartup,
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return { modelId: openAiEntry.id, config: { reasoning_effort: "high" } };
    },
    persistSelection: (selection) => { restored.push(structuredClone(selection)); },
    applySelection: async () => { throw new Error("apply rejected"); },
  }));

  await assert.rejects(handler(""), /apply rejected/);
  assert.deepEqual(restored.at(-1), persistedBeforeStartup);
});

test("rollback persistence failure reports both errors without success", async () => {
  let writes = 0;
  const messages: string[] = [];
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      return { modelId: openAiEntry.id, config: { reasoning_effort: "high" } };
    },
    persistSelection: () => {
      writes += 1;
      if (writes === 2) throw new Error("rollback disk failure");
    },
    applySelection: async () => { throw new Error("apply failure"); },
    showMessage: (message) => { messages.push(message); },
  }));

  await assert.rejects(
    handler(""),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((item) => String(item).includes("apply failure"))
      && error.errors.some((item) => String(item).includes("rollback disk failure")),
  );
  assert.deepEqual(messages, []);
});

test("partial catalog warnings remain picker view data", async () => {
  let pickerWarnings: string[] = [];
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      const view = await options.loadModels(new AbortController().signal);
      pickerWarnings = view.warnings;
      return null;
    },
  }));

  await handler("");

  assert.deepEqual(pickerWarnings, ["Ollama: connection refused"]);
});

test("unknown explicit ID rejected by the picker does not mutate state", async () => {
  const calls: string[] = [];
  const handler = createModelCommandHandler(createDependencies({
    openModelPicker: async (options) => {
      await options.loadModels(new AbortController().signal);
      throw new Error("Model is unavailable; check provider authentication.");
    },
    persistSelection: () => { calls.push("persist"); },
    applySelection: async () => { calls.push("apply"); },
  }));

  await assert.rejects(
    handler("openai/not-authenticated"),
    /provider authentication/i,
  );
  assert.deepEqual(calls, []);
});
