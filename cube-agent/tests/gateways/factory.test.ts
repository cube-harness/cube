import assert from "node:assert/strict";
import test from "node:test";
import { GATEWAY_IDS } from "@cube/workspace";
import { createCubeGateways } from "../../src/gateways/factory.js";
import { gatewayDescriptors, toMastraRouterId } from "../../src/gateways/types.js";

test("createCubeGateways registers three shared strategy instances for Mastra and controller", async () => {
  const gateways = createCubeGateways({
    auth: { getApiKey: async (provider) => `stored-${provider}` },
    oauth: { openai: {
      getValidCredential: async () => ({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 60_000,
        account_id: "account",
      }),
    },
      xai: { getValidCredential: async () => ({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 60000 }) },
      anthropic: { getValidCredential: async () => ({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 60000 }) },
      google: { getValidCredential: async () => ({ access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 60000, project_id: "project" }) },
    },
  });

  assert.deepEqual([...gateways.byGatewayId.keys()], GATEWAY_IDS);
  assert.equal(gateways.ordered.length, 3);
  assert.deepEqual(Object.values(gateways.record), gateways.ordered);
  for (const adapter of gateways.ordered) {
    assert.equal(gateways.record[adapter.id], adapter);
  }
  assert.equal(gateways.byGatewayId.get("api_key/google"), gateways.byGatewayId.get("api_key/openrouter"));
  assert.equal(gateways.byGatewayId.get("api_key/google"), gateways.byGatewayId.get("api_key/openai"));
  assert.equal(gateways.byGatewayId.get("local/ollama"), gateways.byGatewayId.get("local/lmstudio"));
  assert.notEqual(gateways.byGatewayId.get("api_key/openai"), gateways.byGatewayId.get("oauth/openai"));
  assert.equal(gateways.byGatewayId.get("oauth/anthropic"), gateways.byGatewayId.get("oauth/openai"));
  const local = gateways.byGatewayId.get("local/ollama")!;
  const ollamaUrl = local.getBaseUrl!("local/ollama");
  local.setBaseUrl!("http://localhost:4321", "local/lmstudio");
  assert.equal(local.getBaseUrl!("local/lmstudio"), "http://localhost:4321/v1");
  assert.equal(local.getBaseUrl!("local/ollama"), ollamaUrl);
  for (const gatewayId of GATEWAY_IDS) {
    const provider = gatewayDescriptors[gatewayId].providerId;
    const route = toMastraRouterId(gatewayId, `${provider}/vendor/model`);
    const strategyId = route.split("/")[0]!;
    const strategy = gateways.record[strategyId]!;
    assert.equal(strategy, gateways.byGatewayId.get(gatewayId));
    const auth = await strategy.resolveAuth!({
      gatewayId: strategyId,
      providerId: provider,
      modelId: "vendor/model",
      routerId: route,
    });
    assert.ok(auth);
    assert.equal(auth.apiKey, gatewayId.startsWith("api_key/")
      ? `stored-${provider}` : gatewayId.startsWith("local/") ? "cube-local" : "access");
  }
});
