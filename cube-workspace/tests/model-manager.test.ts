import test from "node:test";
import assert from "node:assert/strict";
import { Home } from "../src/home.js";
import { ModelManager } from "../src/model-manager.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-model-mgr-test-"));
  const home = new Home({ cubeHome: tmp });
  await home.ensure();
  return { home, tmp };
};

test("ModelManager detects active providers from process.env and OLLAMA_BASE_URL", async () => {
  const { home, tmp } = await createTestHome();
  const originalKey = process.env.GOOGLE_API_KEY;
  const originalOllama = process.env.OLLAMA_BASE_URL;
  try {
    process.env.GOOGLE_API_KEY = "test-google-key";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    const mgr = new ModelManager(home);
    const active = await mgr.getActiveProviderIds();
    assert.ok(active.includes("google"));
    assert.ok(active.includes("ollama"));
  } finally {
    if (originalKey) {
      process.env.GOOGLE_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    if (originalOllama) {
      process.env.OLLAMA_BASE_URL = originalOllama;
    } else {
      delete process.env.OLLAMA_BASE_URL;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelManager builds catalog and groups by provider", async () => {
  const { home, tmp } = await createTestHome();
  const originalKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const mgr = new ModelManager(home);
    const catalog = await mgr.getCatalog();
    assert.ok(catalog.providers);
    assert.ok(catalog.providers.anthropic);
    assert.ok(catalog.providers.anthropic.models.length > 0);

    const providers = await mgr.getProvidersWithModels();
    assert.ok(providers.length > 0);
    const anthropicProvider = providers.find((p) => p.id === "anthropic");
    assert.ok(anthropicProvider);
    assert.ok(anthropicProvider.models.length > 0);
  } finally {
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelManager invalidates expired cache (> 24h)", async () => {
  const { home, tmp } = await createTestHome();
  const originalKey = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    const mgr = new ModelManager(home);
    const store = (await import("../src/store/store.js")).ModelCatalogStore(home);

    // Write an expired catalog (25 hours ago)
    const expiredDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await store.write({
      updatedAt: expiredDate,
      providers: {
        anthropic: {
          name: "Anthropic",
          models: [
            {
              modelId: "anthropic/old-model",
              name: "Old Model",
              reasoning: false,
              tool_call: true,
              structured_output: true,
              attachment: false,
              open_weights: false,
              limit: { context: 100000, output: 4096 },
              modalities: { input: ["text"], output: ["text"] },
            },
          ],
        },
      },
    });

    const catalog = await mgr.getCatalog();
    assert.notEqual(catalog.updatedAt, expiredDate);
  } finally {
    if (originalKey) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
