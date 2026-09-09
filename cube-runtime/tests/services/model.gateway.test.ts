import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { Session } from "@cube/agent";
import {
  ConfigStore,
  HomeManager,
  createBootstrap,
  type ModelCatalog,
} from "@cube/workspace";
import { ModelService } from "../../src/services/model.service.js";

const catalog: ModelCatalog = {
  updatedAt: new Date(0).toISOString(),
  providers: {
    google: {
      name: "Google",
      models: [{
        modelId: "google/gemini-next",
        name: "Gemini Next",
        reasoning: true,
        reasoning_efforts: ["none", "high"],
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

const session = {
  thread: { getId: () => null },
  identity: {},
} as unknown as Session;

const setup = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-gateway-test-"));
  const home = new HomeManager({ cubeHome: directory });
  await home.ensure();
  await createBootstrap(home).run();
  await ConfigStore(home).update((config) => ({
    ...config,
    gateway: "api_key/google",
    model: "google/gemini-old",
  }));
  return { directory, home };
};

test("ModelService lists only the active gateway and never writes gateway", async () => {
  const { directory, home } = await setup();
  const applied: string[] = [];
  try {
    const service = new ModelService(
      home,
      session,
      { modelId: "google/gemini-old" },
      (selection) => { applied.push(selection.modelId); },
      { listModels: async () => catalog },
    );
    assert.equal(await service.list(), catalog);
    await service.set({ modelId: "google/gemini-next", reasoningEffort: "high" });
    const config = await ConfigStore(home).read();
    assert.equal(config.gateway, "api_key/google");
    assert.equal(config.model, "google/gemini-next");
    assert.deepEqual(applied, ["google/gemini-next"]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ModelService restores config when live model apply fails", async () => {
  const { directory, home } = await setup();
  const before = await ConfigStore(home).read();
  try {
    const service = new ModelService(
      home,
      session,
      { modelId: "google/gemini-old" },
      async (selection) => { if (selection.modelId !== "google/gemini-old") throw new Error("agent rejected model"); },
      { listModels: async () => catalog },
    );
    await assert.rejects(
      () => service.set({ modelId: "google/gemini-next" }),
      /Model switch failed; the previous model is still active/,
    );
    assert.deepEqual(await ConfigStore(home).read(), before);
    assert.deepEqual(service.current(), { modelId: "google/gemini-old" });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("ModelService adopts the model committed by a gateway transaction", async () => {
  const { directory, home } = await setup();
  try {
    const service = new ModelService(
      home,
      session,
      { modelId: "google/gemini-old" },
      () => undefined,
      { listModels: async () => catalog },
    );

    service.adopt({ modelId: "google/gemini-next", reasoningEffort: "high" });

    assert.deepEqual(service.current(), {
      modelId: "google/gemini-next",
      reasoningEffort: "high",
    });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
