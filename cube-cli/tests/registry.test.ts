import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@cube/agent";
import type { OpenModelPickerOptions } from "@cube/tui";
import { createSlashCommandRegistry } from "../src/slash-commands/registry.js";

const createInput = (calls: string[]) => ({
  model: {
    getCurrentSelection: (): ModelSelection => ({
      modelId: "ollama/qwen2.5:7b",
      config: {},
    }),
    getPersistedSelection: (): ModelSelection => ({
      modelId: "ollama/qwen2.5:7b",
      config: {},
    }),
    loadCatalog: async () => ({
      models: [{
        id: "google/gemini-3-flash",
        provider: "google",
        config: {},
      }],
      warnings: [],
    }),
    openModelPicker: async (options: OpenModelPickerOptions) => {
      await options.loadModels(new AbortController().signal);
      return { modelId: "google/gemini-3-flash", config: {} };
    },
    prepareSelection: (selection: ModelSelection) => {
      calls.push(`prepare:${selection.modelId}`);
      return { prepared: { selection }, warnings: [] };
    },
    applySelection: async (selection: { selection: ModelSelection }) => {
      calls.push(`apply:${selection.selection.modelId}`);
    },
    persistSelection: (selection: ModelSelection) => {
      calls.push(`persist:${selection.modelId}`);
    },
    showMessage: (message: string) => { calls.push(message); },
  },
  exit: {
    shutdown: async () => { calls.push("exit"); },
  },
  compact: {
    getThreadId: () => null,
    isTurnActive: () => false,
    finalizeMemory: async () => ({ status: "no-op" as const }),
    showMessage: (message: string) => { calls.push(message); },
  },
  showMessage: (message: string) => { calls.push(message); },
});

test("executes registered commands and projects autocomplete suggestions", async () => {
  const calls: string[] = [];
  const registry = createSlashCommandRegistry(createInput(calls));

  await registry.execute("/model", "google/gemini-3-flash");
  assert.deepEqual(calls, [
    "prepare:google/gemini-3-flash",
    "persist:google/gemini-3-flash",
    "apply:google/gemini-3-flash",
    "Model changed to google/gemini-3-flash.",
  ]);
  assert.deepEqual(registry.suggestions.map(({ name }) => name), [
    "/compact",
    "/exit",
    "/model",
  ]);
});

test("reports an unregistered command", async () => {
  const calls: string[] = [];
  const registry = createSlashCommandRegistry(createInput(calls));
  await registry.execute("/missing", "");
  assert.deepEqual(calls, ["Unknown command: /missing"]);
});
