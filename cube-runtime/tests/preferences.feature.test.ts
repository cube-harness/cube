import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, createBootstrap, Home } from "@cube/workspace";
import { createCubeRuntime } from "../src/bootstrap.js";

test("runtime preference APIs persist and expose their current values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-preferences-feature-"));
  const home = new Home({ cubeHome: directory });
  await createBootstrap(home).run();
  const runtime = await createCubeRuntime({ home, workspacePath: directory });

  try {
    await runtime.preference.setTheme("dracula");
    await runtime.preference.setTitle(["model", "threadId"]);
    await runtime.preference.setStatusLine(["workspace", "agentMd"]);

    const config = await ConfigStore(home).read();
    assert.equal(config.theme, "dracula");
    assert.deepEqual(config.app_title, ["model", "threadId"]);
    assert.deepEqual(config.status_line, ["workspace", "agentMd"]);
    assert.deepEqual(runtime.preference.get(), {
      theme: "dracula",
      appTitle: ["model", "threadId"],
      statusLine: ["workspace", "agentMd"],
    });
  } finally {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
