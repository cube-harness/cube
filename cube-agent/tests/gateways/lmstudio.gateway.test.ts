import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalGateway,
  normalizeLMStudioBaseUrl,
} from "../../src/gateways/local.gateway.js";

test("normalizeLMStudioBaseUrl defaults and normalizes the v1 API root", () => {
  assert.equal(normalizeLMStudioBaseUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
  assert.equal(normalizeLMStudioBaseUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1");
});

test("LocalGateway discovers models from the OpenAI-compatible models endpoint", async () => {
  const requests: string[] = [];
  const gateway = new LocalGateway({
    gatewayOptions: { "local/lmstudio": { base_url: "http://127.0.0.1:1234" } },
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "local-model" }, { id: "coder-model" }] }), {
        status: 200,
      });
    },
  });

  assert.deepEqual(await gateway.listCanonicalModelIds("local/lmstudio"), [
    "lmstudio/local-model",
    "lmstudio/coder-model",
  ]);
  assert.deepEqual(requests, ["http://127.0.0.1:1234/v1/models"]);
  const providers = await gateway.fetchProviders();
  assert.deepEqual(providers.lmstudio?.models, ["local-model", "coder-model"]);
  assert.equal(providers.lmstudio?.gateway, gateway.id);
});

test("LocalGateway reports malformed discovery responses as operational errors", async () => {
  const gateway = new LocalGateway({
    gatewayOptions: { "local/lmstudio": { base_url: "http://127.0.0.1:1234/v1" } },
    fetch: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
  });

  await assert.rejects(
    () => gateway.listCanonicalModelIds("local/lmstudio"),
    /LM Studio returned an invalid model catalog/,
  );
});

test("LocalGateway constructs an OpenAI-compatible language model through Mastra", async () => {
  const gateway = new LocalGateway({ gatewayOptions: { "local/lmstudio": { base_url: "http://127.0.0.1:1234/v1" } } });
  const model = await gateway.resolveLanguageModel({
    modelId: "local-model",
    providerId: "lmstudio",
    apiKey: "lmstudio-local",
  });

  assert.equal(model.modelId, "local-model");
  assert.equal(model.specificationVersion, "v3");
});
