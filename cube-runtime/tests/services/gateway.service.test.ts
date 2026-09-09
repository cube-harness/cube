import assert from "node:assert/strict";
import test from "node:test";
import type {
  CubeAuth,
  CubeConfigDocument,
  GatewayId,
  ModelCatalog,
  OpenAIOAuthCredential,
} from "@cube/workspace";
import { ModelManager, HomeManager } from "@cube/workspace";
import { GatewayService } from "../../src/services/gateway.service.js";
import type { GatewayServiceDependencies } from "../../src/services/gateway.service.js";

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
  updatedAt: new Date(0).toISOString(),
  providers: {
    google: { name: "Google", models: [model("google/gemini-test")] },
    openrouter: { name: "OpenRouter", models: [model("openrouter/vendor/test")] },
    openai: { name: "OpenAI", models: [model("openai/gpt-test")] },
  },
};

const baseConfig = (): CubeConfigDocument => ({
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
  catalog?: ModelCatalog;
  removeCatalog?: () => Promise<void>;
  onRemoved?: () => void;
  config?: CubeConfigDocument;
  auth?: CubeAuth;
  fetch?: typeof globalThis.fetch;
  apply?: (gatewayId: GatewayId, modelId: string) => void | Promise<void>;
  adapters?: Map<GatewayId, { gatewayId: GatewayId; getBaseUrl?(): string; setBaseUrl?(url: string): void }>;
  openAIAuth?: {
    getValidCredential?(): Promise<OpenAIOAuthCredential>;
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
  grokAuth?: GatewayServiceDependencies["grokAuth"];
  anthropicAuth?: GatewayServiceDependencies["anthropicAuth"];
} = {}) => {
  let config = structuredClone(options.config ?? baseConfig());
  let auth = structuredClone(options.auth ?? {
    api_keys: { google: { api_key: "stored-google" } },
    oauth: {},
  } satisfies CubeAuth);
  const manager = new ModelManager(new HomeManager({ cubeHome: "unused-preview-only" }), async () =>
    Object.fromEntries(Object.entries((options.catalog ?? catalog).providers).map(([provider, group]) => [
      provider, { name: group.name, models: Object.fromEntries(group.models.map(model => [
        model.modelId.slice(provider.length + 1), { ...model, reasoning_options: [{ type: "effort", values: model.reasoning_efforts }] },
      ])) },
    ])));
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
    catalog: { getCatalog: async () => undefined,
      preview: (gatewayId, available) => manager.preview(gatewayId, available),
      publish: async (gatewayId, key) => ModelManager.sourceKey(gatewayId, { auth, config }) === key,
      remove: options.removeCatalog ?? (async () => undefined),
    },
    onActiveCredentialRemoved: options.onRemoved,
    fetch: options.fetch ?? (async () => new Response(JSON.stringify({ models: [{ name: "models/gemini-test" }] }), { status: 200 })),
    openAIAuth: options.openAIAuth ? { ...options.openAIAuth,
      getValidCredential: options.openAIAuth.getValidCredential ? async () => {
        const refreshed = await options.openAIAuth!.getValidCredential!();
        auth.oauth.openai = refreshed;
        return refreshed;
      } : undefined,
    } : undefined,
    grokAuth: options.grokAuth,
    anthropicAuth: options.anthropicAuth,
    applyLiveSelection: options.apply
      ? (gatewayId, selection) => options.apply!(gatewayId, selection.modelId)
      : undefined,
  });
  return { service, config: () => config, auth: () => auth };
};

test("Anthropic OAuth discovers paginated models, joins capabilities and commits/logs out independently", async () => {
  const candidate = { access_token: "anthropic-access", refresh_token: "anthropic-refresh", expires_at: Date.now() + 3600000 };
  let removed = false;
  const harness = createHarness({
    catalog: { ...catalog, providers: { ...catalog.providers, anthropic: { name: "Anthropic", models: [model("anthropic/known")] } } },
    auth: { api_keys: { anthropic: { api_key: "keep-api" } }, oauth: { xai: { ...candidate, access_token: "keep-xai" } } },
    anthropicAuth: {
      beginLogin: async () => ({ authorizationUrl: "https://claude.ai/oauth/authorize", expiresAt: Date.now() + 300000, completion: Promise.resolve(candidate), cancel: async () => undefined }),
      getValidCredential: async () => candidate,
    },
    removeCatalog: async () => { removed = true; },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://api.anthropic.com/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer anthropic-access");
      return Response.json(url.searchParams.has("after_id")
        ? { data: [{ id: "new-account-model" }], has_more: false }
        : { data: [{ id: "known" }], has_more: true, last_id: "known" });
    },
  });
  assert.equal((await harness.service.listChoices()).find(row => row.gatewayId === "oauth/anthropic")?.configured, false);
  const login = await harness.service.beginAnthropicLogin();
  const draft = await login.completion;
  assert.equal(harness.auth().oauth.anthropic, undefined);
  assert.equal(JSON.stringify(draft).includes(candidate.access_token), false);
  const models = draft.catalog.providers.anthropic!.models;
  assert.deepEqual(models.map(row => row.modelId), ["anthropic/known", "anthropic/new-account-model"]);
  assert.equal(models[0]?.limit?.context, 128000);
  assert.equal(models[1]?.limit, undefined);
  await harness.service.set({ draftId: draft.draftId, model: { modelId: "anthropic/known" } });
  assert.equal(harness.config().gateway, "oauth/anthropic");
  assert.deepEqual(harness.auth().oauth.anthropic, candidate);
  assert.equal((await harness.service.readiness()).ready, true);
  assert.deepEqual(Object.keys((await harness.service.listModels()).providers), ["anthropic"]);
  await harness.service.removeCredential("oauth/anthropic");
  assert.equal(removed, true);
  assert.equal(harness.auth().oauth.anthropic, undefined);
  assert.equal(harness.auth().api_keys.anthropic?.api_key, "keep-api");
  assert.equal(harness.auth().oauth.xai?.access_token, "keep-xai");
});

test("Anthropic rejected discovery and late login after logout cannot replace credentials", async () => {
  const saved = { access_token: "saved", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
  let resolve!: (credential: typeof saved) => void;
  const completion = new Promise<typeof saved>(yes => { resolve = yes; });
  const harness = createHarness({
    auth: { api_keys: {}, oauth: { anthropic: saved } },
    anthropicAuth: {
      beginLogin: async () => ({ authorizationUrl: "https://claude.ai/oauth/authorize", expiresAt: Date.now() + 300000, completion, cancel: async () => undefined }),
      getValidCredential: async () => saved,
    },
    fetch: async () => new Response("denied", { status: 403 }),
  });
  await assert.rejects(harness.service.createStoredDraft("oauth/anthropic"), /credential was rejected/);
  assert.deepEqual(harness.auth().oauth.anthropic, saved);
  const login = await harness.service.beginAnthropicLogin();
  await harness.service.removeCredential("oauth/anthropic");
  resolve({ ...saved, access_token: "late" });
  await assert.rejects(login.completion, /expired/);
  assert.equal(harness.auth().oauth.anthropic, undefined);
  assert.equal(harness.config().gateway, "api_key/google");
});

test("new native API providers use canonical models, never the OpenAI discovery endpoint", async () => {
  const ids = ["anthropic", "groq", "xai", "mistral", "deepseek", "moonshotai", "nvidia",
    "poolside", "zai", "zai-coding-plan", "alibaba", "alibaba-coding-plan", "huggingface"] as const;
  const nativeCatalog = { ...catalog, providers: { ...catalog.providers,
    ...Object.fromEntries(ids.map(id => [id, { name: id, models: [model(`${id}/vendor/model`)] }])),
  } };
  const harness = createHarness({ catalog: nativeCatalog,
    fetch: async () => { throw new Error("Native provider discovery must not call an unrelated API"); },
  });
  const choices = await harness.service.listChoices();
  for (const id of ids) {
    const gatewayId = `api_key/${id}` as const;
    assert.ok(choices.some(choice => choice.gatewayId === gatewayId));
    const before = structuredClone(harness.auth());
    const draft = await harness.service.createApiKeyDraft(gatewayId, `test-${id}`);
    assert.deepEqual(Object.keys(draft.catalog.providers), [id]);
    assert.deepEqual(draft.catalog.providers[id]?.models, [model(`${id}/vendor/model`)]);
    assert.deepEqual(harness.auth(), before);
    await harness.service.set({ draftId: draft.draftId, model: { modelId: `${id}/vendor/model` } });
    assert.equal(harness.config().gateway, gatewayId);
    assert.equal(harness.auth().api_keys[id]?.api_key, `test-${id}`);
    assert.equal(harness.auth().api_keys.google?.api_key, "stored-google");
    assert.deepEqual(Object.keys((await harness.service.listModels()).providers), [id]);
    assert.equal((await harness.service.readiness()).ready, true);
  }
});

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

test("Grok Build is an independent OAuth choice, never configured by an xAI API key", async () => {
  const harness = createHarness({ auth: { api_keys: { xai: { api_key: "api-only" } }, oauth: {} } });
  assert.deepEqual((await harness.service.listChoices()).find(choice => choice.gatewayId === "oauth/xai"), {
    gatewayId: "oauth/xai", group: "oauth", provider: "xai", configured: false,
  });
});

test("Grok login filters account models, stages credentials, and commits without changing other providers", async () => {
  const candidate = { access_token: "grok-candidate", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
  const harness = createHarness({
    grokAuth: { beginLogin: async () => ({ expiresAt: Date.now() + 1800000, authorizationUrl: "https://auth.x.ai/activate", userCode: "ABCD", completion: Promise.resolve(candidate), cancel: async () => undefined }),
      getValidCredential: async () => candidate },
    fetch: async (input, init) => {
      assert.equal(String(input), "https://cli-chat-proxy.grok.com/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer grok-candidate");
      return Response.json({ object: "list", data: [{ id: "grok-build", object: "model", owned_by: "xai" }] });
    },
  });
  const login = await harness.service.beginGrokLogin();
  const draft = await login.completion;
  assert.equal(login.userCode, "ABCD");
  assert.equal(harness.auth().oauth.xai, undefined);
  assert.equal(JSON.stringify(draft).includes("grok-candidate"), false);
  assert.deepEqual(draft.catalog.providers.xai?.models.map(model => model.modelId), ["xai/grok-build"]);
  await harness.service.set({ draftId: draft.draftId, model: { modelId: "xai/grok-build" } });
  assert.equal(harness.config().gateway, "oauth/xai");
  assert.equal(harness.config().model, "xai/grok-build");
  assert.deepEqual(harness.auth().oauth.xai, candidate);
  assert.equal(harness.auth().api_keys.google?.api_key, "stored-google");
  assert.equal((await harness.service.readiness()).ready, true);
});

test("API-key drafts are credential-free and commit key, gateway, and model together", async () => {
  const calls: Array<{ url: string; authorization?: string }> = [];
  const harness = createHarness({
    auth: {
      api_keys: { openrouter: { api_key: "keep-openrouter" } },
      oauth: {},
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
    api_keys: { google: { api_key: "old-google" } },
    oauth: {},
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

test("OpenAI login stages tokens until the selected oauth model commits", async () => {
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
  assert.equal(harness.auth().oauth.openai, undefined);
  await harness.service.set({
    draftId: draft.draftId,
    model: { modelId: "openai/gpt-test" },
  });
  assert.deepEqual(harness.auth().oauth.openai, candidate);
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

test("gateway validation preserves safe quota and authentication categories", async () => {
  const quota = createHarness({
    fetch: async () => new Response("limited", { status: 429 }),
  });
  await assert.rejects(
    () => quota.service.createApiKeyDraft("api_key/google", "candidate"),
    /Google quota or rate limit reached/,
  );

  const auth = createHarness({
    fetch: async () => new Response("unauthorized", { status: 401 }),
  });
  await assert.rejects(
    () => auth.service.createApiKeyDraft("api_key/google", "candidate"),
    /Google credential was rejected/,
  );
});

test("oauth readiness refreshes before model discovery", async () => {
  const old = { access_token: "expired", refresh_token: "refresh", account_id: "account", expires_at: 1 };
  let refreshes = 0;
  const harness = createHarness({
    config: { ...baseConfig(), gateway: "oauth/openai", model: "openai/gpt-test" },
    auth: { api_keys: {}, oauth: { openai: old } },
    openAIAuth: {
      beginLogin: async () => { throw new Error("Must not log in during refresh"); },
      getValidCredential: async () => {
        refreshes++;
        return { ...old, access_token: "fresh", expires_at: Date.now() + 3_600_000 };
      },
    },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh");
      return Response.json({ models: [{ slug: "gpt-test" }] });
    },
  });
  assert.equal((await harness.service.readiness()).ready, true);
  assert.equal(refreshes, 1);
});

test("a failed oauth refresh preserves stored auth and does not use expired access", async () => {
  const old = { access_token: "expired", refresh_token: "refresh", account_id: "account", expires_at: 1 };
  const harness = createHarness({
    config: { ...baseConfig(), gateway: "oauth/openai", model: "openai/gpt-test" },
    auth: { api_keys: {}, oauth: { openai: old } },
    openAIAuth: {
      beginLogin: async () => { throw new Error("unexpected login"); },
      getValidCredential: async () => { throw new Error("OpenAI session could not be refreshed. Sign in again with /gateway."); },
    },
    fetch: async () => { assert.fail("must not send an expired token"); },
  });
  assert.equal((await harness.service.readiness()).ready, false);
  assert.deepEqual(harness.auth().oauth.openai, old);
});

test("rollback failure reports both failures and never claims the previous configuration is active", async () => {
  const harness = createHarness({
    fetch: async () => Response.json({ data: {} }),
    apply: async () => { throw new Error("apply failed"); },
  });
  const draft = await harness.service.createApiKeyDraft("api_key/openrouter", "new-key");
  await assert.rejects(() => harness.service.set({ draftId: draft.draftId, model: { modelId: "openrouter/vendor/test" } }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /rollback failed/);
      assert.doesNotMatch(error.message, /previous configuration is still active/);
      return true;
    });
});

test("cancellation during discovery cannot produce a pending draft", async () => {
  const abort = new AbortController();
  const harness = createHarness({ fetch: async () => {
    abort.abort();
    return Response.json({ models: [{ name: "models/gemini-test" }] });
  } });
  await assert.rejects(() => harness.service.createStoredDraft("api_key/google", abort.signal), /abort/i);
  assert.equal(harness.config().gateway, "api_key/google");
});

test("logout is provider/strategy scoped, durable if cache cleanup fails, and invalidates pending login", async () => {
  const credential = { access_token: "old-access", refresh_token: "old-refresh", expires_at: Date.now() + 3600000, account_id: "old-account" };
  let complete!: (value: OpenAIOAuthCredential) => void;
  const completion = new Promise<OpenAIOAuthCredential>(resolve => { complete = resolve; });
  let interrupted = 0;
  let cancelled = 0;
  const harness = createHarness({
    config: { ...baseConfig(), gateway: "oauth/openai", model: "openai/gpt-test" },
    auth: { api_keys: { openai: { api_key: "api-key" }, google: { api_key: "google-key" } }, oauth: { openai: credential } },
    openAIAuth: { beginLogin: async () => ({ authorizationUrl: "https://auth.openai.com/authorize", completion, cancel: async () => { cancelled++; } }) },
    onRemoved: () => { interrupted++; },
    removeCatalog: async () => { throw new Error("disk full"); },
    fetch: async () => Response.json({ models: [{ slug: "gpt-test" }] }),
  });
  const login = await harness.service.beginOpenAILogin();
  const failed = assert.rejects(login.completion, /expired|changed/);
  const result = await harness.service.removeCredential("oauth/openai");
  complete({ ...credential, account_id: "late-account" });
  await failed;
  assert.deepEqual(result, { gatewayId: "oauth/openai", active: true, cacheCleared: false });
  assert.equal(interrupted, 1);
  assert.equal(cancelled, 1, "logout must close a pending login");
  assert.equal(harness.auth().oauth.openai, undefined);
  assert.equal(harness.auth().api_keys.openai?.api_key, "api-key");
  assert.equal(harness.auth().api_keys.google?.api_key, "google-key");
  assert.equal(harness.config().gateway, "oauth/openai");
  assert.equal((await harness.service.readiness()).ready, false);
  await harness.service.removeCredential("api_key/google");
  assert.equal(interrupted, 1, "inactive removal must not abort");
});

test("delayed discovery and failed switch cannot resurrect credentials after removal", async () => {
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const harness = createHarness({ fetch: async () => {
    started(); await gate;
    return Response.json({ models: [{ name: "models/gemini-test" }] });
  } });
  const draft = harness.service.createStoredDraft("api_key/google");
  const rejected = assert.rejects(draft, /expired|changed/);
  await waiting;
  await harness.service.removeCredential("api_key/google");
  release();
  await rejected;
  assert.equal(harness.auth().api_keys.google, undefined);
});

test("account-only model stays selectable with explicit metadata and login does not mark it current", async () => {
  const credential = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000, account_id: "account" };
  const harness = createHarness({
    openAIAuth: { beginLogin: async () => ({
      authorizationUrl: "https://auth.openai.com/authorize", completion: Promise.resolve(credential), cancel: async () => undefined,
    }) },
    fetch: async () => Response.json({ models: [{
      slug: "new-account-model", display_name: "Account Model", context_window: 200000,
      supported_reasoning_levels: [{ effort: "high" }], input_modalities: ["text", "image"],
    }] }),
  });
  const draft = await (await harness.service.beginOpenAILogin()).completion;
  assert.equal(draft.currentModelId, undefined);
  const item = draft.catalog.providers.openai!.models[0]!;
  assert.equal(item.modelId, "openai/new-account-model");
  assert.deepEqual(item.limit, { context: 200000 });
  assert.deepEqual(item.reasoning_efforts, ["high"]);
  assert.equal(item.tool_call, undefined);
  await harness.service.set({ draftId: draft.draftId, model: { modelId: item.modelId, reasoningEffort: "high" } });
  assert.equal(harness.config().model, item.modelId);
});
