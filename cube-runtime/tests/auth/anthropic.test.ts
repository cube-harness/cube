import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { type CubeAuth } from "@cube/workspace";
import { beginAnthropicLogin, refreshAnthropicCredential } from "../../src/auth/anthropic.js";
import { AnthropicAuthManager } from "../../src/auth/auth-manager.js";

test("Anthropic login exchanges PKCE only after callback; cancel and timeout never complete login", async (context) => {
  for (const outcome of ["success", "cancel", "timeout"] as const) {
    let resolve!: (code: string) => void;
    let reject!: (error: Error) => void;
    let request: Record<string, string> | undefined;
    let opened = "";
    let state = "";
    let closed = false;
    const callback = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    if (outcome === "timeout") context.mock.timers.enable({ apis: ["setTimeout"] });
    const login = await beginAnthropicLogin({
      now: () => 1000,
      createCallback: async (expected, redirect) => {
        state = expected;
        assert.equal(redirect, "http://localhost:53692/callback");
        return { completion: callback, close: async () => { closed = true; reject(new Error("closed")); } };
      },
      openExternalUrl: async url => { opened = url; },
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.anthropic.com/v1/oauth/token");
        request = JSON.parse(String(init?.body));
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
      },
    });
    assert.equal(opened, login.authorizationUrl);
    assert.equal(login.expiresAt, 301000);
    assert.equal(request, undefined);
    if (outcome === "success") {
      resolve(`code#${state}`);
      assert.deepEqual(await login.completion, { access_token: "access", refresh_token: "refresh", expires_at: 3601000 });
      const body = request as unknown as Record<string, string>;
      const url = new URL(opened);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.state, url.searchParams.get("state"));
      assert.equal(body.code, "code");
      assert.equal(body.redirect_uri, url.searchParams.get("redirect_uri"));
      assert.equal(crypto.createHash("sha256").update(body.code_verifier!).digest("base64url"), url.searchParams.get("code_challenge"));
    } else {
      if (outcome === "cancel") await login.cancel();
      else context.mock.timers.tick(300000);
      await assert.rejects(login.completion, outcome === "cancel" ? /cancelled/ : /timed out/);
      assert.equal(request, undefined);
    }
    assert.equal(closed, true);
    context.mock.timers.reset();
  }
});

test("Anthropic refresh is shared, persisted, and cannot resurrect logout; rejected refresh preserves credentials", async () => {
  const expired = { access_token: "old", refresh_token: "refresh", expires_at: 0 };
  let auth: CubeAuth = { api_keys: { anthropic: { api_key: "independent-api-key" } }, oauth: { anthropic: expired } };
  let calls = 0;
  let release!: () => void;
  let mode: "success" | "logout" | "rejected" = "success";
  const manager = new AnthropicAuthManager({
    read: async () => structuredClone(auth),
    update: async mutator => (auth = mutator(auth)),
  }, { now: () => 1000, fetch: async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).grant_type, "refresh_token");
    if (mode === "logout") await new Promise<void>(resolve => { release = resolve; });
    if (mode === "rejected") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
  } });
  const [a, b] = await Promise.all([manager.getValidCredential(), manager.getValidCredential()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(auth.oauth.anthropic, a);
  await manager.getValidCredential();
  assert.equal(calls, 1);
  auth.oauth.anthropic = expired;
  mode = "rejected";
  await assert.rejects(manager.getValidCredential(), /HTTP 400: invalid_grant/);
  assert.deepEqual(auth.oauth.anthropic, expired);
  mode = "logout";
  const pending = manager.getValidCredential();
  await new Promise(resolve => setImmediate(resolve));
  delete auth.oauth.anthropic;
  release();
  await assert.rejects(pending, /credential changed/);
  assert.equal(auth.oauth.anthropic, undefined);
  assert.equal(auth.api_keys.anthropic?.api_key, "independent-api-key");
  await assert.rejects(refreshAnthropicCredential(expired, {
    fetch: async () => Response.json({ access_token: "bad", refresh_token: "bad", expires_in: -1 }),
  }), /invalid token expiry/);
});
