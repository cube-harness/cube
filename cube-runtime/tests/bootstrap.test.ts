import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import {
  AuthStore,
  Bootstrap,
  ConfigStore,
  HomeManager,
  ModelCatalogStore,
  ModelManager,
  Store,
  createBootstrap,
  type ModelCatalog,
} from "@cube/workspace";
import { prepareCubeRuntime } from "../src/bootstrap.js";

const modelId = "google/gemini-test";
const catalog: ModelCatalog = {
  updatedAt: new Date().toISOString(),
  providers: {
    google: {
      name: "Google",
      models: [{
        modelId,
        name: "Gemini Test",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 128_000, output: 8_192 },
        modalities: { input: ["text"], output: ["text"] },
      }],
    },
  },
};

const withHome = async (run: (home: HomeManager) => Promise<void>) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-bootstrap-"));
  const home = new HomeManager({ cubeHome: directory });
  const canonical = new ModelManager(home, async () => ({ google: {
    name: "Google", models: { "gemini-test": catalog.providers.google!.models[0]! },
  } }));
  const originalPreview = ModelManager.prototype.preview;
  const preview = mock.method(ModelManager.prototype, "preview", (...args: Parameters<ModelManager["preview"]>) =>
    originalPreview.apply(canonical, args));
  try {
    await createBootstrap(home).run();
    await ModelCatalogStore(home).write({ api_key: {}, oauth: {}, local: {} });
    await run(home);
  } finally {
    preview.mock.restore();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const noProviderFetch: typeof fetch = async () => { assert.fail("API-key setup must not call the provider"); };

test("bootstrap skips onboarding for complete API-key config without probing the provider", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update((config) => ({
      ...config,
      gateway: "api_key/google",
      model: modelId,
    }));

    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });

    assert.deepEqual(bootstrap.readiness, {
      ready: true,
      gatewayId: "api_key/google",
      model: { modelId },
    });
    assert.equal(bootstrap.workspaceRoot.length > 0, true);
  });
});

test("bootstrap never infers or rewrites a gateway from model and credentials", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update(config => ({ ...config, gateway: undefined, model: modelId }));
    const before = await readFile(home.getConfigPath(), "utf8");
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    assert.equal(bootstrap.readiness.ready, false);
    assert.equal(await readFile(home.getConfigPath(), "utf8"), before);
  });
});

test("bootstrap reports invalid config without rewriting the file or leaking its contents", async () => {
  await withHome(async home => {
    await new Store(home.getConfigPath(), "yaml").write({ unexpected: "private-content" });
    const before = await readFile(home.getConfigPath(), "utf8");
    await assert.rejects(() => prepareCubeRuntime({ home, fetch: noProviderFetch }),
      (error: unknown) => error instanceof Error && /Invalid config.yaml/.test(error.message)
        && !error.message.includes("private-content"));
    assert.equal(await readFile(home.getConfigPath(), "utf8"), before);
  });
});

test("bootstrap requires onboarding when gateway configuration is incomplete", async () => {
  await withHome(async (home) => {
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    assert.equal(bootstrap.readiness.ready, false);
  });
});

test("bootstrap detects missing keys, unavailable models, and unreachable local gateways", async () => {
  const cases = [
    { gateway: "api_key/google" as const, model: modelId },
    { gateway: "api_key/google" as const, model: "google/missing", key: "test-key" },
    { gateway: "local/ollama" as const, model: "ollama/test" },
  ];

  for (const item of cases) {
    await withHome(async (home) => {
      if (item.key) await new AuthStore(home).replaceApiKey("google", item.key);
      await ConfigStore(home).update((config) => ({
        ...config,
        gateway: item.gateway,
        model: item.model,
      }));
      const bootstrap = await prepareCubeRuntime({
        home,
        fetch: item.gateway === "local/ollama"
          ? async () => { throw new Error("offline"); }
          : noProviderFetch,
      });
      assert.equal(bootstrap.readiness.ready, false, item.gateway);
    });
  }
});

test("start rechecks readiness before constructing the runtime", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update((config) => ({
      ...config,
      gateway: "api_key/google",
      model: modelId,
    }));
    const bootstrap = await prepareCubeRuntime({ home, fetch: noProviderFetch });
    await ConfigStore(home).update((config) => ({ ...config, model: undefined }));

    await assert.rejects(() => bootstrap.start(), /Choose a gateway and model/);
  });
});

test("startup reuses prepared resources and reads the committed model", { timeout: 30_000 }, async (context) => {
  await withHome(async home => {
    context.mock.method(home, "getMemoryDbPath", () => ":memory:");
    const run = context.mock.method(Bootstrap.prototype, "run");
    const prepared = await prepareCubeRuntime({ home, workspacePath: home.getRoot(),
      fetch: async (url, init) => String(url).endsWith("/api/tags")
        ? Response.json({ models: [{ name: "test-local" }] })
        : String(url).startsWith("https://cli-chat-proxy.grok.com/")
          ? Response.json({ data: [{ id: "grok-build" }] })
          : String(url).startsWith("https://chatgpt.com/backend-api/codex/models")
            ? Response.json({ models: [{ slug: "account-only-integration-model" }] })
            : noProviderFetch(url, init),
    });
    assert.equal(prepared.readiness.ready, false);
    const draft = await prepared.gateway.createApiKeyDraft("api_key/google", "test-key");
    await prepared.gateway.commitInitial({ draftId: draft.draftId, model: { modelId } });
    await ConfigStore(home).update(config => ({ ...config, telemetry: false,
      memory: { ...config.memory,
        vector: { ...config.memory.vector, enabled: false },
        embedder: { ...config.memory.embedder, enabled: false },
        semantic_recall: { ...config.memory.semantic_recall, enabled: false },
        generate_title: { ...config.memory.generate_title, enabled: false },
      },
    }));
    const runtime = await prepared.start();
    try {
      const preservedThread = await runtime.thread.ensureForPrompt("Preserved conversation");
      assert.equal(run.mock.callCount(), 1, "start must not bootstrap the home again");
      assert.equal(runtime.gateway, prepared.gateway);
      assert.equal(runtime.model.current().modelId, modelId);
      assert.equal(prepared.readiness.ready, true);
      assert.equal((await runtime.gateway.listModels()).providers.google?.models[0]?.modelId, modelId);
      await new AuthStore(home).update(auth => ({ ...auth, oauth: { ...auth.oauth,
        xai: { access_token: "grok-test", refresh_token: "grok-refresh", expires_at: Date.now() + 3600000 },
      } }));
      const grok = await runtime.gateway.createStoredDraft("oauth/xai");
      // Use the real Session gate to exercise the runtime's live-switch boundary.
      const session = (runtime as unknown as { dependencies: { session: import("@cube/agent").Session } }).dependencies.session;
      const approval = session.approval.arm({ toolName: "execute_command", toolCallId: "gate" });
      await assert.rejects(runtime.gateway.set({ draftId: grok.draftId, model: { modelId: "xai/grok-build" } }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /rollback failed/);
        assert.match(String(error.cause), /Finish or cancel/);
        return true;
      });
      assert.equal(runtime.model.current().modelId, modelId);
      assert.equal((await ConfigStore(home).read()).gateway, "api_key/google");
      runtime.respondToApproval({ toolName: "execute_command", toolCallId: "gate", decision: "decline" });
      await approval;
      session.approval.clearToolName();
      const grokRetry = await runtime.gateway.createStoredDraft("oauth/xai");
      await runtime.gateway.set({ draftId: grokRetry.draftId, model: { modelId: "xai/grok-build" } });
      assert.equal(runtime.model.current().modelId, "xai/grok-build");
      assert.equal((await ConfigStore(home).read()).gateway, "oauth/xai");
      assert.equal((await runtime.gateway.listModels()).providers.xai?.models[0]?.tool_call, undefined);
      assert.equal((await runtime.gateway.readiness()).ready, true);
      await new AuthStore(home).update(auth => ({ ...auth, oauth: { ...auth.oauth,
        openai: { access_token: "openai-test", refresh_token: "openai-refresh",
          account_id: "integration-account", expires_at: Date.now() + 3600000 },
      } }));
      const openai = await runtime.gateway.createStoredDraft("oauth/openai");
      await runtime.gateway.set({ draftId: openai.draftId, model: { modelId: "openai/account-only-integration-model" } });
      assert.equal(runtime.model.current().modelId, "openai/account-only-integration-model");
      const local = await runtime.gateway.createLocalDraft("local/ollama", "http://127.0.0.1:11435");
      await runtime.gateway.set({ draftId: local.draftId, model: { modelId: "ollama/test-local" } });
      assert.equal(runtime.model.current().modelId, "ollama/test-local");
      assert.equal((await ConfigStore(home).read()).gateway, "local/ollama");
      const api = await runtime.gateway.createStoredDraft("api_key/google");
      await runtime.gateway.set({ draftId: api.draftId, model: { modelId } });
      const cache = await ModelCatalogStore(home).read();
      assert.ok(cache.api_key.google && cache.oauth.openai && cache.oauth.xai && cache.local.ollama);
      const removed = await runtime.gateway.removeCredential("oauth/openai");
      assert.equal(removed.active, false);
      assert.equal(removed.cacheCleared, true);
      assert.equal((await ModelCatalogStore(home).read()).oauth.openai, undefined);
      assert.deepEqual((await ModelCatalogStore(home).read()).oauth.xai, cache.oauth.xai);
      assert.ok((await ModelCatalogStore(home).read()).api_key.google);
      await runtime.gateway.removeCredential("api_key/google");
      assert.equal((await runtime.gateway.readiness()).ready, false);
      assert.equal((await runtime.prompt.submit("must not reach inference")).kind, "gateways");
      const restored = await runtime.gateway.createApiKeyDraft("api_key/google", "replacement-key");
      await runtime.gateway.set({ draftId: restored.draftId, model: { modelId } });
      assert.equal((await runtime.gateway.readiness()).ready, true);
      assert.equal(runtime.thread.current(), preservedThread);
    } finally { await runtime.shutdown(); }
  });
});
