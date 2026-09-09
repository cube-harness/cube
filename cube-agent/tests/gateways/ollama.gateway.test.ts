import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalGateway,
  normalizeOllamaBaseUrl,
} from "../../src/gateways/local.gateway.js";

test("normalizeOllamaBaseUrl removes API and trailing suffixes", () => {
  assert.equal(normalizeOllamaBaseUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434/api"), "http://localhost:11434");
});

test("LocalGateway discovers only models pulled from api/tags", async () => {
  const requests: string[] = [];
  const gateway = new LocalGateway({
    gatewayOptions: { "local/ollama": { base_url: "http://127.0.0.1:11434/api/" } },
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        models: [{ name: "qwen2.5:7b" }, { name: "llama3.2:latest" }],
      }), { status: 200 });
    },
  });

  assert.deepEqual(await gateway.listCanonicalModelIds("local/ollama"), [
    "ollama/qwen2.5:7b",
    "ollama/llama3.2:latest",
  ]);
  assert.deepEqual(requests, ["http://127.0.0.1:11434/api/tags"]);
  assert.deepEqual((await gateway.fetchProviders()).ollama?.models, ["qwen2.5:7b", "llama3.2:latest"]);
});

test("LocalGateway reports unavailable endpoints without response-body leakage", async () => {
  const gateway = new LocalGateway({
    gatewayOptions: { "local/ollama": { base_url: "http://127.0.0.1:11434" } },
    fetch: async () => new Response("secret daemon body", { status: 503 }),
  });

  await assert.rejects(
    () => gateway.listCanonicalModelIds("local/ollama"),
    (error: unknown) => {
      assert.match(String(error), /Ollama is unavailable at http:\/\/127\.0\.0\.1:11434/);
      assert.equal(String(error).includes("secret daemon body"), false);
      return true;
    },
  );
});

test("LocalGateway constructs a language model through the local adapter", async () => {
  const gateway = new LocalGateway({ gatewayOptions: { "local/ollama": { base_url: "http://127.0.0.1:11434" } } });
  const model = await gateway.resolveLanguageModel({
    modelId: "qwen2.5:7b",
    providerId: "ollama",
    apiKey: "ollama-local",
  });

  assert.equal(model.modelId, "qwen2.5:7b");
  assert.equal(model.specificationVersion, "v3");
});

test("a stopped Ollama server does not hide LM Studio models in the shared local strategy", async () => {
  const gateway = new LocalGateway({
    fetch: async (input) => String(input).endsWith("/api/tags")
      ? new Response("unavailable", { status: 503 })
      : Response.json({ data: [{ id: "vendor/local-model" }] }),
  });
  const providers = await gateway.fetchProviders();
  assert.deepEqual(providers.ollama?.models, []);
  assert.deepEqual(providers.lmstudio?.models, ["vendor/local-model"]);
  assert.equal(gateway.buildUrl("cube-local/ollama/model"), "http://127.0.0.1:11434/api");
  assert.equal(gateway.buildUrl("cube-local/lmstudio/vendor/local-model"), "http://127.0.0.1:1234/v1");
});
