import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { HomeManager } from "../src/home-manager.js";
import { createBootstrap } from "../src/bootstrap.js";
import { ModelManager } from "../src/model-manager.js";
import { ConfigStore, ModelCatalogStore } from "../src/store/store.js";
import { AuthStore } from "../src/store/auth.store.js";
import type { GatewayId } from "../src/schemas/config.schema.js";

const fixture = async (t: TestContext) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-catalog-"));
  t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = new HomeManager({ cubeHome: tmp });
  await createBootstrap(home).run();
  await ModelCatalogStore(home).write({ api_key: {}, oauth: {}, local: {} });
  const auth = new AuthStore(home);
  await auth.update(current => ({ ...current, api_keys: {
    google: { api_key: "google-secret" }, openai: { api_key: "openai-secret" },
  }, oauth: { openai: {
    access_token: "access-secret", refresh_token: "refresh-secret",
    account_id: "account-secret", expires_at: Date.now() + 3600000,
  } } }));
  await ConfigStore(home).update(current => ({ ...current,
    gateway_options: { ...current.gateway_options, "local/ollama": { base_url: "http://localhost:11434" } },
  }));
  const source = async () => ({
    google: { name: "Google", models: { test: { name: "Google Test", reasoning: false, tool_call: true } } },
    openai: { name: "OpenAI", models: { test: {
      name: "OpenAI Test", reasoning: true, tool_call: false, limit: { context: 100, output: 0 },
      cost: { input: 1, output: 2, tiers: [], context_over_200k: { input: 3, output: 4 } },
      reasoning_options: [{ type: "effort", values: [null, "high"] }],
    } } },
  });
  const manager = new ModelManager(home, source);
  const key = async (gatewayId: GatewayId) => ModelManager.sourceKey(gatewayId, {
    auth: await auth.read(), config: await ConfigStore(home).read(),
  })!;
  const publish = async (gatewayId: GatewayId) => {
    const provider = gatewayId.split("/")[1]!;
    const view = await manager.preview(gatewayId, [{ modelId: `${provider}/test`, name: "test" }]);
    assert.equal(await manager.publish(gatewayId, await key(gatewayId), view), true);
    return view;
  };
  return { home, auth, source, manager, key, publish };
};

test("catalog joins exact IDs, preserves backend-only models and unknown/false/zero, without invented OAuth costs", async t => {
  const { manager, home } = await fixture(t);
  const before = await readFile(home.getModelCatalogPath(), "utf8");
  const preview = await manager.preview("oauth/openai", [
    { modelId: "openai/test", name: "test", limit: { context: 200 }, tool_call: true },
    { modelId: "openai/new-account-model", name: "New account model" },
  ]);
  const [known, unknown] = preview.providers.openai!.models;
  assert.deepEqual(known!.limit, { context: 200, output: 0 });
  assert.equal(known!.tool_call, true);
  assert.equal(known!.cost, undefined);
  assert.deepEqual(known!.reasoning_efforts, ["none", "high"]);
  assert.deepEqual(unknown, { modelId: "openai/new-account-model", name: "New account model" });
  const api = await manager.preview("api_key/openai");
  assert.equal(api.providers.openai!.models[0]!.tool_call, false);
  assert.deepEqual(api.providers.openai!.models[0]!.cost, { input: 1, output: 2 });
  const google = await manager.preview("api_key/google");
  assert.equal(google.providers.google!.models[0]!.reasoning_efforts, undefined);
  assert.equal(await readFile(home.getModelCatalogPath(), "utf8"), before, "preview must not write");
});

test("Anthropic logout prunes only its OAuth catalog, including after a manual auth.json deletion", async t => {
  const { home, auth, manager, publish } = await fixture(t);
  await auth.update(current => ({ ...current,
    api_keys: { ...current.api_keys, anthropic: { api_key: "anthropic-api" } },
    oauth: { ...current.oauth, anthropic: { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000 } },
  }));
  await publish("api_key/anthropic");
  await publish("oauth/anthropic");
  await publish("oauth/openai");
  await publish("local/ollama");
  const before = await ModelCatalogStore(home).read();
  await auth.update(current => { delete current.oauth.anthropic; return current; });
  assert.equal(await manager.getCatalog("oauth/anthropic"), undefined);
  const after = await ModelCatalogStore(home).read();
  assert.equal(after.oauth.anthropic, undefined);
  assert.deepEqual(after.api_key, before.api_key);
  assert.deepEqual(after.local, before.local);
  assert.deepEqual(after.oauth.openai, before.oauth.openai);
});

test("Google project replacement and logout prune only its OAuth catalog", async t => {
  const { home, auth, manager, key, publish } = await fixture(t);
  await auth.update(current => ({ ...current, oauth: { ...current.oauth,
    google: { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000, project_id: "first-project" },
  } }));
  await publish("api_key/google");
  await publish("oauth/google");
  await publish("oauth/openai");
  await publish("local/ollama");
  const before = await ModelCatalogStore(home).read();
  const oldKey = await key("oauth/google");
  await auth.update(current => { current.oauth.google!.project_id = "second-project"; return current; });
  assert.notEqual(await key("oauth/google"), oldKey);
  assert.equal(await manager.getCatalog("oauth/google"), undefined);
  await publish("oauth/google");
  await auth.update(current => { delete current.oauth.google; return current; });
  assert.equal(await manager.getCatalog("oauth/google"), undefined);
  const after = await ModelCatalogStore(home).read();
  assert.deepEqual(after.api_key, before.api_key);
  assert.deepEqual(after.local, before.local);
  assert.deepEqual(after.oauth.openai, before.oauth.openai);
});

test("concurrent managers merge per home; deleting one credential reconciles immediately without touching other strategies", async t => {
  const { home, auth, manager, key, publish, source } = await fixture(t);
  const other = new ModelManager(home, source);
  const localView = await manager.preview("local/ollama", [{ modelId: "ollama/test", name: "test" }]);
  await Promise.all([
    publish("api_key/google"), publish("api_key/openai"), publish("oauth/openai"),
    other.publish("local/ollama", await key("local/ollama"), localView),
  ]);
  const before = await ModelCatalogStore(home).read();
  assert.deepEqual(Object.keys(before.api_key).sort(), ["google", "openai"]);
  assert.ok(before.oauth.openai && before.local.ollama);
  await auth.update(current => { delete current.api_keys.google; return current; });
  assert.equal(await manager.getCatalog("api_key/google"), undefined);
  const after = await ModelCatalogStore(home).read();
  assert.equal(after.api_key.google, undefined);
  assert.deepEqual(after.oauth, before.oauth);
  assert.deepEqual(after.local, before.local);
  assert.deepEqual(after.api_key.openai, before.api_key.openai);
  const serialized = await readFile(home.getModelCatalogPath(), "utf8");
  for (const secret of ["google-secret", "openai-secret", "access-secret", "refresh-secret", "account-secret"]) {
    assert.ok(!serialized.includes(secret));
  }
  await auth.update(current => { delete current.oauth.openai; return current; });
  await manager.remove("oauth/openai");
  assert.equal((await ModelCatalogStore(home).read()).oauth.openai, undefined);
  assert.ok(await manager.getCatalog("api_key/openai"));
});

test("delayed discovery cannot publish after logout/account replacement, and access-only refresh keeps identity", async t => {
  const { home, auth, manager, key, publish } = await fixture(t);
  const view = await publish("oauth/openai");
  const originalKey = await key("oauth/openai");
  await auth.update(current => { current.oauth.openai!.access_token = "fresh-access"; return current; });
  assert.equal(await key("oauth/openai"), originalKey);
  assert.ok(await manager.getCatalog("oauth/openai"));
  await auth.update(current => { current.oauth.openai!.refresh_token = "rotated-refresh"; return current; });
  assert.equal(await manager.publish("oauth/openai", originalKey, view), false);
  assert.equal(await manager.getCatalog("oauth/openai"), undefined);
  assert.equal((await ModelCatalogStore(home).read()).oauth.openai, undefined);
  await auth.update(current => { delete current.oauth.openai; return current; });
  assert.equal(await manager.publish("oauth/openai", originalKey, view), false);
});

test("fresh cache checks auth first; invalid auth never wipes catalog and stale/corrupt cache is only a cache miss", async t => {
  const { home, manager, publish } = await fixture(t);
  await publish("api_key/google");
  const cached = await readFile(home.getModelCatalogPath(), "utf8");
  const validAuth = await readFile(home.getAuthPath(), "utf8");
  await writeFile(home.getAuthPath(), "{ invalid auth");
  await assert.rejects(() => manager.getCatalog("api_key/google"));
  assert.equal(await readFile(home.getModelCatalogPath(), "utf8"), cached);
  await writeFile(home.getAuthPath(), validAuth);
  const noDiscovery = new ModelManager(home, async () => { throw new Error("must not discover"); });
  assert.ok(await noDiscovery.getCatalog("api_key/google"));
  const stale = await ModelCatalogStore(home).read();
  stale.api_key.google!.updatedAt = new Date(0).toISOString();
  await ModelCatalogStore(home).write(stale);
  assert.equal(await noDiscovery.getCatalog("api_key/google"), undefined);
  await writeFile(home.getModelCatalogPath(), "{ invalid cache");
  assert.equal(await noDiscovery.getCatalog("api_key/google"), undefined);
});

test("failed atomic catalog update preserves the last valid cache", async t => {
  const { home, source, manager, key, publish } = await fixture(t);
  await publish("api_key/google");
  const before = await readFile(home.getModelCatalogPath(), "utf8");
  const failing = new ModelManager(home, source, { writeCatalog: async () => { throw new Error("disk full"); } });
  const view = await manager.preview("api_key/openai");
  const keyValue = await key("api_key/openai");
  await assert.rejects(() => failing.publish("api_key/openai", keyValue, view), /catalog could not be updated/);
  assert.equal(await readFile(home.getModelCatalogPath(), "utf8"), before);
});
