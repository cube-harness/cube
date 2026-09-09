import assert from "node:assert/strict";
import test from "node:test";
import {
  gatewayDescriptors,
  toCanonicalModelId,
  toMastraRouterId,
} from "../../src/gateways/types.js";

test("persisted providers share exactly three strategy prefixes", () => {
  const internalIds = Object.values(gatewayDescriptors).map(({ internalId }) => internalId);
  assert.deepEqual([...new Set(internalIds)], ["cube-api", "cube-oauth", "cube-local"]);
  assert.equal(internalIds.every((id) => !id.includes("/")), true);
});

test("routing preserves canonical model IDs while separating credential routes", () => {
  const canonical = "openai/gpt-test";
  const apiRoute = toMastraRouterId("api_key/openai", canonical);
  const oauthRoute = toMastraRouterId("oauth/openai", canonical);

  assert.equal(apiRoute, "cube-api/openai/gpt-test");
  assert.equal(oauthRoute, "cube-oauth/openai/gpt-test");
  assert.notEqual(apiRoute, oauthRoute);
  assert.equal(toCanonicalModelId("api_key/openai", apiRoute), canonical);
  assert.equal(toCanonicalModelId("oauth/openai", oauthRoute), canonical);
});

test("routing rejects canonical models owned by a different provider", () => {
  assert.throws(
    () => toMastraRouterId("api_key/google", "openai/gpt-test"),
    /does not belong to gateway api_key\/google/,
  );
  assert.throws(
    () => toCanonicalModelId("api_key/google", "cube-api/openrouter/vendor/model"),
    /does not belong to gateway/,
  );
});
