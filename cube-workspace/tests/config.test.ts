import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Bootstrap } from "../src/bootstrap.js";
import { HomeManager } from "../src/home-manager.js";
import { ConfigStore, WorkspaceRegistryStore } from "../src/store/store.js";
import { AuthStore } from "../src/store/auth.store.js";
import { ConfigSchema, RunnableConfigSchema, GATEWAY_IDS, GatewayIdSchema } from "../src/schemas/config.schema.js";

test("fresh home uses one unversioned schema from onboarding through persisted selection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-config-"));
  const home = new HomeManager({ cubeHome: root });
  try {
    await new Bootstrap(home).run();
    const raw = YAML.parse(await readFile(home.getConfigPath(), "utf8"));
    assert.deepEqual(ConfigSchema.parse({ ...raw, skills: undefined }).skills, { disabled: [] });
    await ConfigStore(home).update((config) => ({ ...config, skills: { disabled: ["D:/skills/review/SKILL.md"] } }));
    assert.deepEqual((await ConfigStore(home).read()).skills.disabled, ["D:/skills/review/SKILL.md"]);
    assert.equal("version" in raw, false);
    assert.equal("fallback_model" in raw, false);
    assert.equal("observational_memory" in raw.memory, false);
    assert.deepEqual(raw.memory.compaction, {
      manual_min_ratio: 0.3, keep_recent_ratio: 0.20, reserve_tokens: 16384,
    });
    assert.equal(ConfigSchema.safeParse({ ...raw, memory: { ...raw.memory, observational_memory: {} } }).success, false);
    assert.equal(ConfigSchema.safeParse(raw).success, true);
    assert.equal(RunnableConfigSchema.safeParse(raw).success, false);
    assert.deepEqual(await new AuthStore(home).read(), { api_keys: {}, oauth: {} });
    assert.deepEqual(await WorkspaceRegistryStore(home).read(), { workspaces: [] });
    for (const gateway of GATEWAY_IDS) {
      assert.equal(GatewayIdSchema.parse(gateway), gateway);
      const provider = gateway.slice(gateway.indexOf("/") + 1);
      await ConfigStore(home).update(config => ({ ...config, gateway, model: `${provider}/model` }));
      const saved = await ConfigStore(home).read();
      assert.equal(saved.gateway, gateway);
      assert.equal("version" in saved, false);
      assert.equal(RunnableConfigSchema.safeParse(saved).success, true);
    }
    assert.equal(ConfigSchema.safeParse({ ...raw, unexpected: true }).success, false);
    assert.equal(GatewayIdSchema.safeParse("oauth/anthropic").success, true);
    assert.equal(GatewayIdSchema.safeParse("api_key/unknown").success, false);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
