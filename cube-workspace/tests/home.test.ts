import assert from "node:assert/strict";
import test from "node:test";
import {
  Home,
  CubeHome,
  createBootstrap,
  ConfigSchema,
  ConfigStore,
  SoulStore,
  HistoryStore,
} from "../src/index.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-home-test-"));
  const home = new Home({ cubeHome: tmp });
  await home.ensure();
  return { home, tmp };
};

test("Home resolves correct directory paths", async () => {
  const { home, tmp } = await createTestHome();
  try {
    assert.equal(home.getRoot(), path.resolve(tmp));
    assert.equal(home.getMemoryDir(), path.join(path.resolve(tmp), "memories"));
    assert.equal(home.getLogDir(), path.join(path.resolve(tmp), "logs"));
    assert.equal(home.getConfigPath(), path.join(path.resolve(tmp), "config.yaml"));
    assert.equal(home.getSoulPath(), path.join(path.resolve(tmp), "SOUL.md"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Bootstrap seeds all template files into new home", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const bootstrap = createBootstrap(home);
    await bootstrap.run();

    assert.ok(existsSync(home.getConfigPath()));
    assert.ok(existsSync(home.getSoulPath()));
    assert.ok(existsSync(home.getAuthPath()));
    assert.ok(existsSync(home.getMcpPath()));
    assert.ok(existsSync(home.getWorkspacePath()));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ConfigStore and SoulStore can read seeded config", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();

    const config = await ConfigStore(home).read();
    assert.equal(config.version, 2);
    assert.equal(config.gateway, undefined);
    assert.equal(config.model, undefined);
    assert.equal(config.gateway_options["local/ollama"]?.base_url, "http://127.0.0.1:11434");
    assert.equal(config.gateway_options["local/lmstudio"]?.base_url, "http://127.0.0.1:1234/v1");
    assert.deepEqual(config.memory.storage, {
      provider: "sqlite",
      mode: "local",
    });
    assert.deepEqual(config.memory.vector, {
      enabled: false,
      provider: "sqlite",
      mode: "local",
    });
    assert.deepEqual(config.memory.embedder, {
      enabled: false,
      model: null,
    });
    assert.equal("read_only" in config.memory, false);
    assert.equal("last_messages" in config.memory, false);
    assert.equal("filter_incomplete_tool_calls" in config.memory, false);
    assert.deepEqual(config.memory.generate_title, {
      enabled: false,
      model: "inherit",
      instructions: "Generate a concise title under 80 characters.",
    });
    assert.deepEqual(config.memory.observational_memory.retrieval, {
      enabled: true,
      vector: false,
      scope: "thread",
    });
    assert.equal(
      config.memory.observational_memory.activate_on_provider_change,
      true,
    );
    assert.equal(
      config.memory.observational_memory.observation.buffer_on_idle,
      false,
    );
    assert.equal(config.memory.working_memory.scope, "thread");
    assert.equal("version" in config.memory.working_memory, false);
    assert.equal("schema" in config.memory.working_memory, false);
    assert.equal(config.memory.observational_memory.observation.model, "inherit");
    assert.equal("model_settings" in config.memory.observational_memory.observation, false);
    assert.equal("provider_options" in config.memory.observational_memory.observation, false);
    assert.equal("max_tokens_per_batch" in config.memory.observational_memory.observation, false);
    assert.equal("activate_after_idle" in config.memory.observational_memory.observation, false);
    assert.equal("activate_on_provider_change" in config.memory.observational_memory.observation, false);
    assert.equal(
      config.memory.observational_memory.observation.thread_title,
      false,
    );
    assert.equal("extract" in config.memory.observational_memory.observation, false);
    assert.equal(config.memory.observational_memory.reflection.model, "inherit");
    assert.equal("model_settings" in config.memory.observational_memory.reflection, false);
    assert.equal("provider_options" in config.memory.observational_memory.reflection, false);
    assert.equal("activate_after_idle" in config.memory.observational_memory.reflection, false);
    assert.equal("activate_on_provider_change" in config.memory.observational_memory.reflection, false);
    assert.equal("extract" in config.memory.observational_memory.reflection, false);

    const soul = await SoulStore(home).read();
    assert.ok(soul.length > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ConfigSchema rejects enabled Working Memory without an update owner", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();
    const config = structuredClone(await ConfigStore(home).read()) as any;
    config.memory.working_memory.agent_managed = false;
    config.memory.observational_memory.observation.manage_working_memory = false;

    const result = ConfigSchema.safeParse(config);

    assert.equal(result.success, false);
    assert.match(
      result.error?.issues[0]?.message ?? "",
      /Working Memory is enabled but has no manager/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("ConfigSchema keeps code-owned Memory options out of public YAML", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();
    const config = structuredClone(await ConfigStore(home).read()) as any;
    config.memory.read_only = true;

    const result = ConfigSchema.safeParse(config);

    assert.equal(result.success, false);
    assert.match(result.error?.issues[0]?.message ?? "", /Unrecognized key/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("HistoryStore can append and read history entries", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();
    const historyStore = HistoryStore(home);

    const initial = await historyStore.read();
    assert.deepEqual(initial, []);

    const now = Date.now();
    await historyStore.append({ text: "git status", timestamp: now, threadId: "thread-1" });
    await historyStore.append({ text: "pnpm test", timestamp: now + 1000 });

    const entries = await historyStore.read();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.text, "git status");
    assert.equal(entries[0]?.timestamp, now);
    assert.equal(entries[0]?.threadId, "thread-1");
    assert.equal(entries[1]?.text, "pnpm test");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("SoulStore validates character limits on read, write, and direct validation", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await createBootstrap(home).run();
    const soulStore = SoulStore(home);
    const maxChars = home.getSoulMaxCharacters();

    // Valid write & read
    const validContent = "A".repeat(100);
    await soulStore.write(validContent);
    const readBack = await soulStore.read();
    assert.equal(readBack, validContent);

    // Direct validateCharacters
    assert.doesNotThrow(() => soulStore.validateCharacters("Short soul"));
    assert.throws(
      () => soulStore.validateCharacters("X".repeat(maxChars + 1)),
      /exceeds max length/,
    );

    // Invalid write throws
    await assert.rejects(
      async () => soulStore.write("X".repeat(maxChars + 1)),
      /exceeds max length/,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
