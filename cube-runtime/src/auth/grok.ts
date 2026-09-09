import { setTimeout as delay } from "node:timers/promises";
import { GrokOAuthCredentialSchema, type GrokOAuthCredential } from "@cube/workspace";
import { openExternalUrl } from "./openai.js";

// Grok Build device flow, as used by 9router's grok-cli provider.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

export type GrokOAuthOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  openExternalUrl?: (url: string) => Promise<void>;
};

export type GrokLoginHandle = {
  authorizationUrl: string;
  userCode: string;
  expiresAt: number;
  completion: Promise<GrokOAuthCredential>;
  cancel(): Promise<void>;
};

const post = async (
  url: string,
  fields: Record<string, string>,
  options: GrokOAuthOptions,
  signal?: AbortSignal,
) => {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid Grok response.");
  return { response, data: data as Record<string, unknown> };
};

const credentialFrom = (
  data: Record<string, unknown>,
  now: number,
  previous?: GrokOAuthCredential,
): GrokOAuthCredential => {
  const expires = data.expires_in;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0)
    throw new Error("Invalid Grok session.");
  const parsed = GrokOAuthCredentialSchema.safeParse({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expires_at: now + Math.floor(expires * 1000),
  });
  if (!parsed.success) throw new Error("Invalid Grok session.");
  return parsed.data;
};

export const beginGrokLogin = async (
  options: GrokOAuthOptions = {},
  signal?: AbortSignal,
): Promise<GrokLoginHandle> => {
  signal?.throwIfAborted();
  let device: Record<string, unknown>;
  let authorizationUrl: string;
  try {
    const { response, data } = await post(
      "https://auth.x.ai/oauth2/device/code",
      { scope: SCOPE, referrer: "grok-build" },
      options,
      signal,
    );
    if (!response.ok) throw new Error("Device request rejected.");
    device = data;
    const url = new URL(String(data.verification_uri_complete ?? data.verification_uri));
    if (
      url.protocol !== "https:" ||
      !["accounts.x.ai", "auth.x.ai"].includes(url.hostname) ||
      url.username ||
      url.password ||
      /[\x00-\x1f\x7f]/.test(String(data.verification_uri_complete ?? data.verification_uri))
    )
      throw new Error("Invalid verification URL.");
    if (
      typeof data.device_code !== "string" ||
      !data.device_code ||
      typeof data.user_code !== "string" ||
      !/^[A-Za-z0-9-]{1,64}$/.test(data.user_code) ||
      typeof data.expires_in !== "number" ||
      !Number.isInteger(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86_400 ||
      (data.interval !== undefined &&
        (typeof data.interval !== "number" ||
          !Number.isInteger(data.interval) ||
          data.interval < 1 ||
          data.interval > 86_400))
    ) {
      throw new Error("Invalid device response.");
    }
    authorizationUrl = url.toString();
  } catch {
    throw new Error(
      signal?.aborted
        ? "Grok Build sign-in cancelled."
        : "Grok Build sign-in could not be started. Run /gateway to try again.",
    );
  }
  const expiresAt = (options.now ?? Date.now)() + (device.expires_in as number) * 1000;
  const abort = new AbortController();
  const lifetime = AbortSignal.timeout((device.expires_in as number) * 1000);
  const pollingSignal = AbortSignal.any([abort.signal, lifetime, ...(signal ? [signal] : [])]);
  const completion = (async () => {
    let interval = ((device.interval as number | undefined) ?? 5) * 1000;
    try {
      while (true) {
        await delay(interval, undefined, { signal: pollingSignal });
        const { response, data } = await post(
          TOKEN_URL,
          {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: device.device_code as string,
          },
          options,
          pollingSignal,
        );
        pollingSignal.throwIfAborted();
        if (response.ok) return credentialFrom(data, (options.now ?? Date.now)());
        if (response.status === 400 && data.error === "authorization_pending") continue;
        if (response.status === 400 && data.error === "slow_down") {
          interval += 5000;
          continue;
        }
        if (data.error === "access_denied")
          throw new Error("Grok Build sign-in was denied. Run /gateway to try again.");
        if (data.error === "expired_token")
          throw new Error("Grok Build sign-in expired. Run /gateway to try again.");
        throw new Error("Token request rejected.");
      }
    } catch (error) {
      if (abort.signal.aborted || signal?.aborted) throw new Error("Grok Build sign-in cancelled.");
      if (lifetime.aborted)
        throw new Error("Grok Build sign-in expired. Run /gateway to try again.");
      if (error instanceof Error && /^Grok Build sign-in (was denied|expired)/.test(error.message))
        throw error;
      throw new Error("Grok Build sign-in could not be completed. Run /gateway to try again.");
    }
  })();
  // The picker attaches its handler after beginLogin resolves; cancellation can win that race.
  void completion.catch(() => undefined);
  if (!pollingSignal.aborted)
    void (options.openExternalUrl ?? openExternalUrl)(authorizationUrl).catch(() => undefined);
  return {
    authorizationUrl,
    userCode: device.user_code as string,
    expiresAt,
    completion,
    cancel: async () => {
      abort.abort();
    },
  };
};

export const refreshGrokCredential = async (
  previous: GrokOAuthCredential,
  options: GrokOAuthOptions = {},
): Promise<GrokOAuthCredential> => {
  try {
    const { response, data } = await post(
      TOKEN_URL,
      { grant_type: "refresh_token", refresh_token: previous.refresh_token },
      options,
    );
    if (!response.ok) throw new Error("Refresh rejected.");
    return credentialFrom(data, (options.now ?? Date.now)(), previous);
  } catch {
    throw new Error("Grok Build session could not be refreshed. Sign in again with /gateway.");
  }
};
