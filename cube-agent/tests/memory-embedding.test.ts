import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRetrievalSchema } from "@cube/workspace";
import { resolveMemoryEmbedding, validateEmbeddings } from "../src/rag/embedding.js";

test("native adapters own task policy, preserve nested models/fresh credentials and use default dimensions", async () => {
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
    const config = MemoryRetrievalSchema.parse({ enabled: true, model: "ollama/nomic-embed-text:latest" });
    const auth = { getApiKey: async () => key };
    const local = await resolveMemoryEmbedding({ config, auth, localOptions: {} });
    await local.embed(["body"], "document", new AbortController().signal);
    assert.deepEqual(calls[0]!.body, { model: "nomic-embed-text:latest", input: ["search_document: body"], truncate: false });
    await local.embed(["question"], "query", new AbortController().signal);
    assert.deepEqual(calls[1]!.body.input, ["search_query: question"]);
    const api = await resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "openrouter/provider/embed" }), auth, localOptions: {} });
    await api.embed(["hello"], "document", new AbortController().signal);
    key = "second-key";
    await api.embed(["hello"], "query", new AbortController().signal);
    assert.equal(calls[2]!.body.model, "provider/embed");
    assert.deepEqual(calls[2]!.body.input, ["hello"]);
    assert.equal(calls[2]!.body.dimensions, undefined);
    assert.equal(calls[2]!.authorization, "Bearer first-key");
    assert.equal(calls[3]!.authorization, "Bearer second-key");
    const studio = await resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "lmstudio/nomic" }), auth, localOptions: { "local/lmstudio": { base_url: "http://localhost:1234" } } });
    await studio.embed(["body"], "document", new AbortController().signal);
    assert.equal(calls.at(-1)!.url, "http://localhost:1234/v1/embeddings");
    assert.deepEqual(calls.at(-1)!.body.input, ["body"]);
    const moved = await resolveMemoryEmbedding({ config, auth, localOptions: { "local/ollama": { base_url: "http://localhost:11435" } } });
    assert.notEqual(moved.profile.id, local.profile.id);
    const changed = await resolveMemoryEmbedding({ config: { ...config, model: "ollama/other" }, auth, localOptions: {} });
    assert.notEqual(changed.profile.id, local.profile.id);
    assert.equal((await resolveMemoryEmbedding({ config, auth, localOptions: {} })).profile.id, local.profile.id);
    await assert.rejects(resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model: "openai/test" }), auth: { getApiKey: async () => undefined }, localOptions: {} }), /Missing API key/);
    for (const vectors of [[], [[0, 0]], [[NaN, 1]], [[1]], [[1, 2], [1]], [[1e40, 0]], [[1e-80, 0]]]) assert.throws(() => validateEmbeddings(vectors, 1, 2));
    await assert.rejects(local.embed(["x"], "query", AbortSignal.abort()));
    await assert.rejects(api.embed(["x".repeat(api.profile.maxInputBytes + 1)], "query", new AbortController().signal), /input exceeds/);
  } finally { globalThis.fetch = original; }
});

test("Google task types and E5 prefixes are model-specific, not generic provider overrides", async () => {
  const original = globalThis.fetch;
  const calls: Record<string, any>[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.requests?.[0] ?? body);
    return body.requests ? Response.json({ embeddings: [{ values: [1, 0] }] })
      : body.content ? Response.json({ embedding: { values: [1, 0] } })
      : Response.json({ data: [{ embedding: [1, 0], index: 0 }] });
  };
  try {
    const auth = { getApiKey: async () => "test-key" };
    for (const model of ["google/gemini-embedding-001", "google/gemini-embedding-2", "google/custom-embedding", "lmstudio/multilingual-e5-large", "lmstudio/multilingual-e5-large-instruct"]) {
      const client = await resolveMemoryEmbedding({ config: MemoryRetrievalSchema.parse({ enabled: true, model }), auth, localOptions: {} });
      await client.embed(["body"], "document", new AbortController().signal);
      await client.embed(["question"], "query", new AbortController().signal);
    }
    assert.equal(calls[0]!.taskType, "RETRIEVAL_DOCUMENT");
    assert.equal(calls[1]!.taskType, "RETRIEVAL_QUERY");
    assert.equal(calls[0]!.outputDimensionality, undefined);
    assert.equal(calls[2]!.taskType, undefined);
    assert.equal(calls[2]!.content.parts[0].text, "title: none | text: body");
    assert.equal(calls[3]!.content.parts[0].text, "task: search result | query: question");
    assert.equal(calls[4]!.taskType, undefined);
    assert.equal(calls[4]!.content.parts[0].text, "body");
    assert.deepEqual(calls[6]!.input, ["passage: body"]);
    assert.deepEqual(calls[7]!.input, ["query: question"]);
    assert.deepEqual(calls[8]!.input, ["body"]);
  } finally { globalThis.fetch = original; }
});
