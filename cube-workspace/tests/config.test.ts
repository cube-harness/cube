import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Bootstrap } from "../src/bootstrap.js";
import { HomeManager } from "../src/home-manager.js";
import { ConfigStore, PermissionStore } from "../src/store/store.js";
import { AuthStore } from "../src/store/auth.store.js";
import { ConfigSchema, RunnableConfigSchema, GATEWAY_IDS, GatewayIdSchema } from "../src/schemas/config.schema.js";

test("missing settings use Cube defaults without inventing a model or accepting invalid overrides", () => {
  const defaults = ConfigSchema.parse({});
  assert.deepEqual(defaults.background_tasks, { enabled: true, concurrency: 2, timeout_ms: 300000 });
  assert.deepEqual(ConfigSchema.parse({ background_tasks: { enabled: false } }).background_tasks,
    { enabled: false, concurrency: 2, timeout_ms: 300000 });
  assert.equal(ConfigSchema.parse({ background_tasks: { timeout_ms: 0 } }).background_tasks.timeout_ms, 0);
  for (const background_tasks of [{ concurrency: 0 }, { concurrency: 33 }, { concurrency: 1.5 }, { timeout_ms: -1 }, { timeout_ms: 600001 }, { retries: 3 }])
    assert.equal(ConfigSchema.safeParse({ background_tasks }).success, false);
  assert.equal(defaults.gateway, undefined);
  assert.equal(defaults.model, undefined);
  assert.equal(RunnableConfigSchema.safeParse({}).success, false);
  assert.deepEqual(defaults.app_title, ["workspace", "threadId"]);
  assert.deepEqual(defaults.status_line, ["workspace", "model"]);
  assert.equal("permissions" in defaults, false);
  const runnable = RunnableConfigSchema.parse({ gateway: "api_key/google", model: "google/test" });
  assert.equal(runnable.permissions.workspace_only, true);
  assert.deepEqual(runnable.permissions.require_approval_for, ["execute_command", "edit_file", "write_file", "apply_patch"]);
  assert.equal(defaults.memory.compaction.reserve_tokens, 16384);
  const partial = ConfigSchema.parse({
    memory: { semantic_recall: { message_range: { before: 0 } }, durable: { enabled: false, min_idle_hours: 0 } } });
  assert.deepEqual(partial.memory.semantic_recall.message_range, { before: 0, after: 1 });
  assert.equal(partial.memory.durable.enabled, false);
  assert.equal(partial.memory.durable.min_idle_hours, 0);
  for (const input of [{ permissions: { workspace_only: false } }, { permissions: null }, { permissions: { workspace_only: "false" } },
    { memory: { compaction: { reserve_tokens: 0 } } }, { model_config: null }])
    assert.equal(ConfigSchema.safeParse(input).success, false);
});

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
    assert.equal("permissions" in raw, false);
    assert.equal("observational_memory" in raw.memory, false);
    assert.deepEqual(raw.memory.compaction, {
      model: "inherit", manual_min_ratio: 0.3, keep_recent_ratio: 0.20, reserve_tokens: 16384,
    });
    assert.equal(ConfigSchema.safeParse({ ...raw, memory: { ...raw.memory, observational_memory: {} } }).success, false);
    assert.equal(ConfigSchema.safeParse(raw).success, true);
    assert.equal(RunnableConfigSchema.safeParse(raw).success, false);
    assert.deepEqual(await new AuthStore(home).read(), { api_keys: {}, oauth: {}, mcp: {} });
    assert.deepEqual(await PermissionStore(home).read(), { workspaces: [] });
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

test("auxiliary defaults preserve false/zero, reject invalid values and do not rewrite YAML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cube-memory-config-"));
  const home = new HomeManager({ cubeHome: root });
  try {
    await new Bootstrap(home).run();
    const bytes = await readFile(home.getConfigPath(), "utf8");
    const raw = YAML.parse(bytes);
    const config = ConfigSchema.parse({ ...raw, memory: { ...raw.memory, durable: undefined,
      compaction: { ...raw.memory.compaction, model: undefined } } });
    assert.deepEqual(config.memory.durable, { enabled: true, model: "inherit", min_idle_hours: 6 });
    assert.equal(config.memory.compaction.model, "inherit");
    const partial = { ...raw, memory: { ...raw.memory, durable: { enabled: false, min_idle_hours: 0 } } };
    assert.deepEqual(ConfigSchema.parse(partial).memory.durable, { enabled: false, model: "inherit", min_idle_hours: 0 });
    for (const durable of [null, { model: null }, { min_idle_hours: -1 }, { enabled: "false" }])
      assert.equal(ConfigSchema.safeParse({ ...raw, memory: { ...raw.memory, durable } }).success, false);
    await ConfigStore(home).read();
    assert.equal(await readFile(home.getConfigPath(), "utf8"), bytes);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
