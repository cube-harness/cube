import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayLanguageModel } from "@mastra/core/llm";
import { OpenAISubscriptionGateway } from "../../src/gateways/openai-subscription.gateway.js";

const credential = {
  access_token: "subscription-token",
  refresh_token: "refresh-token",
  expires_at: Date.now() + 60_000,
  account_id: "account-1",
};

test("uses an isolated internal route and subscription auth headers", async () => {
  const gateway = new OpenAISubscriptionGateway(
    { getValidCredential: async () => credential },
    ["openai/gpt-5.5", "openai/gpt-5.4"],
    {
      resolveLanguageModel: (args) => ({
        specificationVersion: "v3",
        modelId: `${args.providerId}/${args.modelId}`,
      } as GatewayLanguageModel),
    },
  );

  assert.equal(gateway.id, "cube-subscription-openai");
  assert.equal(
    gateway.buildUrl(`${gateway.id}/openai/gpt-5.5`, {}),
    "https://chatgpt.com/backend-api/codex/responses",
  );
  assert.deepEqual(await gateway.resolveAuth({
    gatewayId: gateway.id,
    providerId: "openai",
    modelId: "gpt-5.5",
    routerId: `${gateway.id}/openai/gpt-5.5`,
  }), {
    bearerToken: "subscription-token",
    apiKey: "subscription-token",
    headers: { "ChatGPT-Account-Id": "account-1" },
    source: "gateway",
  });
});

test("exposes only the explicitly supported subscription models", async () => {
  const gateway = new OpenAISubscriptionGateway(
    { getValidCredential: async () => credential },
    ["openai/gpt-5.5", "google/gemini-test", "openai/"],
    { resolveLanguageModel: () => ({ specificationVersion: "v3" } as GatewayLanguageModel) },
  );

  const providers = await gateway.fetchProviders();
  assert.deepEqual(providers.openai?.models, ["gpt-5.5"]);
  assert.equal(providers.openai?.gateway, "cube-subscription-openai");
  assert.equal(providers.openai?.url, "https://chatgpt.com/backend-api/codex");
});
