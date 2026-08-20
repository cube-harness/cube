import test from "node:test";
import assert from "node:assert/strict";
import { createModelCommandHandler } from "../src/commands/model.command.js";
import { Home, createBootstrap, ConfigStore } from "@cube/workspace";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-model-test-"));
  const home = new Home({ cubeHome: tmp });
  await home.ensure();
  await createBootstrap(home).run();
  return { home, tmp };
};

test("ModelCommand blocks execution when turn is active", async () => {
  const { home, tmp } = await createTestHome();
  try {
    let message = "";
    const handler = createModelCommandHandler({
      home,
      getApp: () => undefined,
      showMessage: (msg) => {
        message = msg;
      },
      isTurnActive: () => true,
    });

    await handler("");
    assert.equal(
      message,
      "Cannot open model picker while an agent turn is active.",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelCommand handles argument directly", async () => {
  const { home, tmp } = await createTestHome();
  try {
    let message = "";
    let selected = "";
    const fakeApp = {
      setInfo: (_info: any) => {},
    };
    const handler = createModelCommandHandler({
      home,
      getApp: () => fakeApp as any,
      showMessage: (msg) => {
        message = msg;
      },
      isTurnActive: () => false,
      onModelSelected: (modelId) => {
        selected = modelId;
      },
    });

    await handler("google/gemini-2.5-flash");
    assert.ok(message.includes("google/gemini-2.5-flash"));
    assert.equal(selected, "google/gemini-2.5-flash");

    const config = await ConfigStore(home).read();
    assert.equal(config.model, "google/gemini-2.5-flash");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelCommand opens model picker, persists config, and updates InfoBox", async () => {
  const { home, tmp } = await createTestHome();
  const originalKey = process.env.GOOGLE_API_KEY;
  try {
    process.env.GOOGLE_API_KEY = "test-google-key";
    let message = "";
    let openedProvidersCount = 0;
    let infoUpdatedWith = "";
    const fakeApp = {
      startLoading: (_msg?: string) => {},
      stopLoading: () => {},
      openModelPicker: async ({ providers }: { providers: any[] }) => {
        openedProvidersCount = providers.length;
        return {
          modelId: "google/gemini-2.5-flash",
          reasoningEffort: "high",
        };
      },
      setInfo: (info: any) => {
        infoUpdatedWith = info.model;
      },
    };

    const handler = createModelCommandHandler({
      home,
      getApp: () => fakeApp as any,
      showMessage: (msg) => {
        message = msg;
      },
      isTurnActive: () => false,
    });

    await handler("");
    assert.ok(openedProvidersCount > 0);
    assert.ok(message.includes("google/gemini-2.5-flash"));
    assert.ok(message.includes("high"));
    assert.ok(infoUpdatedWith.includes("google/gemini-2.5-flash"));
    assert.ok(infoUpdatedWith.includes("high"));

    const config = await ConfigStore(home).read();
    assert.equal(config.model, "google/gemini-2.5-flash");
    assert.equal(config.model_config?.reasoning_effort, "high");
  } finally {
    if (originalKey) {
      process.env.GOOGLE_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
