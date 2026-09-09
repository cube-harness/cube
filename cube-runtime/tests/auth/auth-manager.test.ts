import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { AuthStore, HomeManager, createBootstrap, type CubeAuth } from "@cube/workspace";
import { OpenAIAuthManager } from "../../src/auth/auth-manager.js";

const cleanup = (tmp: string) =>
  rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const oldCredential = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_at: 100,
  account_id: "old-account",
};

test("concurrent auth requests share one refresh and observe stored account replacement", async () => {
  let stored = oldCredential;
  let refreshes = 0;
  const manager = new OpenAIAuthManager({
    read: async () => ({ api_keys: {}, oauth: { openai: stored } }),
    update: async mutator => {
      const next = mutator({ api_keys: {}, oauth: { openai: stored } });
      stored = next.oauth.openai!;
      return next;
    },
  }, {
    now: () => 1_000,
    fetch: async () => {
      refreshes++;
      await new Promise((resolve) => setImmediate(resolve));
      return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 });
    },
  });
  const results = await Promise.all([manager.getValidCredential(), manager.getValidCredential()]);
  assert.equal(refreshes, 1);
  assert.deepEqual(results[0], results[1]);
  stored = { ...stored, account_id: "replacement", access_token: "replacement-access" };
  assert.equal((await manager.getValidCredential()).account_id, "replacement");
});

test("refreshes an expired oauth and atomically stores the validated result", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-manager-test-"));
  try {
    const home = new HomeManager({ cubeHome: tmp });
    await home.ensure();
    await writeFile(home.getAuthPath(), JSON.stringify({
      api_keys: {},
      oauth: { openai: oldCredential },
    }));
    const store = new AuthStore(home);
    const manager = new OpenAIAuthManager(store, {
      now: () => 1_000,
      fetch: async () => new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    const current = await manager.getValidCredential();
    assert.deepEqual(current, {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: 3_601_000,
      account_id: "old-account",
    });
    assert.deepEqual(await store.getOpenAIOAuth(), current);
  } finally {
    await cleanup(tmp);
  }
});

test("keeps the previous credential when refresh fails validation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-manager-test-"));
  try {
    const home = new HomeManager({ cubeHome: tmp });
    await home.ensure();
    await writeFile(home.getAuthPath(), JSON.stringify({
      api_keys: {},
      oauth: { openai: oldCredential },
    }));
    const store = new AuthStore(home);
    const manager = new OpenAIAuthManager(store, {
      now: () => 1_000,
      fetch: async () => new Response(JSON.stringify({ expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await assert.rejects(
      () => manager.getValidCredential(),
      /OpenAI session could not be refreshed\. Sign in again with \/gateway\./,
    );
    assert.deepEqual(await store.getOpenAIOAuth(), oldCredential);
  } finally {
    await cleanup(tmp);
  }
});

test("rejects an account change during refresh and preserves the signed-in account", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-manager-test-"));
  try {
    const home = new HomeManager({ cubeHome: tmp });
    await home.ensure();
    await writeFile(home.getAuthPath(), JSON.stringify({
      api_keys: {},
      oauth: { openai: oldCredential },
    }));
    const store = new AuthStore(home);
    const differentAccountToken = [
      Buffer.from("{}").toString("base64url"),
      Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "different-account" },
      })).toString("base64url"),
      "sig",
    ].join(".");
    const manager = new OpenAIAuthManager(store, {
      now: () => 1_000,
      fetch: async () => new Response(JSON.stringify({
        access_token: differentAccountToken,
        refresh_token: "new-refresh",
        expires_in: 3600,
      }), { status: 200 }),
    });

    await assert.rejects(
      () => manager.getValidCredential(),
      /OpenAI session could not be refreshed/,
    );
    assert.deepEqual(await store.getOpenAIOAuth(), oldCredential);
  } finally {
    await cleanup(tmp);
  }
});

test("a new login is staged until explicitly committed", async () => {
  let stored = oldCredential;
  const store = {
    read: async () => ({ api_keys: {}, oauth: { openai: stored } }),
    update: async (mutator: (auth: CubeAuth) => CubeAuth) => {
      const next = mutator({ api_keys: {}, oauth: { openai: stored } });
      stored = next.oauth.openai!;
      return next;
    },
  };
  let resolveCode!: (code: string) => void;
  const callback = new Promise<string>((resolve) => { resolveCode = resolve; });
  const manager = new OpenAIAuthManager(store, {
    now: () => 1_000,
    randomBytes: (size) => Buffer.alloc(size, 4),
    openExternalUrl: async () => undefined,
    createCallback: async () => ({ completion: callback, close: async () => undefined }),
    fetch: async () => new Response(JSON.stringify({
      access_token: [
        Buffer.from("{}").toString("base64url"),
        Buffer.from(JSON.stringify({
          exp: 4_000,
          "https://api.openai.com/auth": { chatgpt_account_id: "staged-account" },
        })).toString("base64url"),
        "sig",
      ].join("."),
      refresh_token: "staged-refresh",
    }), { status: 200 }),
  });
  const staged = {
    access_token: "unused",
    refresh_token: "staged-refresh",
    expires_at: 4_000_000,
    account_id: "staged-account",
  };

  const login = await manager.beginLogin();
  resolveCode("authorization-code");
  const candidate = await login.completion;
  assert.deepEqual(stored, oldCredential);
  await manager.commitOpenAIOAuth(candidate);
  assert.deepEqual(stored, { ...staged, access_token: candidate.access_token });
});

test("refresh completing after logout or account replacement never rewrites auth", async t => {
  for (const replacement of [undefined, { ...oldCredential, access_token: "replacement", refresh_token: "replacement-refresh" }]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-refresh-race-"));
    t.after(() => cleanup(tmp));
    const home = new HomeManager({ cubeHome: tmp });
    await createBootstrap(home).run();
    const store = new AuthStore(home);
    await store.replaceOpenAIOAuth(oldCredential);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const manager = new OpenAIAuthManager(store, { now: () => 1000, fetch: async () => {
      started(); await gate;
      return Response.json({ access_token: "stale-result", refresh_token: "stale-refresh", expires_in: 3600 });
    } });
    const pending = manager.getValidCredential();
    const rejected = assert.rejects(pending, /credential changed/);
    await waiting;
    await store.update(auth => {
      if (replacement) auth.oauth.openai = replacement; else delete auth.oauth.openai;
      return auth;
    });
    release();
    await rejected;
    assert.deepEqual((await store.read()).oauth.openai, replacement);
  }
});
