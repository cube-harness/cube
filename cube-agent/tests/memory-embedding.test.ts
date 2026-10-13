import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRetrievalSchema } from "@cube/workspace";
import { resolveMemoryEmbedding, validateEmbeddings } from "../src/rag/embedding.js";

test("native local/API adapters preserve prefixes/options/nested models and reject malformed dimensions", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, any>; authorization?: string | null }[] = [];
  let key = "first-key";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, authorization: new Headers(init?.headers).get("authorization") });
    return String(url).endsWith("/embed") ? Response.json({ model: body.model, embeddings: [[1, 0]], total_duration: 1, load_duration: 1, prompt_eval_count: 2 })
      : Response.json({ data: [{ embedding: [1, 0], index: 0 }], usage: { prompt_tokens: 2 } });
  };
  try {
    const config = MemoryRetrievalSchema.parse({ enabled: true, model: "ollama/nomic-embed-text:latest", dimensions: 2,
      document_prefix: "search_document: ", query_prefix: "search_query: ", provider_options: { document: { ollama: { truncate: true } } } });
    const auth = { getApiKey: async () => key };
    const local = await resolveMemoryEmbedding({ config, auth, localOptions: {} });
    await local.embed(["body"], "document", new AbortController().signal);
    assert.deepEqual(calls[0]!.body, { model: "nomic-embed-text:latest", input: ["search_document: body"], dimensions: 2, truncate: false });
    await local.embed(["question"], "query", new AbortController().signal);
    assert.deepEqual(calls[1]!.body.input, ["search_query: question"]);
    const api = await resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "openrouter/provider/embed", dimensions: 2 }), auth, localOptions: {} });
    await api.embed(["hello"], "document", new AbortController().signal);
    key = "second-key";
    await api.embed(["hello"], "query", new AbortController().signal);
    assert.equal(calls[2]!.body.model, "provider/embed");
    assert.equal(calls[2]!.authorization, "Bearer first-key");
    assert.equal(calls[3]!.authorization, "Bearer second-key");
    const studio = await resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "lmstudio/nomic", dimensions: 2 }), auth, localOptions: { "local/lmstudio": { base_url: "http://localhost:1234" } } });
    await studio.embed(["body"], "document", new AbortController().signal);
    assert.equal(calls.at(-1)!.url, "http://localhost:1234/v1/embeddings");
    await assert.rejects(resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "openai/test" }), auth: { getApiKey: async () => undefined }, localOptions: {} }), /Missing API key/);
    for (const vectors of [[], [[0, 0]], [[NaN, 1]], [[1]], [[1, 2], [1]], [[1e40, 0]], [[1e-80, 0]]]) assert.throws(() => validateEmbeddings(vectors, 1, 2));
    await assert.rejects(local.embed(["x"], "query", AbortSignal.abort()));
  } finally { globalThis.fetch = original; }
});
