import crypto from "node:crypto";
import http, { type Server } from "node:http";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_SCOPE = "openid profile email offline_access";
export const OPENAI_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const OPENAI_CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

export interface OpenAIOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
}

export interface OpenAIPKCE {
  verifier: string;
  challenge: string;
}

export interface OpenAIAuthRequest {
  url: string;
  state: string;
  verifier: string;
}

export interface OpenAICallbackResult {
  code: string;
  state?: string;
}

export interface StartCallbackServerOptions {
  port?: number;
  expectedState?: string;
  timeoutMs?: number;
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cube - OpenAI Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: #0f172a;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background-color: #1e293b;
      padding: 2.5rem;
      border-radius: 1rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      text-align: center;
      max-width: 440px;
    }
    h1 {
      color: #38bdf8;
      font-size: 1.5rem;
      margin-top: 0;
    }
    p {
      color: #94a3b8;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Successful</h1>
    <p>You are now connected to OpenAI (ChatGPT Plus/Pro). You can close this tab and return to Cube.</p>
  </div>
</body>
</html>`;

/**
 * Generates PKCE code verifier and SHA-256 code challenge.
 */
export const generatePKCE = (): OpenAIPKCE => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
};

/**
 * Generates a random state string for OAuth CSRF protection.
 */
export const generateState = (): string => {
  return crypto.randomBytes(16).toString("hex");
};

/**
 * Builds the authorization URL and returns request metadata (url, state, verifier).
 */
export const createOpenAIAuthRequest = (options: {
  redirectUri?: string;
  state?: string;
} = {}): OpenAIAuthRequest => {
  const redirectUri = options.redirectUri ?? OPENAI_REDIRECT_URI;
  const state = options.state ?? generateState();
  const pkce = generatePKCE();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: OPENAI_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    prompt: "login",
    audience: "https://api.openai.com/v1",
  });

  return {
    url: `${OPENAI_AUTHORIZE_URL}?${params.toString()}`,
    state,
    verifier: pkce.verifier,
  };
};

/**
 * Decodes the payload portion of a JWT token without verification.
 */
export const decodeJwtPayload = <T = Record<string, unknown>>(token: string): T | null => {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
};

/**
 * Extracts chatgpt_account_id claim from JWT access token if present.
 */
export const extractChatGPTAccountId = (token: string): string | undefined => {
  const payload = decodeJwtPayload<{
    [OPENAI_JWT_CLAIM_PATH]?: {
      chatgpt_account_id?: string;
    };
    chatgpt_account_id?: string;
  }>(token);

  return (
    payload?.[OPENAI_JWT_CLAIM_PATH]?.chatgpt_account_id ??
    payload?.chatgpt_account_id
  );
};

/**
 * Parses user input (full redirect URL, params, hash fragment, or raw code).
 */
export const parseAuthorizationInput = (
  input: string,
): { code?: string; state?: string } => {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a full URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
};

/**
 * Exchanges authorization code for access and refresh tokens.
 */
export const exchangeOpenAICode = async (
  code: string,
  verifier: string,
  redirectUri: string = OPENAI_REDIRECT_URI,
): Promise<OpenAIOAuthTokens> => {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `OpenAI OAuth token exchange failed (${response.status}): ${errorBody}`,
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI OAuth response is missing required token fields");
  }

  const accountId = extractChatGPTAccountId(json.access_token);

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    ...(accountId ? { accountId } : {}),
  };
};

/**
 * Refreshes an expired access token using the refresh token.
 */
export const refreshOpenAIAccessToken = async (
  refreshToken: string,
): Promise<OpenAIOAuthTokens> => {
  const response = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `OpenAI OAuth token refresh failed (${response.status}): ${errorBody}`,
    );
  }

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || typeof json.expires_in !== "number") {
    throw new Error("OpenAI OAuth refresh response is missing required fields");
  }

  const newRefreshToken = json.refresh_token || refreshToken;
  const accountId = extractChatGPTAccountId(json.access_token);

  return {
    access: json.access_token,
    refresh: newRefreshToken,
    expires: Date.now() + json.expires_in * 1000,
    ...(accountId ? { accountId } : {}),
  };
};

/**
 * Checks if tokens have expired or will expire within the buffer window.
 */
export const isOpenAITokenExpired = (
  tokens: OpenAIOAuthTokens,
  bufferMs: number = 60_000,
): boolean => {
  return Date.now() + bufferMs >= tokens.expires;
};

/**
 * Ensures valid tokens, refreshing automatically if expired or near expiration.
 */
export const ensureValidOpenAIToken = async (
  tokens: OpenAIOAuthTokens,
  bufferMs: number = 60_000,
): Promise<OpenAIOAuthTokens> => {
  if (!isOpenAITokenExpired(tokens, bufferMs)) {
    return tokens;
  }
  return refreshOpenAIAccessToken(tokens.refresh);
};

/**
 * Starts a temporary local HTTP server to capture the OAuth redirect callback.
 */
export const startOAuthCallbackServer = async (
  options: StartCallbackServerOptions = {},
): Promise<OpenAICallbackResult> => {
  const port = options.port ?? 1455;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const expectedState = options.expectedState;

  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(400);
        res.end("Bad request");
        return;
      }

      try {
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state") ?? undefined;
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h1>Authentication Failed</h1><p>${errorDescription || error}</p>`);
          cleanup();
          reject(new Error(`OAuth authentication failed: ${errorDescription || error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Missing authorization code</h1>");
          return;
        }

        if (expectedState && state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>State verification failed</h1>");
          cleanup();
          reject(new Error("State mismatch: possible CSRF detected"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SUCCESS_HTML);

        cleanup();
        resolve({ code, state });
      } catch (err) {
        res.writeHead(500);
        res.end("Internal Server Error");
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on("error", (err) => {
      cleanup();
      reject(new Error(`OAuth callback server failed to start on port ${port}: ${err.message}`));
    });

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`OAuth authentication timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    server.listen(port);
  });
};