import assert from "node:assert/strict";
import test from "node:test";
import type {
  CubeAuth,
  CubeConfigDocument,
  GatewayId,
  ModelCatalog,
} from "@cube/workspace";
import { GatewayService } from "../../src/services/gateway.service.js";

const model = (modelId: string) => ({
  modelId,
  name: modelId,
  reasoning: true,
  reasoning_efforts: ["none", "high"] as const,
  tool_call: true,
  structured_output: true,
  attachment: false,
  open_weights: false,
  limit: { context: 128_000, output: 8_192 },
  modalities: { input: ["text"] as const, output: ["text"] as const },
});

const catalog: ModelCatalog = {
  version: 2,
  updatedAt: new Date(0).toISOString(),
  providers: {
    google: { name: "Google", models: [model("google/gemini-test")] },
    openrouter: { name: "OpenRouter", models: [model("openrouter/vendor/test")] },
    openai: { name: "OpenAI", models: [model("openai/gpt-test")] },
  },
};

const baseConfig = (): CubeConfigDocument => ({
  version: 2,
  gateway: "api_key/google",
  model: "google/gemini-test",
  gateway_options: {
    "local/ollama": { base_url: "http://127.0.0.1:11434" },
    "local/lmstudio": { base_url: "http://127.0.0.1:1234/v1" },
  },
  model_config: {},
  theme: "default",
  app_title: ["model"],
  status_line: ["model"],
  telemetry: false,
  soul: { max_characters: 10_000 },
  memory: {
    storage: { provider: "sqlite", mode: "local" },
    vector: { enabled: false, provider: "sqlite", mode: "local" },
    embedder: { enabled: false, model: null },
    generate_title: { enabled: false, model: "google/gemini-test", instructions: "title" },
    semantic_recall: { enabled: false, top_k: 1, message_range: { before: 0, after: 0 }, scope: "resource", threshold: null },
    working_memory: { enabled: false, scope: "resource", use_state_signals: false, agent_managed: false, template: "memory" },
    observational_memory: {
      enabled: false,
      scope: "resource",
      activate_after_idle: false,
      activate_on_provider_change: false,
      share_token_budget: false,
      temporal_markers: false,
      retrieval: { enabled: false, vector: false, scope: "resource" },
      observation: { model: "google/gemini-test", message_tokens: 1000, buffer_tokens: false, buffer_on_idle: false, buffer_activation: 1, block_after: 1, previous_observer_tokens: false, instruction: null, manage_working_memory: false, thread_title: false, observe_attachments: false },
      reflection: { model: "google/gemini-test", observation_tokens: 1000, buffer_activation: 1, block_after: 1, instruction: null },
    },
  },
  permissions: { require_approval_for: [] },
});

const createHarness = (options: {
  config?: CubeConfigDocument;
  auth?: CubeAuth;
  fetch?: typeof globalThis.fetch;
  apply?: (gatewayId: GatewayId, modelId: string) => void | Promise<void>;
  adapters?: Map<GatewayId, { gatewayId: GatewayId; getBaseUrl?(): string; setBaseUrl?(url: string): void }>;
  openAIAuth?: {
    beginLogin(): Promise<{
      authorizationUrl: string;
      completion: Promise<{
        access_token: string;
        refresh_token: string;
        expires_at: number;
        account_id: string;
      }>;
      cancel(): Promise<void>;
    }>;
  };
} = {}) => {
  let config = structuredClone(options.config ?? baseConfig());
  let auth = structuredClone(options.auth ?? {
    version: 1,
    api_keys: { google: { api_key: "stored-google" } },
    subscriptions: {},
  } satisfies CubeAuth);
  const service = new GatewayService({
    config: {
      read: async () => structuredClone(config),
      update: async (mutator) => (config = structuredClone(mutator(config))),
    },
    auth: {
      read: async () => structuredClone(auth),
      update: async (mutator) => (auth = structuredClone(mutator(auth))),
    },
    adapters: options.adapters ?? new Map(),
    catalog: { getCatalog: async () => catalog },
    fetch: options.fetch ?? (async () => new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] }), { status: 200 })),
    openAIAuth: options.openAIAuth,
    applyLiveSelection: options.apply
      ? (gatewayId, selection) => options.apply!(gatewayId, selection.modelId)
      : undefined,
  });
  return { service, config: () => config, auth: () => auth };
};

test("readiness requires a complete config and usable stored gateway", async () => {
  const incomplete = baseConfig();
  delete incomplete.gateway;
  delete incomplete.model;
  const missing = createHarness({ config: incomplete });
  assert.deepEqual(await missing.service.readiness(), {
    ready: false,
    reason: "Choose a gateway and model to continue.",
  });

  const ready = createHarness();
  assert.deepEqual(await ready.service.readiness(), {
    ready: true,
    gatewayId: "api_key/google",
    model: { modelId: "google/gemini-test" },
  });
});

test("API-key drafts are credential-free and commit key, gateway, and model together", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const harness = createHarness({
    auth: {
      version: 1,
      api_keys: { openrouter: { api_key: "keep-openrouter" } },
      subscriptions: {},
    },
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization") ?? undefined,
      });
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] }), { status: 200 });
    },
  });

  const draft = await harness.service.createApiKeyDraft(
    "api_key/google",
    "new-google-secret",
  );
  assert.equal(JSON.stringify(draft).includes("new-google-secret"), false);
  assert.equal(calls[0]?.url, "https://generativelanguage.googleapis.com/v1beta/models");
  assert.equal(calls[0]?.authorization, undefined);

  await harness.service.set({ draftId: draft.draftId, model: { modelId: "google/gemini-test" } });
  assert.equal(harness.auth().api_keys.google?.api_key, "new-google-secret");
  assert.equal(harness.auth().api_keys.openrouter?.api_key, "keep-openrouter");
  assert.equal(harness.config().gateway, "api_key/google");
  assert.equal(harness.config().model, "google/gemini-test");
});

test("failed live apply rolls auth and config back", async () => {
  const beforeConfig = baseConfig();
  const beforeAuth: CubeAuth = {
    version: 1,
    api_keys: { google: { api_key: "old-google" } },
    subscriptions: {},
  };
  const applied: string[] = [];
  const harness = createHarness({
    config: beforeConfig,
    auth: beforeAuth,
    fetch: async () => new Response(JSON.stringify({ data: { label: "ok" } }), { status: 200 }),
    apply: async (gatewayId, modelId) => {
      applied.push(`${gatewayId}:${modelId}`);
      if (gatewayId === "api_key/openrouter") throw new Error("live failed");
    },
  });
  const draft = await harness.service.createApiKeyDraft(
    "api_key/openrouter",
    "new-openrouter",
  );

  await assert.rejects(
    () => harness.service.set({
      draftId: draft.draftId,
      model: { modelId: "openrouter/vendor/test" },
    }),
    /Gateway switch failed/,
  );
  assert.deepEqual(harness.auth(), beforeAuth);
  assert.deepEqual(harness.config(), beforeConfig);
  assert.deepEqual(applied, [
    "api_key/openrouter:openrouter/vendor/test",
    "api_key/google:google/gemini-test",
  ]);
});

test("model listing is scoped to one gateway", async () => {
  const harness = createHarness();
  const listed = await harness.service.listModels("api_key/google");
  assert.deepEqual(Object.keys(listed.providers), ["google"]);
  assert.deepEqual(listed.providers.google?.models.map((item) => item.modelId), [
    "google/gemini-test",
  ]);
});

test("provider drafts validate through provider-specific endpoints and headers", async (context) => {
  const cases = [
    {
      gatewayId: "api_key/google" as const,
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      body: { models: [{ name: "models/gemini-test" }] },
      header: ["x-goog-api-key", "candidate-key"],
    },
    {
      gatewayId: "api_key/openrouter" as const,
      url: "https://openrouter.ai/api/v1/key",
      body: { data: { label: "valid" } },
      header: ["authorization", "Bearer candidate-key"],
    },
    {
      gatewayId: "api_key/openai" as const,
      url: "https://api.openai.com/v1/models",
      body: { data: [{ id: "gpt-test" }] },
      header: ["authorization", "Bearer candidate-key"],
    },
  ] as const;

  for (const item of cases) {
    await context.test(item.gatewayId, async () => {
      let request: { url: string; headers: Headers } | undefined;
      const harness = createHarness({
        fetch: async (input, init) => {
          request = { url: String(input), headers: new Headers(init?.headers) };
          return new Response(JSON.stringify(item.body), { status: 200 });
        },
      });
      const draft = await harness.service.createApiKeyDraft(item.gatewayId, "candidate-key");
      assert.equal(request?.url, item.url);
      assert.equal(request?.headers.get(item.header[0]), item.header[1]);
      assert.equal(JSON.stringify(draft).includes("candidate-key"), false);
    });
  }
});

test("OpenAI login stages tokens until the selected subscription model commits", async () => {
  const candidate = {
    access_token: "candidate-access",
    refresh_token: "candidate-refresh",
    expires_at: Date.now() + 3_600_000,
    account_id: "candidate-account",
  };
  const harness = createHarness({
    openAIAuth: {
      beginLogin: async () => ({
        authorizationUrl: "https://auth.openai.com/oauth/authorize?state=public",
        completion: Promise.resolve(candidate),
        cancel: async () => undefined,
      }),
    },
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer candidate-access");
      return new Response(JSON.stringify({ models: [{ slug: "gpt-test" }] }), { status: 200 });
    },
  });

  const login = await harness.service.beginOpenAILogin();
  assert.match(login.authorizationUrl, /^https:\/\/auth\.openai\.com/);
  const draft = await login.completion;
  assert.equal(JSON.stringify(draft).includes("candidate-access"), false);
  assert.equal(harness.auth().subscriptions.openai, undefined);
  await harness.service.set({
    draftId: draft.draftId,
    model: { modelId: "openai/gpt-test" },
  });
  assert.deepEqual(harness.auth().subscriptions.openai, candidate);
});

test("local endpoint replacement remains staged and updates the registered adapter on commit", async () => {
  let adapterUrl = "http://127.0.0.1:11434";
  const adapter = {
    gatewayId: "local/ollama" as const,
    getBaseUrl: () => adapterUrl,
    setBaseUrl: (url: string) => { adapterUrl = url; },
  };
  const harness = createHarness({
    adapters: new Map([["local/ollama", adapter]]),
    fetch: async () => new Response(JSON.stringify({
      models: [{ name: "local-model" }],
    }), { status: 200 }),
  });

  const draft = await harness.service.createLocalDraft(
    "local/ollama",
    "http://127.0.0.1:2244/api/",
  );
  assert.equal(adapterUrl, "http://127.0.0.1:11434");
  await harness.service.set({
    draftId: draft.draftId,
    model: { modelId: "ollama/local-model" },
  });
  assert.equal(adapterUrl, "http://127.0.0.1:2244");
  assert.equal(
    harness.config().gateway_options["local/ollama"]?.base_url,
    "http://127.0.0.1:2244",
  );
});
