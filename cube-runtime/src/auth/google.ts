import { setTimeout as delay } from "node:timers/promises";
import { platform, arch } from "node:os";
import {
  GOOGLE_CODE_ASSIST_BASE_URL,
  ANTIGRAVITY_BASE_URL,
  ANTIGRAVITY_HEADERS,
} from "@cube/agent";
import { GoogleOAuthCredentialSchema, type GoogleOAuthCredential } from "@cube/workspace";
import type { SubscriptionUsage } from "../types.js";
import {
  createOpenAICallback,
  createOpenAIPkce,
  openExternalUrl,
  type OpenAIOAuthOptions,
} from "./openai.js";

// Public installed-app credentials used by Antigravity, not a user's API key.
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://127.0.0.1:45289/oauth2callback";
const SCOPES = [
  "cloud-platform",
  "userinfo.email",
  "userinfo.profile",
  "cclog",
  "experimentsandconfigs",
]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`)
  .join(" ");
const CLIENT_METADATA = {
  ideType: 9,
  platform:
    platform() === "win32"
      ? 5
      : platform() === "darwin"
        ? arch() === "arm64"
          ? 2
          : 1
        : platform() === "linux"
          ? arch() === "arm64"
            ? 4
            : 3
          : 0,
  pluginType: 2,
};

type GoogleModel = {
  displayName?: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  maxOutputTokens?: number;
  quotaInfo?: unknown;
};

export const fetchGoogleModels = async (
  credential: GoogleOAuthCredential,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
) => {
  const data = await requestJson(
    `${ANTIGRAVITY_BASE_URL}:fetchAvailableModels`,
    {
      method: "POST",
      headers: {
        ...ANTIGRAVITY_HEADERS,
        "content-type": "application/json",
        authorization: `Bearer ${credential.access_token}`,
      },
      body: JSON.stringify({ project: credential.project_id }),
    },
    { fetch: fetchImpl },
    signal,
  );
  if (!data.models || typeof data.models !== "object" || Array.isArray(data.models))
    throw new Error("Antigravity returned an invalid model catalog.");
  // This gateway remains Google/Gemini chat; other vendors and image generation are outside its scope.
  return Object.entries(data.models).flatMap(([id, model]): Array<[string, GoogleModel]> => {
    if (!id.startsWith("gemini-") || id.includes("image") || model?.isInternal === true) return [];
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      (model.displayName != null && typeof model.displayName !== "string") ||
      ["supportsThinking", "supportsImages", "isInternal"].some(
        (key) => model[key] != null && typeof model[key] !== "boolean",
      ) ||
      (model.maxOutputTokens != null &&
        (!Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0))
    )
      throw new Error("Antigravity returned invalid model metadata.");
    return [
      [
        id,
        {
          displayName: model.displayName ?? undefined,
          supportsThinking: model.supportsThinking ?? undefined,
          supportsImages: model.supportsImages ?? undefined,
          maxOutputTokens: model.maxOutputTokens ?? undefined,
          quotaInfo: model.quotaInfo,
        },
      ],
    ];
  });
};

export type GoogleOAuthOptions = OpenAIOAuthOptions;

export const getGoogleSubscriptionUsage = async (
  credential: GoogleOAuthCredential,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<SubscriptionUsage> => {
  const usage: SubscriptionUsage = { provider: "Google (Antigravity)", limits: [] };
  const request = (method: string, body: object) =>
    requestJson(
      `${GOOGLE_CODE_ASSIST_BASE_URL}:${method}`,
      {
        method: "POST",
        headers: {
          ...ANTIGRAVITY_HEADERS,
          "content-type": "application/json",
          authorization: `Bearer ${credential.access_token}`,
        },
        body: JSON.stringify(body),
      },
      { fetch: fetchImpl },
      signal,
    );
  const results = await Promise.allSettled([
    request("loadCodeAssist", {
      cloudaicompanionProject: credential.project_id,
      metadata: CLIENT_METADATA,
    }).then((data) => {
      const tier = data.paidTier ?? data.currentTier;
      if (tier && typeof tier === "object" && !Array.isArray(tier)) {
        const { name, id } = tier as { name?: unknown; id?: unknown };
        usage.plan = typeof name === "string" ? name : typeof id === "string" ? id : undefined;
      }
    }),
    fetchGoogleModels(credential, fetchImpl, signal).then((models) => {
      usage.limits = models.map(([modelId, model]) => {
        const quota = model.quotaInfo ?? {};
        if (typeof quota !== "object" || Array.isArray(quota))
          throw new Error("Invalid Antigravity model quota.");
        const { remainingFraction, resetTime } = quota as {
          remainingFraction?: unknown;
          resetTime?: unknown;
        };
        if (
          remainingFraction != null &&
          (typeof remainingFraction !== "number" ||
            !Number.isFinite(remainingFraction) ||
            remainingFraction < 0 ||
            remainingFraction > 1)
        )
          throw new Error("Invalid Antigravity quota fraction.");
        const resetsAt =
          resetTime == null
            ? undefined
            : typeof resetTime === "string"
              ? Date.parse(resetTime) / 1000
              : NaN;
        if (resetsAt !== undefined && !Number.isFinite(resetsAt))
          throw new Error("Invalid Antigravity quota reset time.");
        return {
          name: model.displayName || modelId,
          windows: [
            {
              name: "Quota",
              usedPercent: remainingFraction == null ? undefined : (1 - remainingFraction) * 100,
              resetsAt,
            },
          ],
        };
      });
    }),
  ]);
  usage.notice =
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [
              result.reason instanceof Error
                ? result.reason.message
                : "Google usage request failed.",
            ]
          : [],
      )
      .join("; ") || undefined;
  return usage;
};

const requestJson = async (
  url: string,
  init: RequestInit,
  options: GoogleOAuthOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> => {
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    ...init,
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data?.error) {
    const message =
      typeof data?.error_description === "string"
        ? data.error_description
        : typeof data?.error?.message === "string"
          ? data.error.message
          : typeof data?.error === "string"
            ? data.error
            : response.statusText;
    throw new Error(`Google OAuth HTTP ${response.status}: ${message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Google returned an invalid response.");
  return data;
};

const requestToken = async (
  fields: Record<string, string>,
  options: GoogleOAuthOptions,
  signal?: AbortSignal,
  previous?: GoogleOAuthCredential,
) => {
  const data = await requestJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...fields }),
    },
    options,
    signal,
  );
  if (
    typeof data.expires_in !== "number" ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new Error("Google returned an invalid token expiry.");
  const credential = GoogleOAuthCredentialSchema.omit({ project_id: true }).safeParse({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? previous?.refresh_token,
    expires_at: (options.now ?? Date.now)() + Math.floor(data.expires_in * 1000),
  });
  if (!credential.success)
    throw new Error("Google returned an invalid session. Run /gateway to sign in again.");
  return credential.data;
};

const loadProject = async (
  accessToken: string,
  options: GoogleOAuthOptions,
  signal: AbortSignal,
): Promise<string> => {
  const headers = {
    ...ANTIGRAVITY_HEADERS,
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  const metadata = CLIENT_METADATA;
  const account = await requestJson(
    `${GOOGLE_CODE_ASSIST_BASE_URL}:loadCodeAssist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata }),
    },
    options,
    signal,
  );
  const projectId = (value: unknown) => {
    const id = value && typeof value === "object" ? (value as { id?: unknown }).id : value;
    return typeof id === "string" ? id.trim() : "";
  };
  const existing = projectId(account.cloudaicompanionProject);
  if (existing) return existing;
  const tiers = Array.isArray(account.allowedTiers) ? account.allowedTiers : [];
  const tier = tiers.find((value) => value?.isDefault === true);
  // Personal managed projects only: never create a billable Cloud project or enable paid overages.
  if (typeof tier?.id !== "string" || !tier.id || tier.userDefinedCloudaicompanionProject) {
    const reasons = Array.isArray(account.ineligibleTiers)
      ? account.ineligibleTiers.flatMap((value) =>
          typeof value?.reasonMessage === "string" ? [value.reasonMessage] : [],
        )
      : [];
    throw new Error(
      reasons.join(" ") ||
        "Google did not provide a managed Antigravity project. Finish account setup in Antigravity and try again; user-supplied Cloud projects are not configured by Cube.",
    );
  }
  let operation = await requestJson(
    `${GOOGLE_CODE_ASSIST_BASE_URL}:onboardUser`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ tierId: tier.id, metadata }),
    },
    options,
    signal,
  );
  while (operation.done !== true) {
    if (typeof operation.name !== "string" || !/^operations\/[\w/-]+$/.test(operation.name))
      throw new Error("Google returned an invalid account setup operation.");
    await delay(5000, undefined, { signal });
    operation = await requestJson(
      `${GOOGLE_CODE_ASSIST_BASE_URL}/${operation.name}`,
      { headers },
      options,
      signal,
    );
  }
  const result = operation.response as { cloudaicompanionProject?: unknown } | undefined;
  const project = projectId(result?.cloudaicompanionProject);
  if (!project) throw new Error("Google account setup did not return an Antigravity project.");
  return project;
};

export const refreshGoogleCredential = async (
  previous: GoogleOAuthCredential,
  options: GoogleOAuthOptions = {},
): Promise<GoogleOAuthCredential> =>
  GoogleOAuthCredentialSchema.parse({
    ...(await requestToken(
      { grant_type: "refresh_token", refresh_token: previous.refresh_token },
      options,
      undefined,
      previous,
    )),
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
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent select_account",
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.state,
  }).toString();
  const abort = new AbortController();
  const expiresAt = (options.now ?? Date.now)() + 5 * 60_000;
  const timeout = setTimeout(
    () => abort.abort(new Error("Google sign-in timed out. Run /gateway to try again.")),
    5 * 60_000,
  );
  timeout.unref?.();
  const cancel = async () => {
    abort.abort(new Error("Google sign-in cancelled."));
    await callback.close();
  };
  const onAbort = () => {
    void cancel();
  };
  abort.signal.addEventListener(
    "abort",
    () => {
      void callback.close();
    },
    { once: true },
  );
  const completion = callback.completion
    .then(async (code) => {
      abort.signal.throwIfAborted();
      const token = await requestToken(
        {
          grant_type: "authorization_code",
          code,
          code_verifier: pkce.verifier,
          redirect_uri: redirectUri,
        },
        options,
        abort.signal,
      );
      const project_id = await loadProject(token.access_token, options, abort.signal);
      abort.signal.throwIfAborted();
      return GoogleOAuthCredentialSchema.parse({ ...token, project_id });
    })
    .catch((error) => {
      if (abort.signal.aborted) throw abort.signal.reason;
      throw error;
    })
    .finally(async () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      await callback.close();
    });
  void completion.catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) await cancel();
  if (!abort.signal.aborted)
    void (options.openExternalUrl ?? openExternalUrl)(authorizationUrl.toString()).catch(
      () => undefined,
    );
  return { authorizationUrl: authorizationUrl.toString(), expiresAt, completion, cancel };
};
