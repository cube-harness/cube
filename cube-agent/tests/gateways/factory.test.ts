import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_IDS } from "@cube/workspace";
import { createCubeGateways } from "../../src/gateways/factory.js";

test("createCubeGateways returns the same six adapter instances for Mastra and controller", () => {
  const gateways = createCubeGateways({
    auth: { getApiKey: async () => undefined },
    openAISubscription: {
      getValidCredential: async () => ({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
        account_id: "account",
      }),
    },
    openAISubscriptionModelIds: ["openai/gpt-test"],
  });

  assert.deepEqual([...gateways.byGatewayId.keys()], GATEWAY_IDS);
  assert.equal(gateways.ordered.length, 6);
  assert.deepEqual(Object.values(gateways.record), gateways.ordered);
  for (const adapter of gateways.ordered) {
    assert.equal(gateways.record[adapter.id], adapter);
    assert.equal(gateways.byGatewayId.get(adapter.gatewayId), adapter);
  }
});
