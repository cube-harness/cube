import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { HomeManager } from "../src/home-manager.js";
import { ModelManager } from "../src/model-manager.js";
import { ModelCatalogStore } from "../src/store/store.js";

const cleanup = (tmp: string) =>
  rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const providerFixtures = {
  google: {
    name: "Google",
    models: {
      "gemini-test": {
        name: "Gemini Test",
        reasoning: true,
        tool_call: true,
        structured_output: true,
        attachment: true,
        open_weights: false,
        limit: { context: 1_000_000, output: 8_192 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
  openrouter: {
    name: "OpenRouter",
    models: {
      "vendor/model-test": {
        name: "Router Test",
        reasoning: false,
        tool_call: true,
        structured_output: true,
        attachment: false,
        open_weights: false,
        limit: { context: 128_000, output: 4_096 },
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-model-manager-test-"));
  const home = new HomeManager({ cubeHome: tmp });
  await home.ensure();
  return { home, tmp };
};

test("ModelManager builds a credential-agnostic canonical provider catalog", async () => {
  const { home, tmp } = await createTestHome();
  const previousGoogle = process.env.GOOGLE_API_KEY;
  const previousOpenRouter = process.env.OPENROUTER_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const manager = new ModelManager(home, async () => providerFixtures);
    const catalog = await manager.refreshCatalog();

    assert.equal(catalog.version, 2);
    assert.deepEqual(Object.keys(catalog.providers).sort(), ["google", "openrouter"]);
    assert.equal(catalog.providers.google?.models[0]?.modelId, "google/gemini-test");
    assert.equal(
      catalog.providers.openrouter?.models[0]?.modelId,
      "openrouter/vendor/model-test",
    );
  } finally {
    if (previousGoogle === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogle;
    if (previousOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouter;
    await cleanup(tmp);
  }
});

test("ModelManager returns a fresh version-2 cache without consulting the source", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const cached = {
      version: 2 as const,
      updatedAt: new Date().toISOString(),
      providers: {},
    };
    await ModelCatalogStore(home).write(cached);
    let sourceCalls = 0;
    const manager = new ModelManager(home, async () => {
      sourceCalls += 1;
      return providerFixtures;
    });

    assert.deepEqual(await manager.getCatalog(), cached);
    assert.equal(sourceCalls, 0);
  } finally {
    await cleanup(tmp);
  }
});

test("ModelManager rebuilds stale or schema-incompatible cache files", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await writeFile(
      home.getModelCatalogPath(),
      JSON.stringify({ updatedAt: new Date().toISOString(), providers: {} }),
      "utf8",
    );
    let sourceCalls = 0;
    const manager = new ModelManager(home, async () => {
      sourceCalls += 1;
      return providerFixtures;
    });

    const rebuilt = await manager.getCatalog();
    assert.equal(rebuilt.version, 2);
    assert.equal(sourceCalls, 1);

    await ModelCatalogStore(home).write({
      version: 2,
      updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString(),
      providers: {},
    });
    await manager.getCatalog();
    assert.equal(sourceCalls, 2);
  } finally {
    await cleanup(tmp);
  }
});
