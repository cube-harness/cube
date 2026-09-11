import { setTimeout as delay } from "node:timers/promises";
import { GOOGLE_CODE_ASSIST_BASE_URL, GOOGLE_CODE_ASSIST_HEADERS } from "@cube/agent";
import { GoogleOAuthCredentialSchema, type GoogleOAuthCredential } from "@cube/workspace";
import { createOpenAICallback, createOpenAIPkce, openExternalUrl, type OpenAIOAuthOptions } from "./openai.js";

// Public installed-app credentials published by Gemini CLI, not a user's API key.
const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://127.0.0.1:45289/oauth2callback";
const SCOPES = ["cloud-platform", "userinfo.email", "userinfo.profile"]
  .map(scope => `https://www.googleapis.com/auth/${scope}`).join(" ");

export type GoogleOAuthOptions = OpenAIOAuthOptions;

const requestJson = async (
  url: string, init: RequestInit, options: GoogleOAuthOptions, signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    ...init,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data?.error) {
    const message = typeof data?.error_description === "string" ? data.error_description
      : typeof data?.error?.message === "string" ? data.error.message
        : typeof data?.error === "string" ? data.error : response.statusText;
    throw new Error(`Google OAuth HTTP ${response.status}: ${message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Google returned an invalid response.");
  return data;
};

const requestToken = async (
  fields: Record<string, string>, options: GoogleOAuthOptions, signal?: AbortSignal,
  previous?: GoogleOAuthCredential,
) => {
  const data = await requestJson(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
  }, options, signal);
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
    throw new Error("Google returned an invalid token expiry.");
  const credential = GoogleOAuthCredentialSchema.omit({ project_id: true }).safeParse({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expires_at: (options.now ?? Date.now)() + Math.floor(data.expires_in * 1000),
  });
  if (!credential.success) throw new Error("Google returned an invalid session. Run /gateway to sign in again.");
  return credential.data;
};

const loadProject = async (accessToken: string, options: GoogleOAuthOptions, signal: AbortSignal): Promise<string> => {
  const headers = { ...GOOGLE_CODE_ASSIST_HEADERS, "content-type": "application/json", authorization: `Bearer ${accessToken}` };
  const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
  const account = await requestJson(`${GOOGLE_CODE_ASSIST_BASE_URL}:loadCodeAssist`, {
    method: "POST", headers, body: JSON.stringify({ metadata }),
  }, options, signal);
  if (typeof account.cloudaicompanionProject === "string" && account.cloudaicompanionProject)
    return account.cloudaicompanionProject;
  const tiers = Array.isArray(account.allowedTiers) ? account.allowedTiers : [];
  const tier = tiers.find(value => value?.isDefault === true);
  // Personal managed projects only: never create a billable Cloud project or enable paid overages.
  if (account.currentTier || tier?.id !== "free-tier" || tier.userDefinedCloudaicompanionProject) {
    const reasons = Array.isArray(account.ineligibleTiers)
      ? account.ineligibleTiers.flatMap(value => typeof value?.reasonMessage === "string" ? [value.reasonMessage] : []) : [];
    throw new Error(reasons.join(" ") || "Google did not provide a managed Code Assist project. Finish Gemini CLI account setup or use Google API key; organization Cloud projects are not configured by Cube.");
  }
  let operation = await requestJson(`${GOOGLE_CODE_ASSIST_BASE_URL}:onboardUser`, {
    method: "POST", headers, body: JSON.stringify({ tierId: tier.id, metadata }),
  }, options, signal);
  while (operation.done !== true) {
    if (typeof operation.name !== "string" || !/^operations\/[\w/-]+$/.test(operation.name))
      throw new Error("Google returned an invalid account setup operation.");
    await delay(5000, undefined, { signal });
    operation = await requestJson(`${GOOGLE_CODE_ASSIST_BASE_URL}/${operation.name}`, { headers }, options, signal);
  }
  const result = operation.response as { cloudaicompanionProject?: { id?: unknown } } | undefined;
  const project = result?.cloudaicompanionProject?.id;
  if (typeof project !== "string" || !project) throw new Error("Google account setup did not return a Code Assist project.");
  return project;
};

export const refreshGoogleCredential = async (
  previous: GoogleOAuthCredential, options: GoogleOAuthOptions = {},
): Promise<GoogleOAuthCredential> => GoogleOAuthCredentialSchema.parse({
  ...await requestToken({ grant_type: "refresh_token", refresh_token: previous.refresh_token }, options, undefined, previous),
  project_id: previous.project_id,
});

export const beginGoogleLogin = async (options: GoogleOAuthOptions = {}, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const pkce = createOpenAIPkce(options.randomBytes);
  const redirectUri = options.redirectUri ?? REDIRECT_URI;
  const callback = await (options.createCallback
    ? options.createCallback(pkce.state, redirectUri)
    : createOpenAICallback(pkce.state, redirectUri, "Google"));
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: redirectUri, scope: SCOPES,
    access_type: "offline", prompt: "consent select_account",
    code_challenge: pkce.challenge, code_challenge_method: "S256", state: pkce.state,
  }).toString();
  const abort = new AbortController();
  const expiresAt = (options.now ?? Date.now)() + 5 * 60_000;
  const timeout = setTimeout(() => abort.abort(new Error("Google sign-in timed out. Run /gateway to try again.")), 5 * 60_000);
  timeout.unref?.();
  const cancel = async () => {
    abort.abort(new Error("Google sign-in cancelled."));
    await callback.close();
  };
  const onAbort = () => { void cancel(); };
  abort.signal.addEventListener("abort", () => { void callback.close(); }, { once: true });
  const completion = callback.completion.then(async code => {
    abort.signal.throwIfAborted();
    const token = await requestToken({
      grant_type: "authorization_code", code, code_verifier: pkce.verifier, redirect_uri: redirectUri,
    }, options, abort.signal);
    const project_id = await loadProject(token.access_token, options, abort.signal);
    abort.signal.throwIfAborted();
    return GoogleOAuthCredentialSchema.parse({ ...token, project_id });
  }).catch(error => {
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
