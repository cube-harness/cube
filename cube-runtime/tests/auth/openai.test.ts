import assert from "node:assert/strict";
import test from "node:test";
import type { OpenAISubscriptionCredential } from "@cube/workspace";
import {
  buildOpenAIAuthorizationUrl,
  createOpenAIPkce,
  exchangeOpenAIAuthorizationCode,
  beginOpenAILogin,
  parseOpenAICallback,
  tokenResponseToCredential,
} from "../../src/auth/openai.js";

const jwt = (payload: object) => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.`;
};

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
  } satisfies OpenAISubscriptionCredential);

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
