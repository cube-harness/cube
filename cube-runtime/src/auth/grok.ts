import { setTimeout as delay } from "node:timers/promises";
import { GrokOAuthCredentialSchema, type GrokOAuthCredential } from "@cube/workspace";
import { GROK_BUILD_BASE_URL, GROK_BUILD_HEADERS } from "@cube/agent";
import type { SubscriptionUsage } from "../types.js";
import { openExternalUrl } from "./openai.js";

// Grok Build device flow, as used by 9router's grok-cli provider.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

export const getGrokSubscriptionUsage = async (
  credential: GrokOAuthCredential,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<SubscriptionUsage> => {
  const usage: SubscriptionUsage = { provider: "xAI", limits: [] };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid xAI usage response.");
    return value as Record<string, unknown>;
  };
  const number = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    const raw = typeof value === "object" ? object(value).val : value;
    const result =
      typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(result) || result < 0) throw new Error("Invalid xAI credit amount.");
    return result;
  };
  const request = async (path: string) => {
    const response = await fetchImpl(`${GROK_BUILD_BASE_URL}/${path}`, {
      headers: {
        ...GROK_BUILD_HEADERS,
        "x-grok-client-mode": "headless",
        authorization: `Bearer ${credential.access_token}`,
        accept: "application/json",
      },
      signal,
      redirect: "error",
    });
    const data = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = data?.error?.message ?? data?.message;
      throw new Error(
        `xAI ${path.split("?")[0]} (HTTP ${response.status})${typeof message === "string" ? `: ${message}` : ""}`,
      );
    }
    return object(data);
  };
  const results = await Promise.allSettled([
    request("user?include=subscription").then((data) => {
      const subscription = data.subscription == null ? {} : object(data.subscription);
      const tier = data.subscriptionTier ?? data.subscription_tier ?? subscription.tier;
      if (typeof tier === "string") usage.plan = tier;
    }),
    request("billing?format=credits").then((data) => {
      const config = data.config == null ? data : object(data.config);
      const period = config.currentPeriod == null ? {} : object(config.currentPeriod);
      const reset = config.billingPeriodEnd ?? period.end;
      const resetsAt =
        reset == null ? undefined : typeof reset === "string" ? Date.parse(reset) / 1000 : NaN;
      if (resetsAt !== undefined && !Number.isFinite(resetsAt))
        throw new Error("Invalid xAI usage reset time.");
      const limits: SubscriptionUsage["limits"] = [];
      const add = (name: string, usedValue: unknown, totalValue: unknown) => {
        const used = number(usedValue),
          total = number(totalValue);
        if (used === undefined && total === undefined) return;
        limits.push({
          name,
          windows: [
            {
              name: "Credits",
              usedPercent:
                used !== undefined && total !== undefined && total > 0
                  ? (used / total) * 100
                  : undefined,
              remaining:
                used !== undefined && total !== undefined ? Math.max(0, total - used) : undefined,
              unit: "credits",
              resetsAt,
            },
          ],
        });
      };
      add(
        "Monthly included",
        config.includedUsed ?? data.includedUsed,
        config.monthlyLimit ?? data.monthlyLimit,
      );
      add("On-demand", config.onDemandUsed, config.onDemandCap);
      const weekly = number(config.creditUsagePercent);
      if (weekly !== undefined) {
        const weeklyReset =
          period.end == null
            ? undefined
            : typeof period.end === "string"
              ? Date.parse(period.end) / 1000
              : NaN;
        if (weeklyReset !== undefined && !Number.isFinite(weeklyReset))
          throw new Error("Invalid xAI weekly reset time.");
        limits.push({
          name: "Grok Build",
          windows: [
            {
              name: "Weekly",
              usedPercent: weekly,
              windowSeconds: 604_800,
              resetsAt: weeklyReset,
            },
          ],
        });
      }
      const prepaid = number(config.prepaidBalance);
      if (prepaid !== undefined)
        limits.push({
          name: "Prepaid balance",
          windows: [{ name: "Balance", remaining: prepaid, unit: "credits" }],
        });
      usage.limits = limits;
    }),
  ]);
  usage.notice =
    results
      .flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "xAI usage request failed."]
          : [],
      )
      .join("; ") || undefined;
  // REST billing can omit the subscription's shared weekly pool entirely.
  if (
    results[1].status === "fulfilled" &&
    !usage.limits.some((limit) => limit.name === "Grok Build")
  ) {
    try {
      const response = await fetchImpl(
        "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.access_token}`,
            "content-type": "application/grpc-web+proto",
            "x-grpc-web": "1",
            accept: "application/grpc-web+proto",
          },
          body: new Uint8Array(5),
          signal,
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error(`xAI weekly quota (HTTP ${response.status}).`);
      const status = response.headers.get("grpc-status");
      if (status !== null && status !== "0") throw new Error(`xAI weekly quota (gRPC ${status}).`);
      const window = readGrokCreditsFrame(Buffer.from(await response.arrayBuffer()));
      usage.limits.unshift({ name: "Grok Build", windows: [window] });
    } catch (error) {
      usage.notice = [
        usage.notice,
        error instanceof Error ? error.message : "xAI weekly quota request failed.",
      ]
        .filter(Boolean)
        .join("; ");
    }
  }
  return usage;
};

// GetGrokCreditsConfig: credits info = field 1; usage ratio = 1, reset Timestamp = 5.
// Only the wire types used by this response are decoded; no general protobuf framework.
const readGrokCreditsFrame = (
  buffer: Buffer,
): SubscriptionUsage["limits"][number]["windows"][number] => {
  const invalid = () => new Error("Invalid xAI weekly quota response.");
  const fields = (bytes: Buffer) => {
    const result = new Map<number, { wire: number; value: number | Buffer }>();
    let offset = 0;
    const varint = () => {
      let value = 0;
      for (let i = 0; i < 10 && offset < bytes.length; i++) {
        const byte = bytes[offset++];
        value += (byte & 127) * 2 ** (7 * i);
        if (!Number.isSafeInteger(value)) throw invalid();
        if (!(byte & 128)) return value;
      }
      throw invalid();
    };
    while (offset < bytes.length) {
      const tag = varint(),
        wire = tag % 8,
        id = Math.floor(tag / 8);
      if (!id) throw invalid();
      if (wire === 0) {
        result.set(id, { wire, value: varint() });
        continue;
      }
      const size = wire === 2 ? varint() : wire === 5 ? 4 : wire === 1 ? 8 : -1;
      if (size < 0 || size > bytes.length - offset) throw invalid();
      const value =
        wire === 5
          ? bytes.readFloatLE(offset)
          : wire === 1
            ? bytes.readDoubleLE(offset)
            : bytes.subarray(offset, offset + size);
      offset += size;
      result.set(id, { wire, value });
    }
    return result;
  };
  let payload: Buffer | undefined;
  for (let offset = 0; offset < buffer.length; ) {
    if (buffer.length - offset < 5) throw invalid();
    const flag = buffer[offset],
      size = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (size > buffer.length - offset) throw invalid();
    const frame = buffer.subarray(offset, offset + size);
    offset += size;
    if (flag === 0 && !payload) payload = frame;
    else if (flag === 128) {
      const status = /^grpc-status:\s*(\d+)\s*$/im.exec(frame.toString("utf8"))?.[1];
      if (status && status !== "0") throw new Error(`xAI weekly quota (gRPC ${status}).`);
    } else throw invalid();
  }
  if (!payload) throw invalid();
  const info = fields(payload).get(1);
  if (info?.wire !== 2 || !Buffer.isBuffer(info.value)) throw invalid();
  const credits = fields(info.value),
    ratioField = credits.get(1);
  const ratio =
    ratioField === undefined ? 0 : [1, 5].includes(ratioField.wire) ? ratioField.value : NaN;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0) throw invalid();
  const timestamp = credits.get(5);
  let resetsAt: number | undefined;
  if (timestamp) {
    if (timestamp.wire !== 2 || !Buffer.isBuffer(timestamp.value)) throw invalid();
    const seconds = fields(timestamp.value).get(1);
    if (seconds && (seconds.wire !== 0 || typeof seconds.value !== "number")) throw invalid();
    resetsAt = (seconds?.value as number | undefined) ?? 0;
    if (!Number.isFinite(new Date(resetsAt * 1000).getTime())) throw invalid();
  }
  return {
    name: "Weekly",
    usedPercent: Math.round(ratio * 10000) / 100,
    windowSeconds: 604_800,
    resetsAt,
  };
};

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
