import { AnthropicOAuthCredentialSchema, type AnthropicOAuthCredential } from "@cube/workspace";
import { createOpenAICallback, createOpenAIPkce, openExternalUrl, type OpenAIOAuthOptions } from "./openai.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "http://localhost:53692/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

export type AnthropicOAuthOptions = OpenAIOAuthOptions;

const requestCredential = async (
  fields: Record<string, string>,
  options: AnthropicOAuthOptions,
  signal?: AbortSignal,
  previous?: AnthropicOAuthCredential,
): Promise<AnthropicOAuthCredential> => {
  const response = await (options.fetch ?? globalThis.fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, ...fields }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const data = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    const error = data?.error;
    const message = typeof data?.error_description === "string" ? data.error_description
      : typeof error === "string" ? error
        : error && typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message : response.statusText;
    // Only the provider's message, never the response body or credentials.
    throw new Error(`Anthropic OAuth HTTP ${response.status}: ${message}`);
  }
  if (typeof data?.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
    throw new Error("Anthropic returned an invalid token expiry.");
  const result = AnthropicOAuthCredentialSchema.safeParse({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expires_at: (options.now ?? Date.now)() + Math.floor(data.expires_in * 1000),
  });
  if (!result.success) throw new Error("Anthropic returned an invalid session.");
  return result.data;
};

export const refreshAnthropicCredential = (
  previous: AnthropicOAuthCredential,
  options: AnthropicOAuthOptions = {},
): Promise<AnthropicOAuthCredential> => requestCredential(
  { grant_type: "refresh_token", refresh_token: previous.refresh_token }, options, undefined, previous,
);

export const beginAnthropicLogin = async (
  options: AnthropicOAuthOptions = {},
  signal?: AbortSignal,
) => {
  signal?.throwIfAborted();
  const pkce = createOpenAIPkce(options.randomBytes);
  const redirectUri = options.redirectUri ?? REDIRECT_URI;
  const callback = await (options.createCallback
    ? options.createCallback(pkce.state, redirectUri)
    : createOpenAICallback(pkce.state, redirectUri, "Anthropic"));
  const authorizationUrl = new URL(AUTHORIZE_URL);
  authorizationUrl.search = new URLSearchParams({
    code: "true", client_id: CLIENT_ID, response_type: "code", redirect_uri: redirectUri,
    scope: SCOPES, code_challenge: pkce.challenge, code_challenge_method: "S256", state: pkce.state,
  }).toString();
  const abort = new AbortController();
  // This is Cube's local sign-in window, not the access token lifetime.
  const expiresAt = (options.now ?? Date.now)() + 5 * 60_000;
  const timeout = setTimeout(() => abort.abort(new Error("Anthropic sign-in timed out. Run /gateway to try again.")), 5 * 60_000);
  timeout.unref?.();
  const cancel = async () => {
    abort.abort(new Error("Anthropic sign-in cancelled."));
    await callback.close();
  };
  const onAbort = () => { void cancel(); };
  abort.signal.addEventListener("abort", () => { void callback.close(); }, { once: true });
  const completion = callback.completion.then(async (code) => {
    abort.signal.throwIfAborted();
    const [authorizationCode, codeState] = code.split("#");
    if (!authorizationCode) throw new Error("Anthropic authorization code is missing.");
    if (codeState !== undefined && codeState !== pkce.state) throw new Error("Anthropic OAuth state mismatch.");
    return requestCredential({
      grant_type: "authorization_code", code: authorizationCode, state: pkce.state,
      code_verifier: pkce.verifier, redirect_uri: redirectUri,
    }, options, abort.signal);
  }).then((credential) => {
    abort.signal.throwIfAborted();
    return credential;
  }).catch((error) => {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  }).finally(async () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    await callback.close();
  });
  void completion.catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) await cancel();
  if (!abort.signal.aborted)
    void (options.openExternalUrl ?? openExternalUrl)(authorizationUrl.toString()).catch(() => undefined);
  return { authorizationUrl: authorizationUrl.toString(), expiresAt, completion, cancel };
};
