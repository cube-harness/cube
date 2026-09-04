import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { AuthStore, HomeManager } from "@cube/workspace";
import { OpenAIAuthManager } from "../../src/auth/auth-manager.js";

const cleanup = (tmp: string) =>
  rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const oldCredential = {
  access_token: "old-access",
  refresh_token: "old-refresh",
  expires_at: 100,
  account_id: "old-account",
};

test("refreshes an expired subscription and atomically stores the validated result", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cube-auth-manager-test-"));
  try {
    const home = new HomeManager({ cubeHome: tmp });
    await home.ensure();
    await writeFile(home.getAuthPath(), JSON.stringify({
      version: 1,
      api_keys: {},
      subscriptions: { openai: oldCredential },
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
    assert.deepEqual(await store.getOpenAISubscription(), current);
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
      version: 1,
      api_keys: {},
      subscriptions: { openai: oldCredential },
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
    assert.deepEqual(await store.getOpenAISubscription(), oldCredential);
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
      version: 1,
      api_keys: {},
      subscriptions: { openai: oldCredential },
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
    assert.deepEqual(await store.getOpenAISubscription(), oldCredential);
  } finally {
    await cleanup(tmp);
  }
});

test("a new login is staged until explicitly committed", async () => {
  let stored = oldCredential;
  const store = {
    getOpenAISubscription: async () => stored,
    replaceOpenAISubscription: async (credential: typeof oldCredential) => { stored = credential; },
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
  await manager.commitOpenAISubscription(candidate);
  assert.deepEqual(stored, { ...staged, access_token: candidate.access_token });
});
