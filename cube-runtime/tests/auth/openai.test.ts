import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import type { OpenAIOAuthCredential } from "@cube/workspace";
import {
  buildOpenAIAuthorizationUrl,
  createOpenAIPkce,
  exchangeOpenAIAuthorizationCode,
  beginOpenAILogin,
  createOpenAICallback,
  parseOpenAICallback,
  tokenResponseToCredential,
  getOpenAISubscriptionUsage,
} from "../../src/auth/openai.js";

const jwt = (payload: object) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

test("subscription usage reads WHAM windows without deriving limits from the plan", async () => {
  const credential = { access_token: "access", refresh_token: "refresh", account_id: "account", expires_at: Date.now() + 3600000 };
  const window = { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 90, reset_at: 1800000000 };
  const quota = { allowed: true, limit_reached: false, primary_window: window, secondary_window: { ...window, used_percent: 100, limit_window_seconds: 604800 } };
  const usage = await getOpenAISubscriptionUsage(credential, async (input, init) => {
    assert.equal(String(input), "https://chatgpt.com/backend-api/wham/usage");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer access");
    assert.equal(headers.get("chatgpt-account-id"), "account");
    return Response.json({ plan_type: "pro", rate_limit: quota,
      additional_rate_limits: [{ limit_name: "Account model", metered_feature: "model-bucket", rate_limit: { ...quota, primary_window: { ...window, used_percent: 0 }, secondary_window: null } }],
      user_id: "do-not-expose", credits: { balance: "irrelevant" },
    });
  });
  assert.deepEqual(usage, { provider: "OpenAI", plan: "pro", limits: [
    { name: "Codex", allowed: true, limitReached: false, windows: [
      { name: "Primary", usedPercent: 25, windowSeconds: 18000, resetsAt: 1800000000 },
      { name: "Secondary", usedPercent: 100, windowSeconds: 604800, resetsAt: 1800000000 },
    ] },
    { name: "Account model", allowed: true, limitReached: false, windows: [
      { name: "Primary", usedPercent: 0, windowSeconds: 18000, resetsAt: 1800000000 },
    ] },
  ] });
  const missing = await getOpenAISubscriptionUsage(credential, async () => Response.json({ rate_limit: null }));
  assert.equal(missing.plan, undefined);
  assert.deepEqual(missing.limits[0]?.windows, []);
  const partial = await getOpenAISubscriptionUsage(credential, async () => Response.json({
    plan_type: "future-plan", rate_limit: { primary_window: { used_percent: 0 } },
  }));
  assert.equal(partial.plan, "future-plan");
  assert.deepEqual(partial.limits[0]?.windows[0], { name: "Primary", usedPercent: 0, windowSeconds: undefined, resetsAt: undefined });

  for (const payload of [[], { additional_rate_limits: {} }, { rate_limit: { primary_window: { used_percent: "25" } } }, { rate_limit: { primary_window: { reset_at: 1e30 } } }]) {
    await assert.rejects(getOpenAISubscriptionUsage(credential, async () => Response.json(payload)), /Invalid OpenAI usage/);
  }
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(getOpenAISubscriptionUsage(credential, async () => Response.json({
      error: { message: "Provider detail" }, access_token: "must-not-leak",
    }, { status })), { message: `OpenAI usage (HTTP ${status}): Provider detail` });
  }
  await assert.rejects(getOpenAISubscriptionUsage(credential, async () => new Response("<html>private payload</html>", { status: 502 })), { message: "OpenAI usage (HTTP 502)" });
  await assert.rejects(getOpenAISubscriptionUsage(credential, async () => { throw new TypeError("fetch failed"); }), /fetch failed/);
  const controller = new AbortController();
  controller.abort(new Error("request timed out"));
  await assert.rejects(getOpenAISubscriptionUsage(credential, async (_input, init) => {
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  }, controller.signal), /request timed out/);
});

test("creates S256 PKCE values and the Codex authorization URL", () => {
  const pkce = createOpenAIPkce((size) => Buffer.alloc(size, 7));
  const url = new URL(buildOpenAIAuthorizationUrl(pkce));

  assert.equal(pkce.verifier.length >= 43, true);
  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(url.searchParams.get("state"), pkce.state);
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
  assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
  assert.match(url.searchParams.get("scope") ?? "", /api\.connectors\.invoke/);
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.notEqual(createOpenAIPkce().state, createOpenAIPkce().state);
});

test("rejects callback errors and state mismatches without returning a code", () => {
  assert.deepEqual(
    parseOpenAICallback("/auth/callback?code=secret&state=wrong", "expected"),
    { ok: false },
  );
  assert.deepEqual(
    parseOpenAICallback("/auth/callback?error=access_denied&state=expected", "expected"),
    { ok: false },
  );
  assert.deepEqual(
    parseOpenAICallback("/auth/callback?code=accepted&state=expected", "expected"),
    { ok: true, code: "accepted" },
  );
});

test("starts the callback before browser open and keeps login alive if opening fails", async () => {
  const events: string[] = [];
  let resolveCode!: (code: string) => void;
  const code = new Promise<string>((resolve) => { resolveCode = resolve; });
  const handle = await beginOpenAILogin({
    randomBytes: (size) => Buffer.alloc(size, 3),
    now: () => 0,
    createCallback: async () => {
      events.push("listen");
      return { completion: code, close: async () => undefined };
    },
    openExternalUrl: async () => {
      events.push("open");
      throw new Error("browser closed");
    },
    fetch: async () => new Response(JSON.stringify({
      access_token: jwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
      }),
      refresh_token: "refresh",
      expires_in: 3600,
    }), { status: 200 }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["listen", "open"]);
  assert.match(handle.authorizationUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  resolveCode("code");
  assert.equal((await handle.completion).account_id, "account-1");
});

test("exchanges an authorization code without exposing it in an error", async () => {
  let body = "";
  const credential = await exchangeOpenAIAuthorizationCode(
    "secret-code",
    "verifier",
    async (_url, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({
        access_token: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
        }),
        refresh_token: "refresh",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    { now: () => 1_000 },
  );

  assert.match(body, /code=secret-code/);
  assert.deepEqual(credential, {
    access_token: jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    }),
    refresh_token: "refresh",
    expires_at: 3_601_000,
    account_id: "account-1",
  } satisfies OpenAIOAuthCredential);

  await assert.rejects(
    () => exchangeOpenAIAuthorizationCode(
      "must-not-leak",
      "verifier",
      async () => new Response("contains server internals", { status: 400 }),
    ),
    (error: Error) => error.message === "OpenAI sign-in could not be completed."
      && !error.message.includes("must-not-leak")
      && !error.message.includes("server internals"),
  );
});

test("validates token claims before producing a stored credential", () => {
  assert.throws(
    () => tokenResponseToCredential({
      access_token: "access",
      refresh_token: "refresh",
      expires_in: 3600,
      id_token: jwt({}),
    }, 0),
    /OpenAI account information is missing/,
  );
});

test("browser preconnect does not hold the successful callback before token exchange", async () => {
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const callback = await createOpenAICallback("expected", redirectUri);
  const preconnect = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => preconnect.once("connect", resolve));
  try {
    const response = await fetch(`${redirectUri}?code=accepted&state=expected`);
    assert.equal(response.status, 200);
    await response.text();
    const result = await Promise.race([
      callback.completion,
      new Promise<string>((resolve) => setTimeout(() => resolve("callback-stalled"), 500)),
    ]);
    assert.equal(result, "accepted");
  } finally {
    preconnect.destroy();
    await callback.close();
  }
});

test("cancel stops token exchange even after the callback has completed", async () => {
  let started!: () => void;
  const exchanging = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const login = await beginOpenAILogin({
    createCallback: async () => ({ completion: Promise.resolve("code"), close: async () => undefined }),
    openExternalUrl: async () => undefined,
    fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); });
      started();
    }),
  });
  const completion = assert.rejects(login.completion, /sign-in could not be completed/);
  await exchanging;
  await login.cancel();
  assert.equal(aborted, true);
  await completion;
});
