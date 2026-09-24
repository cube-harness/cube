import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { type CubeAuth } from "@cube/workspace";
import { beginAnthropicLogin, refreshAnthropicCredential, getAnthropicSubscriptionUsage } from "../../src/auth/anthropic.js";
import { AnthropicAuthManager } from "../../src/auth/auth-manager.js";

test("Anthropic status preserves real plan/windows and reports partial failures without inventing quota", async () => {
  const credential = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
  let payload: unknown = { five_hour: { utilization: 36, resets_at: "2026-09-17T10:54:00Z" },
    seven_day: { utilization: 0 }, seven_day_sonnet: null,
    limits: [{ kind: "weekly_scoped", percent: 100, scope: { model: { display_name: "Opus" } } }],
  };
  let profileFails = false;
  const fetchUsage: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
    assert.match(new Headers(init?.headers).get("anthropic-beta")!, /oauth-2025-04-20/);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (String(url).endsWith("/profile")) return profileFails
      ? Response.json({ error: { message: "profile unavailable" } }, { status: 403 })
      : Response.json({ organization: { organization_type: "claude_max" } });
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage");
    return Response.json(payload);
  };
  const result = await getAnthropicSubscriptionUsage(credential, fetchUsage);
  assert.equal(result.plan, "max");
  assert.equal(result.notice, undefined);
  assert.deepEqual(result.limits.map(limit => limit.name), ["Claude", "Opus"]);
  assert.deepEqual(result.limits[0]!.windows.map(window => window.usedPercent), [36, 0]);
  assert.equal(result.limits[0]!.windows[0]!.resetsAt, Date.parse("2026-09-17T10:54:00Z") / 1000);
  assert.equal(result.limits[1]!.windows[0]!.usedPercent, 100);
  profileFails = true;
  const partial = await getAnthropicSubscriptionUsage(credential, fetchUsage);
  assert.equal(partial.plan, undefined);
  assert.deepEqual(partial.limits, result.limits);
  assert.match(partial.notice!, /403.*profile unavailable/);
  profileFails = false;
  for (payload of [{ five_hour: { utilization: "36" } }, { five_hour: { resets_at: "bad" } }, []]) {
    const invalid = await getAnthropicSubscriptionUsage(credential, fetchUsage);
    assert.equal(invalid.plan, "max");
    assert.deepEqual(invalid.limits, []);
    assert.match(invalid.notice!, /Invalid Anthropic/);
  }
  payload = {};
  assert.deepEqual((await getAnthropicSubscriptionUsage(credential, fetchUsage)).limits, []);
});

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
