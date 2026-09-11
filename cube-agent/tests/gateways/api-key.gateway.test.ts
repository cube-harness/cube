import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { GatewayLanguageModel, ProviderConfig } from "@mastra/core/llm";
import { ApiKeyProviderSchema, AuthStore, HomeManager, snapshotProviders } from "@cube/workspace";
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

test("one API strategy routes every requested provider and rejects unknown providers", async () => {
  const ids = ApiKeyProviderSchema.options;
  const gateway = new CubeApiKeyGateway({ getApiKey: async id => `test-${id}` }, {
    ...createDelegate(),
    fetchProviders: async () => Object.fromEntries([...ids, "unknown"].map(id => [id, provider(id)])),
  });
  const providers = await gateway.fetchProviders();
  assert.deepEqual(new Set(Object.keys(providers)), new Set(ids));
  for (const id of ids) {
    assert.equal(gateway.handlesModel(`${id}/vendor/model`), true);
    assert.equal(providers[id]?.gateway, "cube-api");
    assert.equal(await gateway.getApiKey(`cube-api/${id}/vendor/model`), `test-${id}`);
  }
  assert.equal(gateway.handlesModel("unknown/model"), false);
  await assert.rejects(() => gateway.getApiKey("unknown/model"));
});

test("native Mastra adapters send each provider key to its own inference endpoint", async (context) => {
  const endpoints = [
    ["anthropic", "https://api.anthropic.com/v1/messages", "x-api-key"],
    ["groq", "https://api.groq.com/openai/v1/chat/completions", "authorization"],
    ["xai", "https://api.x.ai/v1/responses", "authorization"],
    ["mistral", "https://api.mistral.ai/v1/chat/completions", "authorization"],
    ["deepseek", "https://api.deepseek.com/chat/completions", "authorization"],
    ["moonshotai", "https://api.moonshot.ai/anthropic/v1/messages", "x-api-key"],
    ["nvidia", "https://integrate.api.nvidia.com/v1/chat/completions", "authorization"],
    ["zai", "https://api.z.ai/api/paas/v4/chat/completions", "authorization"],
    ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4/chat/completions", "authorization"],
    ["alibaba", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", "authorization"],
    ["alibaba-coding-plan", "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions", "authorization"],
    ["huggingface", "https://router.huggingface.co/v1/chat/completions", "authorization"],
  ] as const;
  const requests: Array<{ url: string; headers: Headers; body: { model: string } }> = [];
  // Pin external catalog data; keep Cube and the installed native SDKs real.
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://models.dev/api.json") return Response.json(snapshotProviders);
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ error: { type: "authentication_error", message: "invalid test key" } }, { status: 401 });
  });
  const gateway = new CubeApiKeyGateway({ getApiKey: async id => `test-${id}` });
  const providers = await gateway.fetchProviders();
  for (const [id, url, header] of endpoints) {
    const modelId = providers[id]?.models[0];
    assert.ok(modelId, `Missing native provider ${id}`);
    const auth = await gateway.resolveAuth({ gatewayId: gateway.id, providerId: id, modelId,
      routerId: `cube-api/${id}/${modelId}` });
    const model = await gateway.resolveLanguageModel({ providerId: id, modelId, apiKey: auth.apiKey! });
    assert.equal(model.specificationVersion, "v3");
    if (model.specificationVersion !== "v3") throw new Error("Expected installed v3 adapter");
    await assert.rejects(() => model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "test" }] }],
    }), (error: unknown) => (error as { statusCode?: number }).statusCode === 401);
    const request = requests.at(-1)!;
    assert.equal(request.url, url, id);
    assert.equal(request.body.model, modelId, id);
    assert.equal(request.headers.get(header), header === "x-api-key" ? `test-${id}` : `Bearer test-${id}`, id);
  }
  assert.equal(requests.length, endpoints.length);
});

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
      JSON.stringify({ api_keys: {}, oauth: {} }),
      "utf8",
    );
    const auth = new AuthStore(home);
    await auth.replaceApiKey("google", "stored-google-secret");
    await auth.replaceApiKey("openrouter", "stored-openrouter-secret");

    const google = new CubeApiKeyGateway(auth, createDelegate());

    assert.deepEqual(
      await google.resolveAuth({
        gatewayId: google.id,
        providerId: "google",
        modelId: "gemini-test",
        routerId: `${google.id}/google/gemini-test`,
      }),
      { apiKey: "stored-google-secret", source: "gateway" },
    );
    assert.equal(await google.getApiKey("cube-api/openrouter/vendor/model"), "stored-openrouter-secret");
    await auth.replaceApiKey("google", "replacement-google-secret");
    assert.equal(await google.getApiKey("google/gemini-test"), "replacement-google-secret");
    assert.equal(await google.getApiKey("openrouter/vendor/model"), "stored-openrouter-secret");
  } finally {
    if (previousGoogle === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousGoogle;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    await cleanup(tmp);
  }
});

test("CubeApiKeyGateway exposes supported API providers and delegates the selected provider", async () => {
  const delegate = createDelegate();
  const auth = { getApiKey: async () => "stored-key" };
  const gateway = new CubeApiKeyGateway(auth, delegate);

  const providers = await gateway.fetchProviders();
  assert.deepEqual(new Set(Object.keys(providers)), new Set(["google", "openrouter", "openai"]));
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
    { getApiKey: async () => undefined },
    createDelegate(),
  );

  await assert.rejects(
    () => gateway.resolveAuth({
      gatewayId: gateway.id,
      providerId: "openai",
      modelId: "gpt-test",
      routerId: `${gateway.id}/openai/gpt-test`,
    }),
    /Missing API key for api_key\/openai/,
  );
  await assert.rejects(
    () => gateway.getApiKey("openai/gpt-test"),
    /Missing API key for api_key\/openai\. Run \/gateway to configure it\./,
  );
});

test("cached native API model re-resolves provider auth on replacement and blocks requests after removal", async t => {
  let key: string | undefined = "initial";
  const keys: Array<string | null> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (String(url) === "https://models.dev/api.json") return Response.json(snapshotProviders);
    keys.push(new Headers(init.headers).get("x-api-key"));
    return Response.json({ error: { type: "authentication_error", message: "test key" } }, { status: 401 });
  });
  const gateway = new CubeApiKeyGateway({ getApiKey: async () => key });
  const model = await gateway.resolveLanguageModel({ providerId: "anthropic", modelId: "claude-test", apiKey: "stale" });
  const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }];
  for (const value of ["first", "second"]) {
    key = value;
    await assert.rejects(() => model.doGenerate({ prompt }), (error: unknown) => (error as { statusCode?: number }).statusCode === 401);
  }
  assert.deepEqual(keys, ["first", "second"]);
  key = undefined;
  await assert.rejects(() => model.doGenerate({ prompt }), /Missing API key/);
  assert.equal(keys.length, 2);
});
