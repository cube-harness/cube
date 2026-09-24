import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ModelCatalog } from "@cube/runtime";
import {
  ModelPickerComponent,
  type ModelSelectionResult,
} from "../src/components/model-picker.js";

const catalog: ModelCatalog = {
  updatedAt: "2026-09-05T00:00:00.000Z",
  providers: {
    google: {
      name: "Google",
      models: [{
        modelId: "google/gemini-test",
        name: "Gemini Test",
        reasoning: true,
        reasoning_efforts: ["none", "high"],
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
    openrouter: {
      name: "OpenRouter",
      models: [{
        modelId: "openrouter/other",
        name: "Other",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
  },
};

test("model picker shows only the candidate gateway and stays within width", () => {
  const picker = new ModelPickerComponent({
    gatewayId: "api_key/google",
    catalog,
    currentModelId: "google/gemini-test",
    onSelect: () => undefined,
    onCancel: () => undefined,
  });

  const lines = picker.render(40);
  assert.match(lines.join("\n"), /google\/gemini-test/);
  assert.doesNotMatch(lines.join("\n"), /openrouter\/other/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 40), true);
});

test("model picker selects model then reasoning effort without a provider step", () => {
  let result: ModelSelectionResult | undefined;
  const picker = new ModelPickerComponent({
    gatewayId: "api_key/google",
    catalog,
    currentModelId: "google/gemini-test",
    currentReasoningEffort: "high",
    onSelect: (value) => { result = value; },
    onCancel: () => undefined,
  });

  picker.handleInput("\r");
  assert.match(picker.render(80).join("\n"), /Select Reasoning Effort/);
  assert.match(picker.render(80).join("\n"), /Deep multi-step analysis/);
  picker.handleInput("\x1b[B");
  picker.handleInput("\r");

  assert.deepEqual(result, { modelId: "google/gemini-test", reasoningEffort: "high" });
});

test("OAuth reasoning uses provider descriptions in both picker entry paths without Cube fallbacks", () => {
  const oauthCatalog: ModelCatalog = { updatedAt: catalog.updatedAt, providers: {
    openai: { name: "OpenAI", models: [{ modelId: "openai/test", name: "Test",
      reasoning_efforts: ["high", "ultra", "low"],
      reasoning_effort_descriptions: { high: "Provider high description", ultra: "Provider ultra description" },
    }] },
  } };
  for (const initialStep of ["model", "reasoning"] as const) {
    let selected: ModelSelectionResult | undefined;
    const picker = new ModelPickerComponent({
      gatewayId: "oauth/openai", catalog: oauthCatalog, initialStep,
      currentModelId: "openai/test", currentReasoningEffort: "high",
      onSelect: result => { selected = result; }, onCancel: () => undefined,
    });
    if (initialStep === "model") picker.handleInput("\r");
    const rendered = picker.render(120).join("\n");
    assert.match(rendered, /Provider high description/);
    assert.match(rendered, /Provider ultra description/);
    assert.doesNotMatch(rendered, /Deep multi-step analysis|Light thinking pass|ultra level|low level/);
    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    assert.deepEqual(selected, { modelId: "openai/test", reasoningEffort: "ultra" });
  }
});

test("model picker Escape returns from reasoning then cancels", () => {
  let cancelled = false;
  const picker = new ModelPickerComponent({
    gatewayId: "api_key/google",
    catalog,
    onSelect: () => undefined,
    onCancel: () => { cancelled = true; },
  });

  picker.handleInput("\r");
  picker.handleInput("\x1b");
  assert.equal(cancelled, false);
  picker.handleInput("\x1b");
  assert.equal(cancelled, true);
});

test("model picker keeps the current candidate model selected by default", () => {
  let result: ModelSelectionResult | undefined;
  const currentSecond: ModelCatalog = {
    ...catalog,
    providers: {
      google: {
        ...catalog.providers.google!,
        models: [
          { ...catalog.providers.google!.models[0]!, modelId: "google/first", reasoning_efforts: undefined },
          { ...catalog.providers.google!.models[0]!, modelId: "google/current", reasoning_efforts: undefined },
        ],
      },
    },
  };
  const picker = new ModelPickerComponent({
    gatewayId: "api_key/google",
    catalog: currentSecond,
    currentModelId: "google/current",
    onSelect: (value) => { result = value; },
    onCancel: () => undefined,
  });

  picker.handleInput("\r");

  assert.deepEqual(result, { modelId: "google/current" });
});
