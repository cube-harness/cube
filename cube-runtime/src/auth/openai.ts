import crypto from "node:crypto";
import http, { type Server } from "node:http";
import { spawn } from "node:child_process";
import {
  OpenAISubscriptionCredentialSchema,
  type OpenAISubscriptionCredential,
} from "@cube/workspace";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OPENAI_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export type OpenAIPkce = {
  verifier: string;
  challenge: string;
  state: string;
};

export type OpenAITokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
};

export type OpenAICallbackHandle = {
  completion: Promise<string>;
  close(): Promise<void>;
};

export type OpenAILoginHandle = {
  authorizationUrl: string;
  completion: Promise<OpenAISubscriptionCredential>;
  cancel(): Promise<void>;
};

export type OpenAIOAuthOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  redirectUri?: string;
  openExternalUrl?: (url: string) => Promise<void>;
  createCallback?: (state: string, redirectUri: string) => Promise<OpenAICallbackHandle>;
};

export type OpenAICallbackResult =
  | { ok: true; code: string }
  | { ok: false };

export const createOpenAIPkce = (
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): OpenAIPkce => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
};

export const buildOpenAIAuthorizationUrl = (
  pkce: OpenAIPkce,
  redirectUri = OPENAI_REDIRECT_URI,
): string => {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli");
  return url.toString();
};

export const parseOpenAICallback = (
  requestUrl: string,
  expectedState: string,
  redirectUri = OPENAI_REDIRECT_URI,
): OpenAICallbackResult => {
  const expected = new URL(redirectUri);
  const callback = new URL(requestUrl, redirectUri);
  if (callback.pathname !== expected.pathname
    || callback.searchParams.has("error")
    || callback.searchParams.get("state") !== expectedState) {
    return { ok: false };
  }
  const code = callback.searchParams.get("code");
  return code ? { ok: true, code } : { ok: false };
};

const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
};

const accountIdFromToken = (token: unknown): string | undefined => {
  if (typeof token !== "string") return undefined;
  const payload = decodeJwtPayload(token);
  const auth = payload?.[OPENAI_JWT_CLAIM_PATH];
  if (auth === null || typeof auth !== "object") return undefined;
  const claims = auth as Record<string, unknown>;
  const accountId = claims.chatgpt_account_id ?? claims.account_id;
  return typeof accountId === "string" && accountId.length > 0
    ? accountId
    : undefined;
};

const expiresAtFromToken = (token: unknown): number | undefined => {
  if (typeof token !== "string") return undefined;
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0
    ? Math.floor(exp * 1_000)
    : undefined;
};

export const tokenResponseToCredential = (
  response: OpenAITokenResponse,
  now: number,
  previous?: OpenAISubscriptionCredential,
): OpenAISubscriptionCredential => {
  const accessToken = response.access_token;
  const refreshToken = response.refresh_token ?? previous?.refresh_token;
  const expiresIn = response.expires_in;
  const expiresAt = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
    ? now + Math.floor(expiresIn * 1_000)
    : expiresAtFromToken(response.access_token) ?? expiresAtFromToken(response.id_token);
  const accountId = accountIdFromToken(response.id_token)
    ?? accountIdFromToken(accessToken)
    ?? previous?.account_id;

  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("OpenAI account information is missing from the sign-in response.");
  }
  if (typeof accessToken !== "string" || accessToken.length === 0
    || typeof refreshToken !== "string" || refreshToken.length === 0
    || expiresAt === undefined || expiresAt <= now) {
    throw new Error("OpenAI returned an invalid session.");
  }

  return OpenAISubscriptionCredentialSchema.parse({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    account_id: accountId,
  });
};

const readTokenResponse = async (response: Response): Promise<OpenAITokenResponse> => {
  if (!response.ok) throw new Error("OpenAI token request failed.");
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== "object") {
    throw new Error("OpenAI returned an invalid token response.");
  }
  return payload as OpenAITokenResponse;
};

export const exchangeOpenAIAuthorizationCode = async (
  code: string,
  verifier: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  options: { now?: () => number; redirectUri?: string } = {},
): Promise<OpenAISubscriptionCredential> => {
  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: options.redirectUri ?? OPENAI_REDIRECT_URI,
    });
    const response = await fetchImpl(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return tokenResponseToCredential(
      await readTokenResponse(response),
      (options.now ?? Date.now)(),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OpenAI account information")) {
      throw error;
    }
    throw new Error("OpenAI sign-in could not be completed.");
  }
};

export const refreshOpenAICredential = async (
  previous: OpenAISubscriptionCredential,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<OpenAISubscriptionCredential> => {
  try {
    const response = await fetchImpl(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: OPENAI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: previous.refresh_token,
      }),
    });
    const refreshed = tokenResponseToCredential(
      await readTokenResponse(response),
      now(),
      previous,
    );
    if (refreshed.account_id !== previous.account_id) {
      throw new Error("OpenAI refresh returned a different account.");
    }
    return refreshed;
  } catch {
    throw new Error("OpenAI session could not be refreshed. Sign in again with /gateway.");
  }
};

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  if (!server.listening) return resolve();
  server.close(() => resolve());
});

export const createOpenAICallback = async (
  expectedState: string,
  redirectUri = OPENAI_REDIRECT_URI,
): Promise<OpenAICallbackHandle> => {
  const callbackUrl = new URL(redirectUri);
  if (callbackUrl.protocol !== "http:"
    || (callbackUrl.hostname !== "localhost" && callbackUrl.hostname !== "127.0.0.1")) {
    throw new Error("OpenAI sign-in requires a localhost HTTP callback.");
  }
  const port = Number(callbackUrl.port || 80);
  const bindHost = callbackUrl.hostname === "localhost" ? "127.0.0.1" : callbackUrl.hostname;
  let server: Server;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const completion = new Promise<string>((resolve, reject) => {
    rejectCompletion = reject;
    server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirectUri);
      if (requestUrl.pathname !== callbackUrl.pathname) {
        response.writeHead(404).end("Not found");
        return;
      }
      const result = parseOpenAICallback(requestUrl.toString(), expectedState, redirectUri);
      if (!result.ok) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("OpenAI sign-in failed. Return to Cube and try again.");
        void closeServer(server).then(() => reject(new Error("OpenAI sign-in callback was rejected.")));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("OpenAI sign-in complete. You can return to Cube.");
      void closeServer(server).then(() => resolve(result.code));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(() => {
    throw new Error("Cube could not start the OpenAI sign-in callback server.");
  });

  return {
    completion,
    close: async () => {
      await closeServer(server);
      rejectCompletion(new Error("OpenAI sign-in cancelled."));
    },
  };
};

export const openExternalUrl = async (url: string): Promise<void> => {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};

export const beginOpenAILogin = async (
  options: OpenAIOAuthOptions = {},
  signal?: AbortSignal,
): Promise<OpenAILoginHandle> => {
  const redirectUri = options.redirectUri ?? OPENAI_REDIRECT_URI;
  const pkce = createOpenAIPkce(options.randomBytes);
  const authorizationUrl = buildOpenAIAuthorizationUrl(pkce, redirectUri);
  const callback = await (options.createCallback ?? createOpenAICallback)(pkce.state, redirectUri);
  const cancel = callback.close;
  const abort = () => void cancel();
  const completion = callback.completion.then((code) =>
    exchangeOpenAIAuthorizationCode(code, pkce.verifier, options.fetch, {
      now: options.now,
      redirectUri,
    })).finally(() => signal?.removeEventListener("abort", abort));

  if (signal?.aborted) {
    void completion.catch(() => undefined);
    await cancel();
    throw new Error("OpenAI sign-in cancelled.");
  }
  signal?.addEventListener("abort", abort, { once: true });

  void (options.openExternalUrl ?? openExternalUrl)(authorizationUrl).catch(() => undefined);
  return { authorizationUrl, completion, cancel };
};
