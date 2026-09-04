import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayDescriptors,
  toCanonicalModelId,
  toMastraRouterId,
} from "../../src/gateways/types.js";

test("every persisted gateway maps to a unique internal Mastra prefix", () => {
  const internalIds = Object.values(gatewayDescriptors).map(({ internalId }) => internalId);
  assert.equal(new Set(internalIds).size, internalIds.length);
  assert.equal(internalIds.every((id) => !id.includes("/")), true);
});

test("routing preserves canonical model IDs while separating credential routes", () => {
  const canonical = "openai/gpt-test";
  const apiRoute = toMastraRouterId("api_key/openai", canonical);
  const subscriptionRoute = toMastraRouterId("subscription/openai", canonical);

  assert.equal(apiRoute, "cube-api-openai/openai/gpt-test");
  assert.equal(subscriptionRoute, "cube-subscription-openai/openai/gpt-test");
  assert.notEqual(apiRoute, subscriptionRoute);
  assert.equal(toCanonicalModelId("api_key/openai", apiRoute), canonical);
  assert.equal(toCanonicalModelId("subscription/openai", subscriptionRoute), canonical);
});

test("routing rejects canonical models owned by a different provider", () => {
  assert.throws(
    () => toMastraRouterId("api_key/google", "openai/gpt-test"),
    /does not belong to gateway api_key\/google/,
  );
});
