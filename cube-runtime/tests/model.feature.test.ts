import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, createBootstrap, Home } from "@cube/workspace";
import { createCubeRuntime } from "../src/bootstrap.js";

test("createCubeRuntime exposes the configured initial model state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-model-feature-"));
  const home = new Home({ cubeHome: directory });
  await createBootstrap(home).run();
  await ConfigStore(home).update((config) => ({
    ...config,
    model: "google/gemini-3.7-flash",
    model_config: { reasoning_effort: "high" },
  }));
  const runtime = await createCubeRuntime({ home, workspacePath: directory });

  try {
    assert.deepEqual(runtime.model.current(), {
      modelId: "google/gemini-3.7-flash",
      reasoningEffort: "high",
    });
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
