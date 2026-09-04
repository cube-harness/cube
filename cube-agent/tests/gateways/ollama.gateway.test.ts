import assert from "node:assert/strict";
import test from "node:test";
import {
  OllamaGateway,
  normalizeOllamaBaseUrl,
} from "../../src/gateways/ollama.gateway.js";

test("normalizeOllamaBaseUrl removes API and trailing suffixes", () => {
  assert.equal(normalizeOllamaBaseUrl("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBaseUrl("http://localhost:11434/api"), "http://localhost:11434");
});

test("OllamaGateway discovers only models pulled from api/tags", async () => {
  const requests: string[] = [];
  const gateway = new OllamaGateway({
    baseUrl: "http://127.0.0.1:11434/api/",
    fetch: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        models: [{ name: "qwen2.5:7b" }, { name: "llama3.2:latest" }],
      }), { status: 200 });
    },
  });

  assert.deepEqual(await gateway.listCanonicalModelIds(), [
    "ollama/qwen2.5:7b",
    "ollama/llama3.2:latest",
  ]);
  assert.deepEqual(requests, ["http://127.0.0.1:11434/api/tags"]);
  assert.deepEqual(Object.keys(await gateway.fetchProviders()), ["ollama"]);
});

test("OllamaGateway reports unavailable endpoints without response-body leakage", async () => {
  const gateway = new OllamaGateway({
    baseUrl: "http://127.0.0.1:11434",
    fetch: async () => new Response("secret daemon body", { status: 503 }),
  });

  await assert.rejects(
    () => gateway.listCanonicalModelIds(),
    (error: unknown) => {
      assert.match(String(error), /Ollama is unavailable at http:\/\/127\.0\.0\.1:11434/);
      assert.equal(String(error).includes("secret daemon body"), false);
      return true;
    },
  );
});

test("OllamaGateway constructs a language model through the local adapter", () => {
  const gateway = new OllamaGateway({ baseUrl: "http://127.0.0.1:11434" });
  const model = gateway.resolveLanguageModel({
    modelId: "qwen2.5:7b",
    providerId: "ollama",
    apiKey: "ollama-local",
  });

  assert.equal(model.modelId, "qwen2.5:7b");
  assert.equal(model.specificationVersion, "v3");
});
