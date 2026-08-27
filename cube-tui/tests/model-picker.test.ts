import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelPickerComponent,
  type ProviderGroup,
  type ModelSelectionResult,
} from "../src/components/model-picker.js";

const sampleProviders: ProviderGroup[] = [
  {
    id: "google",
    name: "Google",
    models: [
      {
        modelId: "google/gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        reasoning: true,
        reasoning_efforts: ["none", "low", "medium", "high"],
        tool_call: true,
        attachment: true,
        limit: { context: 1048576, output: 8192 },
      },
      {
        modelId: "google/gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        reasoning_efforts: ["none", "low", "medium", "high"],
        tool_call: true,
        attachment: true,
        limit: { context: 2097152, output: 8192 },
      },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: [
      {
        modelId: "anthropic/claude-3-5-sonnet-latest",
        name: "Claude 3.5 Sonnet",
        reasoning: false,
        tool_call: true,
        attachment: true,
        limit: { context: 200000, output: 8192 },
      },
    ],
  },
];

test("ModelPickerComponent renders within width limit", () => {
  const picker = new ModelPickerComponent({
    providers: sampleProviders,
    currentModelId: "google/gemini-2.5-flash",
    onSelect: () => {},
    onCancel: () => {},
  });

  const lines = picker.render(80);
  assert.equal(lines.length > 0, true);
  for (const line of lines) {
    assert.equal(line.length <= 150, true);
  }
});

test("ModelPickerComponent supports 3-step navigation for models with reasoning", () => {
  let result: ModelSelectionResult | undefined;
  const picker = new ModelPickerComponent({
    providers: sampleProviders,
    currentModelId: "google/gemini-2.5-flash",
    onSelect: (r) => {
      result = r;
    },
    onCancel: () => {},
  });

  // Step 1: Press Enter on Google
  picker.handleInput("\r");

  // Step 2: Press Enter on Gemini 2.5 Flash (has reasoning: true) -> goes to step 3
  picker.handleInput("\r");

  // Step 3: Press Enter on reasoning effort (e.g. none / low / medium / high)
  picker.handleInput("\r");

  assert.ok(result);
  assert.equal(result.modelId, "google/gemini-2.5-flash");
  assert.ok(result.reasoningEffort);
});

test("ModelPickerComponent directly selects models without reasoning", () => {
  let result: ModelSelectionResult | undefined;
  const picker = new ModelPickerComponent({
    providers: sampleProviders,
    onSelect: (r) => {
      result = r;
    },
    onCancel: () => {},
  });

  // Step 1: Type 'anthropic' to search
  picker.handleInput("a");
  picker.handleInput("n");
  picker.handleInput("t");
  picker.handleInput("\r");

  // Step 2: Select Claude 3.5 Sonnet (reasoning: false) -> selected directly!
  picker.handleInput("\r");

  assert.ok(result);
  assert.equal(result.modelId, "anthropic/claude-3-5-sonnet-latest");
});

test("ModelPickerComponent supports Esc to go back and clear search", () => {
  let cancelled = false;
  const picker = new ModelPickerComponent({
    providers: sampleProviders,
    currentModelId: "google/gemini-2.5-flash",
    onSelect: () => {},
    onCancel: () => {
      cancelled = true;
    },
  });

  // Type search in Step 1
  picker.handleInput("g");
  picker.handleInput("o");

  // Esc clears search query first
  picker.handleInput("\x1b");
  assert.equal(cancelled, false);

  // Esc now cancels
  picker.handleInput("\x1b");
  assert.equal(cancelled, true);
});

test("ModelPickerComponent renders custom reasoning_efforts for models supporting xhigh and max", () => {
  let result: ModelSelectionResult | undefined;
  const customProviders: ProviderGroup[] = [
    {
      id: "openrouter",
      name: "OpenRouter",
      models: [
        {
          modelId: "openrouter/custom-reasoner",
          name: "Custom Reasoner",
          reasoning: true,
          reasoning_efforts: ["none", "low", "high", "xhigh", "max"],
          limit: { context: 128000, output: 8192 },
        },
      ],
    },
  ];

  const picker = new ModelPickerComponent({
    providers: customProviders,
    onSelect: (r) => {
      result = r;
    },
    onCancel: () => {},
  });

  // Step 1: Open OpenRouter
  picker.handleInput("\r");
  // Step 2: Open Custom Reasoner
  picker.handleInput("\r");

  // Step 3: Render reasoning step
  const lines = picker.render(80);
  const text = lines.join("\n");
  assert.match(text, /xhigh/);
  assert.match(text, /max/);

  // Navigate down to 'max' and select
  picker.handleInput("\x1b[B"); // low
  picker.handleInput("\x1b[B"); // high
  picker.handleInput("\x1b[B"); // xhigh
  picker.handleInput("\x1b[B"); // max
  picker.handleInput("\r");

  assert.ok(result);
  assert.equal(result.modelId, "openrouter/custom-reasoner");
  assert.equal(result.reasoningEffort, "max");
});
