import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Bootstrap } from "../src/bootstrap.js";
import { HomeManager } from "../src/home-manager.js";
import { AuthStore } from "../src/store/auth.store.js";
import type { CubeAuth } from "../src/schemas/auth.schema.js";

test("auth updates for the same home cannot let a delayed refresh overwrite a newer account", async context => {
  const home = new HomeManager({ cubeHome: path.join(os.tmpdir(), "cube-auth-write-order") });
  let document: CubeAuth = { api_keys: {}, oauth: {} };
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const refreshStore = new AuthStore(home, async (_path, content) => {
    started();
    await barrier;
    document = JSON.parse(content);
  });
  const loginStore = new AuthStore(home, async (_path, content) => { document = JSON.parse(content); });
  // Keep the real read/mutate/write coordinator; only storage I/O is controlled.
  context.mock.method(refreshStore, "read", async () => structuredClone(document));
  context.mock.method(loginStore, "read", async () => structuredClone(document));
  const refresh = refreshStore.update(auth => ({ ...auth, oauth: { xai: {
    access_token: "refreshed-old", refresh_token: "old-refresh", expires_at: 3600000,
  } } }));
  await writing;
  const replacement = loginStore.update(auth => ({ ...auth, oauth: { xai: {
    access_token: "new-account", refresh_token: "new-refresh", expires_at: 3600000,
  } } }));
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([refresh, replacement]);
  assert.equal(document.oauth.xai?.access_token, "new-account");
  await assert.rejects(() => loginStore.update(() => { throw new Error("failed update"); }));
  await loginStore.replaceApiKey("google", "after-failure");
  assert.equal(document.api_keys.google?.api_key, "after-failure");
});

const createTestHome = async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-store-test-"));
  const home = new HomeManager({ cubeHome: tmp });
  await home.ensure();
  await writeFile(
    home.getAuthPath(),
    JSON.stringify({ api_keys: {}, oauth: {} }),
    "utf8",
  );
  return { home, tmp };
};

const cleanup = (tmp: string) =>
  rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

test("AuthStore keeps all supported provider keys separate, including Coding Plans", async () => {
  const { home, tmp } = await createTestHome();
  const providers = ["google", "openrouter", "openai", "anthropic", "groq", "xai", "mistral",
    "deepseek", "moonshotai", "nvidia", "zai", "zai-coding-plan",
    "alibaba", "alibaba-coding-plan", "huggingface"] as const;
  try {
    const auth = new AuthStore(home);
    for (const provider of providers) await auth.replaceApiKey(provider, `test-${provider}`);
    await auth.replaceApiKey("zai-coding-plan", "replacement-coding-key");
    const reloaded = new AuthStore(home);
    for (const provider of providers) {
      assert.equal(await reloaded.getApiKey(provider), provider === "zai-coding-plan"
        ? "replacement-coding-key" : `test-${provider}`);
    }
  } finally { await cleanup(tmp); }
});

test("AuthStore preserves API keys for other providers when one key is replaced", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const auth = new AuthStore(home);
    await auth.replaceApiKey("google", "google-secret-one");
    await auth.replaceApiKey("openrouter", "openrouter-secret");
    await auth.replaceApiKey("google", "google-secret-two");

    assert.equal(await auth.getApiKey("google"), "google-secret-two");
    assert.equal(await auth.getApiKey("openrouter"), "openrouter-secret");
    assert.equal(await auth.getApiKey("openai"), undefined);
  } finally {
    await cleanup(tmp);
  }
});

test("AuthStore preserves API keys while replacing the OpenAI OAuth", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const auth = new AuthStore(home);
    await auth.replaceApiKey("google", "google-secret");
    await auth.replaceOpenAIOAuth({
      access_token: "access-one",
      refresh_token: "refresh-one",
      expires_at: 100,
      account_id: "account-one",
    });
    await auth.replaceOpenAIOAuth({
      access_token: "access-two",
      refresh_token: "refresh-two",
      expires_at: 200,
      account_id: "account-two",
    });

    assert.equal(await auth.getApiKey("google"), "google-secret");
    assert.deepEqual(await auth.getOpenAIOAuth(), {
      access_token: "access-two",
      refresh_token: "refresh-two",
      expires_at: 200,
      account_id: "account-two",
    });
  } finally {
    await cleanup(tmp);
  }
});

test("AuthStore leaves the previous file intact when replacement validation fails", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const auth = new AuthStore(home);
    await auth.replaceApiKey("google", "stable-google-secret");
    const before = await readFile(home.getAuthPath(), "utf8");

    await assert.rejects(() => auth.replaceApiKey("google", ""));

    assert.equal(await readFile(home.getAuthPath(), "utf8"), before);
    assert.equal(await auth.getApiKey("google"), "stable-google-secret");
  } finally {
    await cleanup(tmp);
  }
});

test("AuthStore leaves the previous file intact when the atomic writer fails", async () => {
  const { home, tmp } = await createTestHome();
  try {
    const stable = new AuthStore(home);
    await stable.replaceApiKey("google", "stable-google-secret");
    const before = await readFile(home.getAuthPath(), "utf8");
    const failing = new AuthStore(home, async () => {
      throw new Error("simulated atomic rename failure");
    });

    await assert.rejects(
      () => failing.replaceApiKey("google", "replacement-google-secret"),
      /simulated atomic rename failure/,
    );

    assert.equal(await readFile(home.getAuthPath(), "utf8"), before);
    assert.equal(await stable.getApiKey("google"), "stable-google-secret");
  } finally {
    await cleanup(tmp);
  }
});

test("AuthStore rejects malformed files without echoing credential contents", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await writeFile(home.getAuthPath(), '{"api_key":"do-not-echo-this-secret"', "utf8");

    await assert.rejects(
      () => new AuthStore(home).read(),
      (error: unknown) => {
        assert.equal(String(error).includes("do-not-echo-this-secret"), false);
        return true;
      },
    );
  } finally {
    await cleanup(tmp);
  }
});

test("AuthStore writes restrictive permissions where the platform exposes POSIX mode bits", async () => {
  const { home, tmp } = await createTestHome();
  try {
    await new AuthStore(home).replaceApiKey("google", "google-secret");

    if (process.platform !== "win32") {
      assert.equal((await stat(home.getAuthPath())).mode & 0o777, 0o600);
    }
  } finally {
    await cleanup(tmp);
  }
});

test("Bootstrap seeds a valid empty auth store and does not load Cube-home .env", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-bootstrap-test-"));
  const home = new HomeManager({ cubeHome: tmp });
  const variable = "CUBE_AUTH_STORE_SENTINEL";
  const previous = process.env[variable];
  delete process.env[variable];
  try {
    await home.ensure();
    await writeFile(path.join(tmp, ".env"), `${variable}=must-not-load\n`, "utf8");
    await new Bootstrap(home).run();

    assert.deepEqual(await new AuthStore(home).read(), {
      api_keys: {},
      oauth: {},
    });
    assert.equal(process.env[variable], undefined);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await cleanup(tmp);
  }
});
