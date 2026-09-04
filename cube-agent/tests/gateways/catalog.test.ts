import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalog } from "@cube/workspace";
import { buildGatewayCatalog } from "../../src/gateways/catalog.js";

const canonical: ModelCatalog = {
  version: 2,
  updatedAt: "2026-09-04T00:00:00.000Z",
  providers: {
    openai: {
      name: "OpenAI",
      models: [{
        modelId: "openai/gpt-test",
        name: "GPT Test",
        family: "gpt",
        reasoning: true,
        reasoning_efforts: ["none", "high"],
        tool_call: true,
        structured_output: true,
        attachment: true,
        open_weights: false,
        limit: { context: 128_000, output: 16_384 },
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 1, output: 2 },
      }],
    },
    google: {
      name: "Google",
      models: [{
        modelId: "google/gemini-test",
        name: "Gemini Test",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 1_000_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
  },
};

test("API-key and subscription OpenAI routes reuse one canonical capability record", () => {
  const api = buildGatewayCatalog(canonical, {
    gatewayId: "api_key/openai",
    canonicalModelIds: ["openai/gpt-test"],
  });
  const subscription = buildGatewayCatalog(canonical, {
    gatewayId: "subscription/openai",
    canonicalModelIds: ["openai/gpt-test"],
  });

  assert.deepEqual(api.providers.openai, canonical.providers.openai);
  assert.deepEqual(subscription.providers.openai, canonical.providers.openai);
});

test("gateway catalog contains only models available through that gateway", () => {
  const catalog = buildGatewayCatalog(canonical, {
    gatewayId: "api_key/google",
    canonicalModelIds: ["google/gemini-test"],
  });

  assert.deepEqual(Object.keys(catalog.providers), ["google"]);
  assert.deepEqual(
    catalog.providers.google?.models.map(({ modelId }) => modelId),
    ["google/gemini-test"],
  );
});

test("unknown local models receive conservative capability metadata", () => {
  const catalog = buildGatewayCatalog(canonical, {
    gatewayId: "local/ollama",
    canonicalModelIds: ["ollama/private-model:latest"],
  });
  const model = catalog.providers.ollama?.models[0];

  assert.deepEqual(model, {
    modelId: "ollama/private-model:latest",
    name: "private-model:latest",
    family: "ollama",
    reasoning: false,
    tool_call: false,
    structured_output: false,
    attachment: false,
    open_weights: true,
    limit: { context: 128_000, output: 8_192 },
    modalities: { input: ["text"], output: ["text"] },
  });
  assert.equal("cost" in (model ?? {}), false);
});
