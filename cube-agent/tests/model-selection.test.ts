import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogEntry } from "../src/model-catalog.js";
import {
  createActiveModelSelection,
  createSessionModelSelection,
  prepareModelSelection,
  resolveInitialModelSelection,
  type PreparedModelSelection,
} from "../src/model-selection.js";

const effortEntry = (
  id: string,
  values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh">,
): ModelCatalogEntry => ({
  id,
  provider: id.split("/", 1)[0] ?? "",
  config: { reasoningEffort: { values } },
});

test("maps OpenAI reasoning effort to provider options", () => {
  const result = prepareModelSelection(
    { modelId: "openai/gpt-5.1", config: { reasoning_effort: "high" } },
    effortEntry("openai/gpt-5.1", ["none", "low", "medium", "high"]),
  );

  assert.deepEqual(result, {
    prepared: {
      selection: {
        modelId: "openai/gpt-5.1",
        config: { reasoning_effort: "high" },
      },
      providerOptions: { openai: { reasoningEffort: "high" } },
    },
    warnings: [],
  });
});

test("maps Google reasoning effort to thinking level", () => {
  const result = prepareModelSelection(
    {
      modelId: "google/gemini-3.6-flash",
      config: { reasoning_effort: "medium" },
    },
    effortEntry("google/gemini-3.6-flash", ["minimal", "low", "medium", "high"]),
  );

  assert.deepEqual(result.prepared.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "medium" } },
  });
});

test("maps OpenRouter reasoning effort without collapsing the nested model ID", () => {
  const result = prepareModelSelection(
    {
      modelId: "openrouter/openai/gpt-5.1",
      config: { reasoning_effort: "low" },
    },
    effortEntry("openrouter/openai/gpt-5.1", ["none", "low", "medium", "high"]),
  );

  assert.equal(result.prepared.selection.modelId, "openrouter/openai/gpt-5.1");
  assert.deepEqual(result.prepared.providerOptions, {
    openrouter: { reasoning: { effort: "low" } },
  });
});

test("accepts an empty config without a catalog entry", () => {
  const result = prepareModelSelection(
    { modelId: "ollama/qwen2.5:7b", config: {} },
    null,
  );

  assert.deepEqual(result, {
    prepared: {
      selection: { modelId: "ollama/qwen2.5:7b", config: {} },
    },
    warnings: [],
  });
});

test("ignores unsupported effort with one actionable warning", () => {
  const result = prepareModelSelection(
    { modelId: "openai/gpt-5.1", config: { reasoning_effort: "xhigh" } },
    effortEntry("openai/gpt-5.1", ["none", "low", "medium", "high"]),
  );

  assert.deepEqual(result.prepared, {
    selection: { modelId: "openai/gpt-5.1", config: {} },
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /openai\/gpt-5\.1.*xhigh.*ignored/i);
});

test("ignores nonempty config when the model is unavailable", () => {
  const result = prepareModelSelection(
    { modelId: "google/gemini-3.6-flash", config: { reasoning_effort: "high" } },
    null,
  );

  assert.deepEqual(result.prepared.selection.config, {});
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /google\/gemini-3\.6-flash.*high.*ignored/i);
});

test("rejects a mismatched catalog entry as an internal contract error", () => {
  assert.throws(
    () => prepareModelSelection(
      { modelId: "openai/gpt-5.1", config: { reasoning_effort: "high" } },
      effortEntry("openai/gpt-5.2", ["high"]),
    ),
    /does not match selection/i,
  );
});

test("budget-only entries do not accept reasoning effort", () => {
  const entry: ModelCatalogEntry = {
    id: "google/gemini-2.5-pro",
    provider: "google",
    config: {},
  };

  const result = prepareModelSelection(
    { modelId: entry.id, config: { reasoning_effort: "medium" } },
    entry,
  );

  assert.deepEqual(result.prepared.selection.config, {});
  assert.equal(result.prepared.providerOptions, undefined);
  assert.equal(result.warnings.length, 1);
});

test("active model state returns immutable snapshots and replaces config", () => {
  const initial: PreparedModelSelection = {
    selection: {
      modelId: "openai/gpt-5.1",
      config: { reasoning_effort: "high" },
    },
    providerOptions: { openai: { reasoningEffort: "high" } },
  };
  const active = createActiveModelSelection(initial);
  const snapshot = active.get();
  snapshot.selection.config.reasoning_effort = "low";
  snapshot.providerOptions!.openai!.reasoningEffort = "low";

  assert.deepEqual(active.get(), initial);

  active.set({
    selection: { modelId: "ollama/qwen2.5:7b", config: {} },
  });

  assert.deepEqual(active.get(), {
    selection: { modelId: "ollama/qwen2.5:7b", config: {} },
  });
});

test("initial selection resolves supported config through the catalog", async () => {
  const entry = effortEntry("google/gemini-3.6-flash", [
    "minimal",
    "low",
    "medium",
    "high",
  ]);

  const result = await resolveInitialModelSelection(
    {
      modelId: entry.id,
      config: { reasoning_effort: "high" },
    },
    async () => entry,
  );

  assert.deepEqual(result.prepared.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "high" } },
  });
  assert.deepEqual(result.warnings, []);
});

test("initial catalog failure keeps the model and ignores config with a warning", async () => {
  const result = await resolveInitialModelSelection(
    {
      modelId: "openai/gpt-5.1",
      config: { reasoning_effort: "high" },
    },
    async () => {
      throw new Error("catalog offline");
    },
  );

  assert.deepEqual(result.prepared, {
    selection: { modelId: "openai/gpt-5.1", config: {} },
  });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /catalog offline.*high.*ignored/i);
});

test("successful session apply commits the model and config together", async () => {
  let sessionModelId = "ollama/qwen2.5:7b";
  const switches: string[] = [];
  const active = createActiveModelSelection({
    selection: { modelId: sessionModelId, config: {} },
  });
  const runtime = createSessionModelSelection({
    active,
    sessionModel: {
      get: () => sessionModelId,
      switch: async ({ modelId }) => {
        switches.push(modelId);
        sessionModelId = modelId;
      },
    },
  });
  const prepared = prepareModelSelection(
    { modelId: "openai/gpt-5.1", config: { reasoning_effort: "high" } },
    effortEntry("openai/gpt-5.1", ["high"]),
  ).prepared;

  await runtime.applyModelSelection(prepared);

  assert.deepEqual(switches, ["openai/gpt-5.1"]);
  assert.equal(sessionModelId, "openai/gpt-5.1");
  assert.deepEqual(runtime.getModelSelection(), prepared.selection);
});

test("failed session apply retains active selection and restores a partial switch", async () => {
  let sessionModelId = "ollama/qwen2.5:7b";
  const switches: string[] = [];
  const active = createActiveModelSelection({
    selection: { modelId: sessionModelId, config: {} },
  });
  const runtime = createSessionModelSelection({
    active,
    sessionModel: {
      get: () => sessionModelId,
      switch: async ({ modelId }) => {
        switches.push(modelId);
        sessionModelId = modelId;
        if (modelId === "openai/gpt-5.1") throw new Error("switch failed late");
      },
    },
  });

  await assert.rejects(
    runtime.applyModelSelection({
      selection: {
        modelId: "openai/gpt-5.1",
        config: { reasoning_effort: "high" },
      },
      providerOptions: { openai: { reasoningEffort: "high" } },
    }),
    /switch failed late/,
  );

  assert.deepEqual(switches, ["openai/gpt-5.1", "ollama/qwen2.5:7b"]);
  assert.equal(sessionModelId, "ollama/qwen2.5:7b");
  assert.deepEqual(runtime.getModelSelection(), {
    modelId: "ollama/qwen2.5:7b",
    config: {},
  });
});

test("failed session restoration reports both failures", async () => {
  let sessionModelId = "ollama/qwen2.5:7b";
  const active = createActiveModelSelection({
    selection: { modelId: sessionModelId, config: {} },
  });
  const runtime = createSessionModelSelection({
    active,
    sessionModel: {
      get: () => sessionModelId,
      switch: async ({ modelId }) => {
        sessionModelId = modelId;
        throw new Error(modelId === "openai/gpt-5.1" ? "apply failed" : "restore failed");
      },
    },
  });

  await assert.rejects(
    runtime.applyModelSelection({
      selection: { modelId: "openai/gpt-5.1", config: {} },
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((item) => String(item).includes("apply failed"))
      && error.errors.some((item) => String(item).includes("restore failed")),
  );
  assert.deepEqual(runtime.getModelSelection(), {
    modelId: "ollama/qwen2.5:7b",
    config: {},
  });
});
