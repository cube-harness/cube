import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigStore, createBootstrap, Home } from "@cube/workspace";
import { PreferenceService } from "../../src/services/preference.service.js";

test("PreferenceService persists each owned field and returns defensive array copies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cube-preference-service-"));
  const home = new Home({ cubeHome: directory });
  await createBootstrap(home).run();
  const initialTitle = ["model", "workspace"];
  const initialStatusLine = ["model", "threadId"];
  const service = new PreferenceService(home, {
    theme: "default",
    appTitle: initialTitle,
    statusLine: initialStatusLine,
  });

  try {
    initialTitle.push("mutated-outside");
    initialStatusLine.push("mutated-outside");
    assert.deepEqual(service.get(), {
      theme: "default",
      appTitle: ["model", "workspace"],
      statusLine: ["model", "threadId"],
    });

    const title = ["model", "threadId"];
    const statusLine = ["workspace", "agentMd"];
    await service.setTheme("dracula");
    await service.setTitle(title);
    await service.setStatusLine(statusLine);
    title.push("mutated-after-set");
    statusLine.push("mutated-after-set");

    const first = service.get();
    first.appTitle.push("mutated-return");
    first.statusLine.push("mutated-return");
    assert.deepEqual(service.get(), {
      theme: "dracula",
      appTitle: ["model", "threadId"],
      statusLine: ["workspace", "agentMd"],
    });

    const config = await ConfigStore(home).read();
    assert.equal(config.theme, "dracula");
    assert.deepEqual(config.app_title, ["model", "threadId"]);
    assert.deepEqual(config.status_line, ["workspace", "agentMd"]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
