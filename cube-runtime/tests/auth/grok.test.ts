import assert from "node:assert/strict";
import test from "node:test";
import * as authManagers from "../../src/auth/auth-manager.js";
import { toRuntimeNotice } from "../../src/types.js";
import { getGrokSubscriptionUsage } from "../../src/auth/grok.js";

test("xAI status keeps subscription, spending cap and balance separate; malformed/failed reads retain available data", async () => {
  const credential = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
  let config: object = { monthlyLimit: { val: 200 }, includedUsed: { val: 50 },
    onDemandCap: { val: 100 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 25 },
    creditUsagePercent: 36, currentPeriod: { end: "2026-09-17T10:54:00Z" },
  };
  let profileFails = false;
  const fetchUsage: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (String(url).endsWith("/user?include=subscription")) return profileFails
      ? Response.json({ message: "profile unavailable" }, { status: 403 })
      : Response.json({ subscriptionTier: "SUPER_GROK" });
    assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    return Response.json({ config });
  };
  const result = await getGrokSubscriptionUsage(credential, fetchUsage);
  assert.equal(result.plan, "SUPER_GROK");
  assert.deepEqual(result.limits.map(limit => limit.name), ["Monthly included", "On-demand", "Grok Build", "Prepaid balance"]);
  assert.deepEqual(result.limits.map(limit => limit.windows[0]!.usedPercent), [25, 0, 36, undefined]);
  assert.equal(result.limits[3]!.windows[0]!.remaining, 25);
  profileFails = true;
  const partial = await getGrokSubscriptionUsage(credential, fetchUsage);
  assert.equal(partial.plan, undefined);
  assert.deepEqual(partial.limits, result.limits);
  assert.match(partial.notice!, /403.*profile unavailable/);
  profileFails = false;
  for (config of [{ onDemandCap: { val: "bad" } }, { currentPeriod: { end: "bad" } }, []]) {
    const invalid = await getGrokSubscriptionUsage(credential, fetchUsage);
    assert.equal(invalid.plan, "SUPER_GROK");
    assert.deepEqual(invalid.limits, []);
    assert.match(invalid.notice!, /Invalid xAI/);
  }
});

test("xAI weekly gRPC quota validates framing/trailers and never treats zero spending cap as unlimited", async () => {
  const frame = (flag: number, bytes: Buffer) => {
    const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
  };
  const ratio = Buffer.alloc(4); ratio.writeFloatLE(0.36);
  const timestamp = Buffer.from([8, 128, 164, 167, 218, 6]); // seconds = 1800000000
  const info = Buffer.concat([Buffer.from([13]), ratio, Buffer.from([42, timestamp.length]), timestamp]);
  let wire = frame(0, Buffer.concat([Buffer.from([10, info.length]), info]));
  const credential = { access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600000 };
  const fetchUsage: typeof fetch = async (url, init) => {
    if (String(url).includes("/user?")) return Response.json({ subscription: { tier: "SuperGrok" } });
    if (String(url).includes("/billing?")) return Response.json({ config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 0 } } });
    assert.equal(String(url), "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig");
    assert.equal(init?.method, "POST");
    assert.deepEqual(init?.body, new Uint8Array(5));
    return new Response(wire, { headers: { "content-type": "application/grpc-web+proto" } });
  };
  const result = await getGrokSubscriptionUsage(credential, fetchUsage);
  assert.equal(result.limits[0]!.windows[0]!.usedPercent, 36);
  assert.equal(result.limits[0]!.windows[0]!.resetsAt, 1800000000);
  assert.equal(result.limits[1]!.windows[0]!.usedPercent, undefined);
  assert.equal(result.limits[1]!.windows[0]!.remaining, 0);
  const valid = wire;
  for (wire of [Buffer.from([0, 0]), frame(1, info), Buffer.concat([valid, frame(128, Buffer.from("grpc-status: 7\r\n"))])]) {
    const invalid = await getGrokSubscriptionUsage(credential, fetchUsage);
    assert.equal(invalid.plan, "SuperGrok");
    assert.deepEqual(invalid.limits.map(limit => limit.name), ["On-demand"]);
    assert.match(invalid.notice!, /Invalid xAI|gRPC 7/);
  }
  wire = frame(0, Buffer.from([10, 0])); // proto3 scalar default inside an actual credits envelope
  assert.equal((await getGrokSubscriptionUsage(credential, fetchUsage)).limits[0]!.windows[0]!.usedPercent, 0);
});

// The real device endpoint returns accounts.x.ai, not the token endpoint's auth.x.ai host.
const device = { device_code: "private-device", user_code: "ABCD-EFGH", verification_uri: "https://accounts.x.ai/activate", verification_uri_complete: "https://accounts.x.ai/activate?user_code=ABCD-EFGH", expires_in: 60, interval: 1 };

test("Grok spending-limit failures retain the provider error without credentials", () => {
  const notice = toRuntimeNotice(new Error("HTTP 402 personal-team-blocked:spending-limit access_token=secret-response"));
  assert.match(notice.message, /HTTP 402 personal-team-blocked:spending-limit/);
  assert.doesNotMatch(notice.message, /secret-response/);
});

test("Grok device login opens the displayed URL and stages tokens without writing auth", async () => {
  assert.equal(typeof authManagers.GrokAuthManager, "function");
  let writes = 0;
  let opened = "";
  const manager = new authManagers.GrokAuthManager({
    read: async () => ({ api_keys: {}, oauth: {} }),
    update: async () => { writes++; throw new Error("login must remain staged"); },
  }, {
    openExternalUrl: async url => { opened = url; },
    fetch: async (input, init) => {
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
      if (String(input).endsWith("/device/code")) {
        assert.ok(body.get("scope")?.includes("grok-cli:access"));
        assert.equal(body.get("referrer"), "grok-build");
        return Response.json(device);
      }
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      assert.equal(body.get("device_code"), "private-device");
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    },
  });
  const login = await manager.beginLogin();
  assert.equal(login.authorizationUrl, device.verification_uri_complete);
  assert.equal(opened, login.authorizationUrl);
  assert.equal(login.userCode, "ABCD-EFGH");
  const result = await login.completion;
  assert.equal(result.access_token, "access");
  assert.equal(result.refresh_token, "refresh");
  assert.ok(result.expires_at > Date.now());
  assert.equal(writes, 0);
});

test("Grok login cancels pending polling and never exposes the device code or server error", async () => {
  assert.equal(typeof authManagers.GrokAuthManager, "function");
  const store = { read: async () => ({ api_keys: {}, oauth: {} }), update: async () => { throw new Error("no writes"); } };
  let polls = 0;
  const manager = new authManagers.GrokAuthManager(store, {
    openExternalUrl: async () => { throw new Error("browser unavailable"); },
    fetch: async input => {
      if (String(input).endsWith("/device/code")) return Response.json(device);
      polls++;
      return Response.json({ error: "authorization_pending", error_description: "private-device" }, { status: 400 });
    },
  });
  const login = await manager.beginLogin();
  const rejected = assert.rejects(login.completion, /cancelled/i);
  await login.cancel();
  await rejected;
  assert.equal(polls, 0);
});

test("Grok refresh coalesces requests and preserves other credentials and unrotated refresh token", async () => {
  assert.equal(typeof authManagers.GrokAuthManager, "function");
  let saved = { api_keys: { xai: { api_key: "keep-api" } }, oauth: { xai: { access_token: "old", refresh_token: "keep-refresh", expires_at: 1 } } };
  let requests = 0;
  const manager = new authManagers.GrokAuthManager({
    read: async () => structuredClone(saved),
    update: async mutate => saved = mutate(saved) as typeof saved,
  }, { fetch: async (_input, init) => {
    requests++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "keep-refresh");
    return Response.json({ access_token: "fresh", expires_in: 3600 });
  } });
  const [first, second] = await Promise.all([manager.getValidCredential(), manager.getValidCredential()]);
  assert.equal(requests, 1);
  assert.deepEqual(first, second);
  assert.equal(saved.oauth.xai.access_token, "fresh");
  assert.equal(saved.oauth.xai.refresh_token, "keep-refresh");
  assert.equal(saved.api_keys.xai.api_key, "keep-api");
});

test("device polling respects pending/slow_down and returns a safe denial", { timeout: 15000 }, async () => {
  const polls: number[] = [];
  const manager = new authManagers.GrokAuthManager({ read: async () => ({ api_keys: {}, oauth: {} }), update: async () => { throw new Error("no writes"); } }, {
    openExternalUrl: async () => undefined,
    fetch: async input => {
      if (String(input).endsWith("/device/code")) return Response.json(device);
      polls.push(Date.now());
      return Response.json({ error: ["authorization_pending", "slow_down", "access_denied"][polls.length - 1], error_description: "private-device" }, { status: 400 });
    },
  });
  const login = await manager.beginLogin();
  await assert.rejects(login.completion, error => {
    assert.match(String(error), /denied/);
    assert.doesNotMatch(String(error), /private-device/);
    return true;
  });
  assert.equal(polls.length, 3);
  assert.ok(polls[2]! - polls[1]! >= 5900, "slow_down must increase the interval by five seconds");
});

test("expired and malformed device responses cannot open an unsafe browser URL or persist credentials", async () => {
  const store = { read: async () => ({ api_keys: {}, oauth: {} }), update: async () => { throw new Error("no writes"); } };
  for (const payload of [{ ...device, verification_uri_complete: "https://evil.example/" }, { ...device, expires_in: -1 }, { ...device, interval: 0 }]) {
    const manager = new authManagers.GrokAuthManager(store, {
      openExternalUrl: async () => assert.fail("must not open malformed device response"),
      fetch: async () => Response.json(payload),
    });
    await assert.rejects(() => manager.beginLogin(), /could not be started/);
  }
  const manager = new authManagers.GrokAuthManager(store, { openExternalUrl: async () => undefined,
    fetch: async input => {
      assert.ok(String(input).endsWith("/device/code"), "expired login must stop before polling");
      return Response.json({ ...device, expires_in: 1, interval: 5 });
    },
  });
  await assert.rejects((await manager.beginLogin()).completion, /expired/);
});

test("failed refresh preserves auth and an in-flight refresh cannot overwrite a replacement account", async () => {
  const previous = { access_token: "old", refresh_token: "old-refresh", expires_at: 1 };
  let saved = { api_keys: {}, oauth: { xai: previous } };
  const store = { read: async () => structuredClone(saved), update: async (mutate: any) => saved = mutate(saved) };
  const failed = new authManagers.GrokAuthManager(store, { fetch: async () => Response.json({ access_token: "leak" }) });
  await assert.rejects(() => failed.getValidCredential(), /could not be refreshed/);
  assert.deepEqual(saved.oauth.xai, previous);
  let respond!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { respond = resolve; });
  const manager = new authManagers.GrokAuthManager(store, { fetch: () => response });
  const pending = manager.getValidCredential();
  await new Promise(resolve => setImmediate(resolve));
  saved.oauth.xai = { access_token: "new-account", refresh_token: "new-refresh", expires_at: Date.now() + 3600000 };
  respond(Response.json({ access_token: "stale-refresh-result", expires_in: 3600 }));
  await assert.rejects(pending, /credential changed/);
  assert.equal(saved.oauth.xai.access_token, "new-account");
});
