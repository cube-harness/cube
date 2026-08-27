import assert from "node:assert/strict";
import test from "node:test";
import { buildModelConfig } from "../src/agents/main.agent.js";

test("maps OpenRouter reasoning effort into the provider request", () => {
  const config = buildModelConfig(
    "openrouter/poolside/laguna-xs-2.1:free",
    "high",
  );

  assert.deepEqual(config.providerOptions, {
    openrouter: { reasoning: { effort: "high" } },
  });
});

test("maps Gemini 3 reasoning effort to thinkingLevel", () => {
  const config = buildModelConfig("google/gemini-3.7-flash", "high");

  assert.deepEqual(config.providerOptions, {
    google: { thinkingConfig: { thinkingLevel: "high" } },
  });
});

test("keeps Gemini 2.5 reasoning effort on numeric thinkingBudget", () => {
  const config = buildModelConfig("google/gemini-2.5-flash", "medium");

  assert.deepEqual(config.providerOptions, {
    google: { thinkingConfig: { thinkingBudget: 8192 } },
  });
});
