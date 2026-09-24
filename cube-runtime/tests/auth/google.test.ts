import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { type CubeAuth } from "@cube/workspace";
import { beginGoogleLogin, refreshGoogleCredential, getGoogleSubscriptionUsage } from "../../src/auth/google.js";
import { GoogleAuthManager } from "../../src/auth/auth-manager.js";

test("Antigravity status uses per-model quota without inventing capacity or treating missing quota as zero", async () => {
  const credential = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000, project_id: "project" };
  let models: unknown = {
    "gemini-test": { displayName: "Gemini Test", quotaInfo: { remainingFraction: 0.64, resetTime: "2026-09-17T10:54:00Z" } },
    "gemini-empty": { quotaInfo: { remainingFraction: 0 } },
    "gemini-unknown": {},
    "gemini-internal": { isInternal: true, quotaInfo: { remainingFraction: 1 } },
  };
  let profileFails = false;
  const fetchUsage: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (String(url).endsWith(":loadCodeAssist")) return profileFails
      ? Response.json({ error: { message: "tier unavailable" } }, { status: 403 })
      : Response.json({ currentTier: { name: "Standard" }, paidTier: { name: "Google AI Pro" } });
    assert.equal(String(url), "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    assert.deepEqual(JSON.parse(String(init?.body)), { project: "project" });
    return Response.json({ models });
  };
  const result = await getGoogleSubscriptionUsage(credential, fetchUsage);
  assert.equal(result.plan, "Google AI Pro");
  assert.equal(result.limits.length, 3);
  assert.equal(result.limits[0]!.name, "Gemini Test");
  assert.deepEqual(result.limits.map(limit => limit.windows[0]!.usedPercent), [36, 100, undefined]);
  assert.equal(result.limits[0]!.windows[0]!.windowSeconds, undefined, "a reset date does not imply a fixed daily window");
  assert.equal(result.limits[0]!.windows[0]!.resetsAt, 1789642440);
  assert.equal(result.limits[0]!.windows[0]!.remaining, undefined);
  profileFails = true;
  const partial = await getGoogleSubscriptionUsage(credential, fetchUsage);
  assert.equal(partial.plan, undefined);
  assert.deepEqual(partial.limits, result.limits);
  assert.match(partial.notice!, /tier unavailable/);
  for (const quotaInfo of [{ remainingFraction: 2 }, { remainingFraction: "0.5" }, { resetTime: "bad" }, []]) {
    models = { "gemini-test": { quotaInfo } };
    const invalid = await getGoogleSubscriptionUsage(credential, fetchUsage);
    assert.deepEqual(invalid.limits, []);
    assert.match(invalid.notice!, /Invalid Antigravity/);
  }
});

test("Antigravity PKCE login waits for callback and managed project; cancellation/timeout never exchange tokens", async t => {
  for (const outcome of ["existing", "object-project", "onboard", "project-required", "ineligible", "cancel", "timeout"] as const) {
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
        assert.match(new Headers(init?.headers).get("user-agent")!, /^antigravity\/ide\//);
        if (url.endsWith(":loadCodeAssist")) {
          const metadata = JSON.parse(String(init?.body)).metadata;
          assert.equal(metadata.ideType, 9);
          assert.equal(metadata.pluginType, 2);
          assert.equal(typeof metadata.platform, "number");
          return Response.json(outcome === "existing" || outcome === "object-project"
            ? { currentTier: { id: "standard-tier" }, cloudaicompanionProject: outcome === "existing" ? "managed-project" : { id: "managed-project" } }
            : outcome === "ineligible" ? { ineligibleTiers: [{ reasonMessage: "Account is not eligible for Antigravity" }] }
            : { allowedTiers: [{ id: "legacy-tier", isDefault: true, userDefinedCloudaicompanionProject: outcome === "project-required" }] });
        }
        if (url.endsWith(":onboardUser")) {
          assert.equal(JSON.parse(String(init?.body)).tierId, "legacy-tier");
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
      assert.equal(url.searchParams.get("client_id"), "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
      assert.ok(url.searchParams.get("scope")!.includes("https://www.googleapis.com/auth/cclog"));
      assert.ok(url.searchParams.get("scope")!.includes("https://www.googleapis.com/auth/experimentsandconfigs"));
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
        if (outcome === "project-required" || outcome === "ineligible") {
          await assert.rejects(login.completion, outcome === "ineligible" ? /Account is not eligible for Antigravity/ : /Cloud project/);
          assert.equal(calls.length, 2);
        } else assert.deepEqual(await login.completion, {
          access_token: "access", refresh_token: "refresh", expires_at: 3601000, project_id: "managed-project",
        });
        assert.equal(tokenRequest!.get("code"), "code");
        assert.equal(tokenRequest!.get("client_id"), url.searchParams.get("client_id"));
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
    assert.equal(new URLSearchParams(String(init?.body)).get("client_id"), "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
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
