import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthStore,
  ConfigStore,
  HomeManager,
  ModelCatalogStore,
  Store,
  createBootstrap,
  type ModelCatalog,
} from "@cube/workspace";
import { prepareCubeRuntime } from "../src/preflight.js";

const modelId = "google/gemini-test";
const catalog: ModelCatalog = {
  version: 2,
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-preflight-"));
  const home = new HomeManager({ cubeHome: directory });
  try {
    await createBootstrap(home).run();
    await ModelCatalogStore(home).write(catalog);
    await run(home);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const googleFetch: typeof fetch = async () => new Response(JSON.stringify({
  models: [{ name: "models/gemini-test" }],
}), { status: 200 });

test("preflight skips onboarding for a complete reachable persisted gateway", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    await ConfigStore(home).update((config) => ({
      ...config,
      gateway: "api_key/google",
      model: modelId,
    }));

    const preflight = await prepareCubeRuntime({ home, fetch: googleFetch });

    assert.deepEqual(preflight.readiness, {
      ready: true,
      gatewayId: "api_key/google",
      model: { modelId },
    });
    assert.equal(preflight.workspaceRoot.length > 0, true);
  });
});

test("preflight migrates legacy config before checking readiness", async () => {
  await withHome(async (home) => {
    await new AuthStore(home).replaceApiKey("google", "test-key");
    const current = await ConfigStore(home).read();
    const { gateway_options: _gatewayOptions, ...settings } = current;
    await new Store(home.getConfigPath(), "yaml").write({
      ...settings,
      version: 1,
      model: modelId,
      fallback_model: "openrouter/unused",
    });

    const preflight = await prepareCubeRuntime({ home, fetch: googleFetch });
    const migrated = await ConfigStore(home).read();

    assert.equal(preflight.readiness.ready, true);
    assert.equal(migrated.gateway, "api_key/google");
    assert.equal("fallback_model" in migrated, false);
  });
});

test("preflight requires onboarding when gateway configuration is incomplete", async () => {
  await withHome(async (home) => {
    const preflight = await prepareCubeRuntime({ home, fetch: googleFetch });
    assert.equal(preflight.readiness.ready, false);
  });
});

test("preflight detects missing keys, unavailable models, and unreachable local gateways", async () => {
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
      const preflight = await prepareCubeRuntime({
        home,
        fetch: item.gateway === "local/ollama"
          ? async () => { throw new Error("offline"); }
          : googleFetch,
      });
      assert.equal(preflight.readiness.ready, false, item.gateway);
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
    const preflight = await prepareCubeRuntime({ home, fetch: googleFetch });
    await ConfigStore(home).update((config) => ({ ...config, model: undefined }));

    await assert.rejects(() => preflight.start(), /Choose a gateway and model/);
  });
});
