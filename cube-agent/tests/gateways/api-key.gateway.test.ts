import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { GatewayLanguageModel, ProviderConfig } from "@mastra/core/llm";
import { AuthStore, HomeManager } from "@cube/workspace";
import { CubeApiKeyGateway } from "../../src/gateways/api-key.gateway.js";

const cleanup = (tmp: string) =>
  rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const provider = (id: string): ProviderConfig => ({
  name: id,
  apiKeyEnvVar: `${id.toUpperCase()}_API_KEY`,
  gateway: "models.dev",
  url: `https://${id}.example.test/v1`,
  models: ["model-one"],
});

const createDelegate = () => {
  const calls: string[] = [];
  return {
    calls,
    fetchProviders: async () => ({
      google: provider("google"),
      openrouter: provider("openrouter"),
      openai: provider("openai"),
    }),
    buildUrl: (routerId: string) => {
      calls.push(`url:${routerId}`);
      return `https://resolved.example.test/${routerId}`;
    },
    resolveLanguageModel: (args: { modelId: string; providerId: string }) => {
      calls.push(`model:${args.providerId}/${args.modelId}`);
      return { specificationVersion: "v3" } as GatewayLanguageModel;
    },
  };
};

test("CubeApiKeyGateway resolves auth from auth.json with provider env variables absent", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-api-gateway-test-"));
  const home = new HomeManager({ cubeHome: tmp });
  const previousGoogle = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await home.ensure();
    await writeFile(
      home.getAuthPath(),
      JSON.stringify({ version: 1, api_keys: {}, subscriptions: {} }),
      "utf8",
    );
    const auth = new AuthStore(home);
    await auth.replaceApiKey("google", "stored-google-secret");
    await auth.replaceApiKey("openrouter", "stored-openrouter-secret");

    const google = new CubeApiKeyGateway("api_key/google", auth, createDelegate());
    const openrouter = new CubeApiKeyGateway(
      "api_key/openrouter",
      auth,
      createDelegate(),
    );

    assert.deepEqual(
      await google.resolveAuth({
        gatewayId: google.id,
        providerId: "google",
        modelId: "gemini-test",
        routerId: `${google.id}/google/gemini-test`,
      }),
      { apiKey: "stored-google-secret", source: "gateway" },
    );
    assert.equal(await openrouter.getApiKey("openrouter/vendor/model"), "stored-openrouter-secret");
  } finally {
    if (previousGoogle === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogle;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    await cleanup(tmp);
  }
});

test("CubeApiKeyGateway exposes and delegates only its configured provider", async () => {
  const delegate = createDelegate();
  const auth = { getApiKey: async () => "stored-key" };
  const gateway = new CubeApiKeyGateway("api_key/google", auth, delegate);

  const providers = await gateway.fetchProviders();
  assert.deepEqual(Object.keys(providers), ["google"]);
  assert.equal(providers.google?.gateway, gateway.id);
  assert.equal(
    await gateway.buildUrl(`${gateway.id}/google/gemini-test`, {}),
    "https://resolved.example.test/google/gemini-test",
  );
  await gateway.resolveLanguageModel({
    modelId: "gemini-test",
    providerId: "google",
    apiKey: "stored-key",
  });
  assert.deepEqual(delegate.calls, [
    "url:google/gemini-test",
    "model:google/gemini-test",
  ]);
});

test("CubeApiKeyGateway reports missing auth without consulting env fallback", async () => {
  const gateway = new CubeApiKeyGateway(
    "api_key/openai",
    { getApiKey: async () => undefined },
    createDelegate(),
  );

  assert.equal(
    await gateway.resolveAuth({
      gatewayId: gateway.id,
      providerId: "openai",
      modelId: "gpt-test",
      routerId: `${gateway.id}/openai/gpt-test`,
    }),
    undefined,
  );
  await assert.rejects(
    () => gateway.getApiKey("openai/gpt-test"),
    /Missing API key for api_key\/openai\. Run \/gateway to configure it\./,
  );
});
