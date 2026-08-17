import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { createApp, type ModelCatalogView } from "../src/index.js";

class TestTerminal implements Terminal {
  readonly columns = 100;
  readonly rows = 40;
  readonly kittyProtocolActive = false;

  start(): void {}
  stop(): void {}
  drainInput = async (): Promise<void> => undefined;
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const createTestApp = () => createApp({
  onAction: () => undefined,
  slashCommands: [],
  basePath: process.cwd(),
  terminal: new TestTerminal(),
});

const flushAsyncWork = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const catalog = (models: ModelCatalogView["models"]): ModelCatalogView => ({
  models,
  warnings: ["Ollama: connection refused"],
});

test("a model without configurable effort resolves a complete selection", async () => {
  const app = createTestApp();
  const selectionPromise = app.openModelPicker({
    currentSelection: { modelId: "ollama/qwen2.5:7b", config: {} },
    loadModels: async () => catalog([{ id: "ollama/qwen2.5:7b" }]),
  });
  await flushAsyncWork();

  app.modelPicker?.handleInput("\r");

  assert.deepEqual(await selectionPromise, {
    modelId: "ollama/qwen2.5:7b",
    config: {},
  });
});

test("an effort-capable model opens the second inline picker", async () => {
  const app = createTestApp();
  const selectionPromise = app.openModelPicker({
    currentSelection: { modelId: "ollama/qwen2.5:7b", config: {} },
    loadModels: async () => catalog([
      { id: "google/gemini-3.6-flash", reasoningEfforts: ["low", "high"] },
    ]),
  });
  await flushAsyncWork();

  app.modelPicker?.handleInput("\r");
  assert.equal(app.modelPicker, undefined);
  assert.notEqual(app.modelConfigPicker, undefined);
  app.modelConfigPicker?.handleInput("\x1b[B");
  app.modelConfigPicker?.handleInput("\r");

  assert.deepEqual(await selectionPromise, {
    modelId: "google/gemini-3.6-flash",
    config: { reasoning_effort: "high" },
  });
});

test("config Escape restores the same filtered model picker", async () => {
  const app = createTestApp();
  const selectionPromise = app.openModelPicker({
    currentSelection: { modelId: "ollama/qwen2.5:7b", config: {} },
    loadModels: async () => catalog([
      { id: "ollama/qwen2.5:7b" },
      { id: "google/gemini-3.6-flash", reasoningEfforts: ["low", "high"] },
    ]),
  });
  await flushAsyncWork();

  const originalPicker = app.modelPicker;
  for (const character of "google") originalPicker?.handleInput(character);
  originalPicker?.handleInput("\r");
  app.modelConfigPicker?.handleInput("\x1b");

  assert.equal(app.modelPicker, originalPicker);
  assert.equal(app.modelPicker?.getSelectedModel(), "google/gemini-3.6-flash");
  app.modelPicker?.handleInput("\x1b");
  assert.equal(await selectionPromise, null);
});

test("explicit model ID skips the list but still requires effort confirmation", async () => {
  const app = createTestApp();
  const selectionPromise = app.openModelPicker({
    currentSelection: {
      modelId: "google/gemini-3.6-flash",
      config: { reasoning_effort: "high" },
    },
    requestedModelId: "google/gemini-3.6-flash",
    loadModels: async () => catalog([
      { id: "google/gemini-3.6-flash", reasoningEfforts: ["low", "high"] },
    ]),
  });
  await flushAsyncWork();

  assert.equal(app.modelPicker, undefined);
  assert.notEqual(app.modelConfigPicker, undefined);
  app.modelConfigPicker?.handleInput("\x1b");

  assert.equal(await selectionPromise, null);
});

test("explicit unknown model fails without opening a picker", async () => {
  const app = createTestApp();
  const selectionPromise = app.openModelPicker({
    currentSelection: { modelId: "ollama/qwen2.5:7b", config: {} },
    requestedModelId: "openai/not-authenticated",
    loadModels: async () => catalog([{ id: "ollama/qwen2.5:7b" }]),
  });

  await assert.rejects(selectionPromise, /unavailable.*authentication/i);
  assert.equal(app.modelPicker, undefined);
  assert.equal(app.modelConfigPicker, undefined);
});
