import test from "node:test";
import assert from "node:assert/strict";
import { createModelCommandHandler } from "../src/commands/model.command.js";
import { ActionDispatcher } from "../src/dispatcher.js";
import { Home, createBootstrap, ConfigStore } from "@cube/workspace";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import type { CubeEvent } from "../src/contracts/events.contract.js";

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
    const dispatcher = new ActionDispatcher();
    const emittedEvents: CubeEvent[] = [];
    dispatcher.subscribe((e) => emittedEvents.push(e));

    const handler = createModelCommandHandler({
      home,
      dispatcher,
      isTurnActive: () => true,
    });

    await handler("");
    const sysMsg = emittedEvents.find((e) => e.type === "system:message") as any;
    assert.equal(
      sysMsg?.content,
      "Cannot open model picker while an agent turn is active.",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelCommand handles argument directly", async () => {
  const { home, tmp } = await createTestHome();
  try {
    let selected = "";
    const dispatcher = new ActionDispatcher();
    const emittedEvents: CubeEvent[] = [];
    dispatcher.subscribe((e) => emittedEvents.push(e));

    const handler = createModelCommandHandler({
      home,
      dispatcher,
      isTurnActive: () => false,
      onModelSelected: (modelId) => {
        selected = modelId;
      },
    });

    await handler("google/gemini-2.5-flash");
    const sysMsg = emittedEvents.find((e) => e.type === "system:message") as any;
    assert.ok(sysMsg?.content?.includes("google/gemini-2.5-flash"));
    assert.equal(selected, "google/gemini-2.5-flash");

    const config = await ConfigStore(home).read();
    assert.equal(config.model, "google/gemini-2.5-flash");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ModelCommand emits dialog:model_picker event", async () => {
  const { home, tmp } = await createTestHome();
  const originalKey = process.env.GOOGLE_API_KEY;
  try {
    process.env.GOOGLE_API_KEY = "test-google-key";
    const dispatcher = new ActionDispatcher();
    const emittedEvents: CubeEvent[] = [];
    dispatcher.subscribe((e) => emittedEvents.push(e));

    const handler = createModelCommandHandler({
      home,
      dispatcher,
      isTurnActive: () => false,
    });

    await handler("");
    const dialogEvent = emittedEvents.find(
      (e) => e.type === "dialog:model_picker",
    ) as any;
    assert.ok(dialogEvent);
    assert.ok(dialogEvent.providers.length > 0);
  } finally {
    if (originalKey) {
      process.env.GOOGLE_API_KEY = originalKey;
    } else {
      delete process.env.GOOGLE_API_KEY;
    }
    await rm(tmp, { recursive: true, force: true });
  }
});
