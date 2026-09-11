import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { type CubeAuth } from "@cube/workspace";
import { beginGoogleLogin, refreshGoogleCredential } from "../../src/auth/google.js";
import { GoogleAuthManager } from "../../src/auth/auth-manager.js";

test("Google PKCE login waits for callback and managed project; cancellation/timeout never exchange tokens", async t => {
  for (const outcome of ["existing", "onboard", "project-required", "cancel", "timeout"] as const) {
    let resolve!: (code: string) => void;
    let reject!: (error: Error) => void;
    let opened = "";
    let closed = false;
    let tokenRequest: URLSearchParams | undefined;
    const calls: string[] = [];
    const callback = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    if (outcome === "timeout" || outcome === "onboard") t.mock.timers.enable({ apis: ["setTimeout"] });
    const login = await beginGoogleLogin({
      now: () => 1000,
      createCallback: async (state, redirect) => {
        assert.ok(state);
        assert.equal(redirect, "http://127.0.0.1:45289/oauth2callback");
        return { completion: callback, close: async () => { closed = true; reject(new Error("closed")); } };
      },
      openExternalUrl: async url => { opened = url; },
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://oauth2.googleapis.com/token") {
          tokenRequest = new URLSearchParams(String(init?.body));
          return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
        }
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
        if (url.endsWith(":loadCodeAssist")) return Response.json(outcome === "existing"
          ? { currentTier: { id: "standard-tier" }, cloudaicompanionProject: "managed-project" }
          : { allowedTiers: [{ id: outcome === "onboard" ? "free-tier" : "standard-tier", isDefault: true }] });
        if (url.endsWith(":onboardUser")) {
          assert.deepEqual(JSON.parse(String(init?.body)), { tierId: "free-tier", metadata: {
            ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI",
          } });
          return Response.json({ name: "operations/setup-1", done: false });
        }
        assert.ok(url.endsWith("/operations/setup-1"));
        return Response.json({ done: true, response: { cloudaicompanionProject: { id: "managed-project" } } });
      },
    });
    try {
      assert.equal(opened, login.authorizationUrl);
      assert.equal(login.expiresAt, 301000);
      assert.equal(calls.length, 0);
      const url = new URL(opened);
      assert.equal(url.searchParams.get("client_id"), "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com");
      assert.equal(url.searchParams.get("access_type"), "offline");
      assert.match(url.searchParams.get("prompt")!, /select_account/);
      if (outcome === "cancel" || outcome === "timeout") {
        if (outcome === "cancel") await login.cancel();
        else t.mock.timers.tick(300000);
        await assert.rejects(login.completion, outcome === "cancel" ? /cancelled/ : /timed out/);
        assert.equal(calls.length, 0);
      } else {
        resolve("code");
        if (outcome === "onboard") {
          await new Promise(yes => setImmediate(yes));
          t.mock.timers.tick(5000);
        }
        if (outcome === "project-required") {
          await assert.rejects(login.completion, /Cloud project/);
          assert.equal(calls.length, 2);
        } else assert.deepEqual(await login.completion, {
          access_token: "access", refresh_token: "refresh", expires_at: 3601000, project_id: "managed-project",
        });
        assert.equal(tokenRequest!.get("code"), "code");
        assert.equal(tokenRequest!.get("redirect_uri"), url.searchParams.get("redirect_uri"));
        assert.equal(crypto.createHash("sha256").update(tokenRequest!.get("code_verifier")!).digest("base64url"), url.searchParams.get("code_challenge"));
      }
      assert.equal(closed, true);
    } finally { await login.cancel(); t.mock.timers.reset(); }
  }
});

test("Google refresh preserves project/token, coalesces requests and cannot resurrect a logged-out account", async () => {
  const expired = { access_token: "old", refresh_token: "refresh", expires_at: 0, project_id: "project" };
  let auth: CubeAuth = { api_keys: { google: { api_key: "independent-api-key" } }, oauth: { google: expired } };
  let calls = 0;
  let release!: () => void;
  let mode: "success" | "logout" | "rejected" = "success";
  const manager = new GoogleAuthManager({
    read: async () => structuredClone(auth), update: async mutate => (auth = mutate(auth)),
  }, { now: () => 1000, fetch: async (_url, init) => {
    calls++;
    assert.equal(new URLSearchParams(String(init?.body)).get("grant_type"), "refresh_token");
    if (mode === "logout") await new Promise<void>(resolve => { release = resolve; });
    if (mode === "rejected") return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "new", expires_in: 3600 });
  } });
  const [a, b] = await Promise.all([manager.getValidCredential(), manager.getValidCredential()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(auth.oauth.google, { ...expired, access_token: "new", expires_at: 3601000 });
  await manager.getValidCredential();
  assert.equal(calls, 1);
  auth.oauth.google = expired;
  mode = "rejected";
  await assert.rejects(manager.getValidCredential(), /HTTP 400: invalid_grant/);
  assert.deepEqual(auth.oauth.google, expired);
  mode = "logout";
  const pending = manager.getValidCredential();
  await new Promise(resolve => setImmediate(resolve));
  delete auth.oauth.google;
  release();
  await assert.rejects(pending, /credential changed/);
  assert.equal(auth.oauth.google, undefined);
  assert.equal(auth.api_keys.google?.api_key, "independent-api-key");
  await assert.rejects(refreshGoogleCredential(expired, {
    fetch: async () => Response.json({ access_token: "bad", expires_in: -1 }),
  }), /invalid token expiry/);
});
