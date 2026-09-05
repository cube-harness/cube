import crypto from "node:crypto";
import {
  buildGatewayCatalog,
  gatewayDescriptors,
  normalizeLMStudioBaseUrl,
  normalizeOllamaBaseUrl,
} from "@cube/agent";
import {
  CubeAuthSchema,
  RunnableConfigSchema,
  type ApiKeyGatewayId,
  type CubeAuth,
  type CubeConfigDocument,
  type GatewayId,
  type LocalGatewayId,
  type ModelCatalog,
  type OpenAISubscriptionCredential,
} from "@cube/workspace";
import type { OpenAILoginHandle } from "../auth/openai.js";
import type {
  GatewayChoice,
  GatewayDraft,
  GatewayReadiness,
  GatewaySelection,
  GatewayState,
  ModelSelection,
} from "../types.js";

type UpdatingStore<T> = {
  read(): Promise<T>;
  update(mutator: (current: T) => T): Promise<T>;
};

export type GatewayRuntimeAdapter = {
  gatewayId: GatewayId;
  getBaseUrl?(): string;
  setBaseUrl?(baseUrl: string): void;
};

type OpenAILoginSource = {
  beginLogin(signal?: AbortSignal): Promise<OpenAILoginHandle>;
};

export type GatewayServiceDependencies = {
  config: UpdatingStore<CubeConfigDocument>;
  auth: UpdatingStore<CubeAuth>;
  adapters: ReadonlyMap<GatewayId, GatewayRuntimeAdapter>;
  catalog: { getCatalog(): Promise<ModelCatalog> };
  openAIAuth?: OpenAILoginSource;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  applyLiveSelection?: (
    gatewayId: GatewayId,
    model: ModelSelection,
  ) => void | Promise<void>;
};

type PendingCandidate =
  | { kind: "stored" }
  | { kind: "api_key"; gatewayId: ApiKeyGatewayId; apiKey: string }
  | { kind: "subscription"; credential: OpenAISubscriptionCredential }
  | { kind: "local"; gatewayId: LocalGatewayId; baseUrl: string };

type PendingDraft = {
  draft: GatewayDraft;
  candidate: PendingCandidate;
  timeout: ReturnType<typeof setTimeout>;
};

const API_PROVIDER = {
  "api_key/google": "google",
  "api_key/openrouter": "openrouter",
  "api_key/openai": "openai",
} as const;

const emptyCatalog = (canonical: ModelCatalog): ModelCatalog => ({
  version: 2,
  updatedAt: canonical.updatedAt,
  providers: {},
});

const allProviderModels = (catalog: ModelCatalog, provider: string): string[] =>
  catalog.providers[provider]?.models.map((item) => item.modelId) ?? [];

const containsModel = (catalog: ModelCatalog, modelId: string): boolean =>
  Object.values(catalog.providers)
    .some((provider) => provider.models.some((model) => model.modelId === modelId));

export class GatewayService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingDraft>();

  constructor(private readonly dependencies: GatewayServiceDependencies) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 5_000;
  }

  async readiness(): Promise<GatewayReadiness> {
    const config = await this.dependencies.config.read();
    const runnable = RunnableConfigSchema.safeParse(config);
    if (!runnable.success) {
      return {
        ready: false,
        reason: "Choose a gateway and model to continue.",
        ...(config.gateway ? { configuredGateway: config.gateway } : {}),
      };
    }
    try {
      const catalog = await this.listModels(runnable.data.gateway);
      if (!containsModel(catalog, runnable.data.model)) {
        return {
          ready: false,
          configuredGateway: runnable.data.gateway,
          reason: `Model ${runnable.data.model} is not available through the configured gateway.`,
        };
      }
      return {
        ready: true,
        gatewayId: runnable.data.gateway,
        model: {
          modelId: runnable.data.model,
          ...(runnable.data.model_config.reasoning_effort
            ? { reasoningEffort: runnable.data.model_config.reasoning_effort }
            : {}),
        },
      };
    } catch (error) {
      return {
        ready: false,
        configuredGateway: runnable.data.gateway,
        reason: error instanceof Error ? error.message : "The configured gateway is unavailable.",
      };
    }
  }

  async listChoices(): Promise<GatewayChoice[]> {
    const [auth, config] = await Promise.all([
      this.dependencies.auth.read(),
      this.dependencies.config.read(),
    ]);
    return (Object.entries(gatewayDescriptors) as Array<[
      GatewayId,
      (typeof gatewayDescriptors)[GatewayId],
    ]>).map(([gatewayId, descriptor]) => ({
      gatewayId,
      group: descriptor.group,
      provider: descriptor.providerId,
      configured: descriptor.group === "api_key"
        ? Boolean(auth.api_keys[descriptor.providerId as keyof typeof auth.api_keys])
        : descriptor.group === "subscription"
          ? Boolean(auth.subscriptions.openai)
          : Boolean(config.gateway_options[gatewayId as LocalGatewayId]),
    }));
  }

  async listModels(gatewayId?: GatewayId): Promise<ModelCatalog> {
    const config = await this.dependencies.config.read();
    const selected = gatewayId ?? config.gateway;
    if (!selected) {
      return emptyCatalog(await this.dependencies.catalog.getCatalog());
    }
    return this.discover(selected, { kind: "stored" }, config);
  }

  async createStoredDraft(
    gatewayId: GatewayId,
    signal?: AbortSignal,
  ): Promise<GatewayDraft> {
    const config = await this.dependencies.config.read();
    const candidate = { kind: "stored" } as const;
    return this.createDraft(gatewayId, candidate, config, signal);
  }

  async createApiKeyDraft(
    gatewayId: ApiKeyGatewayId,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<GatewayDraft> {
    if (!apiKey.trim()) throw new Error("API key is required.");
    const config = await this.dependencies.config.read();
    return this.createDraft(
      gatewayId,
      { kind: "api_key", gatewayId, apiKey: apiKey.trim() },
      config,
      signal,
    );
  }

  async createLocalDraft(
    gatewayId: LocalGatewayId,
    baseUrl: string,
    signal?: AbortSignal,
  ): Promise<GatewayDraft> {
    const normalized = gatewayId === "local/ollama"
      ? normalizeOllamaBaseUrl(baseUrl)
      : normalizeLMStudioBaseUrl(baseUrl);
    const config = await this.dependencies.config.read();
    return this.createDraft(
      gatewayId,
      { kind: "local", gatewayId, baseUrl: normalized },
      config,
      signal,
    );
  }

  async beginOpenAILogin(signal?: AbortSignal): Promise<{
    authorizationUrl: string;
    completion: Promise<GatewayDraft>;
    cancel(): Promise<void>;
  }> {
    if (!this.dependencies.openAIAuth) {
      throw new Error("OpenAI sign-in is unavailable.");
    }
    const login = await this.dependencies.openAIAuth.beginLogin(signal);
    return {
      authorizationUrl: login.authorizationUrl,
      cancel: login.cancel,
      completion: login.completion.then(async (credential) => {
        const config = await this.dependencies.config.read();
        return this.createDraft(
          "subscription/openai",
          { kind: "subscription", credential },
          config,
          signal,
        );
      }),
    };
  }

  discardDraft(draftId: string): void {
    const pending = this.pending.get(draftId);
    if (pending) clearTimeout(pending.timeout);
    this.pending.delete(draftId);
  }

  commitInitial(selection: GatewaySelection): Promise<GatewayState> {
    return this.commit(selection, false);
  }

  set(selection: GatewaySelection): Promise<GatewayState> {
    return this.commit(selection, true);
  }

  private async createDraft(
    gatewayId: GatewayId,
    candidate: PendingCandidate,
    config: CubeConfigDocument,
    signal?: AbortSignal,
  ): Promise<GatewayDraft> {
    const catalog = await this.discover(gatewayId, candidate, config, signal);
    const draftId = crypto.randomUUID();
    const draft: GatewayDraft = {
      draftId,
      gatewayId,
      catalog,
      ...(config.model && containsModel(catalog, config.model)
        ? { currentModelId: config.model }
        : {}),
    };
    const timeout = setTimeout(() => this.pending.delete(draftId), 10 * 60_000);
    timeout.unref?.();
    this.pending.set(draftId, { draft, candidate, timeout });
    return structuredClone(draft);
  }

  private async discover(
    gatewayId: GatewayId,
    candidate: PendingCandidate,
    config: CubeConfigDocument,
    signal?: AbortSignal,
  ): Promise<ModelCatalog> {
    const canonical = await this.dependencies.catalog.getCatalog();
    const auth = await this.dependencies.auth.read();
    let canonicalModelIds: string[];

    if (gatewayId.startsWith("api_key/")) {
      const typedGateway = gatewayId as ApiKeyGatewayId;
      const provider = API_PROVIDER[typedGateway];
      const apiKey = candidate.kind === "api_key" && candidate.gatewayId === typedGateway
        ? candidate.apiKey
        : auth.api_keys[provider]?.api_key;
      if (!apiKey) throw new Error(`Missing API key for ${gatewayId}. Run /gateway to configure it.`);
      canonicalModelIds = await this.discoverApiKeyModels(
        typedGateway,
        apiKey,
        canonical,
        signal,
      );
    } else if (gatewayId === "subscription/openai") {
      const credential = candidate.kind === "subscription"
        ? candidate.credential
        : auth.subscriptions.openai;
      if (!credential) {
        throw new Error("OpenAI subscription is not configured. Run /gateway to sign in.");
      }
      const payload = await this.fetchJson(
        "https://chatgpt.com/backend-api/codex/models",
        {
          headers: {
            authorization: `Bearer ${credential.access_token}`,
            "ChatGPT-Account-Id": credential.account_id,
            originator: "codex_cli_rs",
          },
        },
        "OpenAI subscription",
        signal,
      );
      canonicalModelIds = this.readStringArray(payload, "models", "slug")
        .map((id) => `openai/${id}`);
    } else {
      const local = gatewayId as LocalGatewayId;
      const configuredUrl = candidate.kind === "local" && candidate.gatewayId === local
        ? candidate.baseUrl
        : config.gateway_options[local]?.base_url;
      if (!configuredUrl) throw new Error(`Missing endpoint for ${gatewayId}.`);
      if (local === "local/ollama") {
        const baseUrl = normalizeOllamaBaseUrl(configuredUrl);
        const payload = await this.fetchJson(
          `${baseUrl}/api/tags`,
          {},
          "Ollama",
          signal,
        );
        canonicalModelIds = this.readStringArray(payload, "models", "name")
          .map((id) => `ollama/${id}`);
      } else {
        const baseUrl = normalizeLMStudioBaseUrl(configuredUrl);
        const payload = await this.fetchJson(
          `${baseUrl}/models`,
          {},
          "LM Studio",
          signal,
        );
        canonicalModelIds = this.readStringArray(payload, "data", "id")
          .map((id) => `lmstudio/${id}`);
      }
    }

    return buildGatewayCatalog(canonical, gatewayId, canonicalModelIds);
  }

  private async discoverApiKeyModels(
    gatewayId: ApiKeyGatewayId,
    apiKey: string,
    catalog: ModelCatalog,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (gatewayId === "api_key/google") {
      const payload = await this.fetchJson(
        "https://generativelanguage.googleapis.com/v1beta/models",
        { headers: { "x-goog-api-key": apiKey } },
        "Google",
        signal,
      );
      return this.readStringArray(payload, "models", "name")
        .map((id) => `google/${id.replace(/^models\//, "")}`);
    }
    if (gatewayId === "api_key/openrouter") {
      await this.fetchJson(
        "https://openrouter.ai/api/v1/key",
        { headers: { authorization: `Bearer ${apiKey}` } },
        "OpenRouter",
        signal,
      );
      return allProviderModels(catalog, "openrouter");
    }
    const payload = await this.fetchJson(
      "https://api.openai.com/v1/models",
      { headers: { authorization: `Bearer ${apiKey}` } },
      "OpenAI",
      signal,
    );
    return this.readStringArray(payload, "data", "id").map((id) => `openai/${id}`);
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    label: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let status: number | undefined;
    try {
      const response = await this.fetchImpl(url, { ...init, signal: requestSignal });
      status = response.status;
      if (!response.ok) throw new Error("request rejected");
      return await response.json();
    } catch {
      if (status === 401 || status === 403) {
        throw new Error(`${label} credential was rejected.`);
      }
      if (status === 429) {
        throw new Error(`${label} quota or rate limit reached.`);
      }
      throw new Error(`${label} gateway is unavailable or rejected the credential.`);
    }
  }

  private readStringArray(
    payload: unknown,
    collectionKey: string,
    valueKey: string,
  ): string[] {
    if (payload === null || typeof payload !== "object") return [];
    const collection = (payload as Record<string, unknown>)[collectionKey];
    if (!Array.isArray(collection)) return [];
    return collection.flatMap((item) => {
      if (item === null || typeof item !== "object") return [];
      const value = (item as Record<string, unknown>)[valueKey];
      return typeof value === "string" && value.length > 0 ? [value] : [];
    });
  }

  private async commit(
    selection: GatewaySelection,
    applyLive: boolean,
  ): Promise<GatewayState> {
    const pending = this.pending.get(selection.draftId);
    if (!pending) throw new Error("Gateway selection expired. Run /gateway again.");
    if (!containsModel(pending.draft.catalog, selection.model.modelId)) {
      throw new Error(`Model ${selection.model.modelId} is not available through ${pending.draft.gatewayId}.`);
    }

    const previousConfig = await this.dependencies.config.read();
    const previousAuth = await this.dependencies.auth.read();
    const adapter = this.dependencies.adapters.get(pending.draft.gatewayId);
    const previousBaseUrl = adapter?.getBaseUrl?.();
    let liveApplyAttempted = false;

    try {
      await this.applyCandidateAuth(pending.candidate);
      if (pending.candidate.kind === "local") {
        adapter?.setBaseUrl?.(pending.candidate.baseUrl);
      }
      await this.dependencies.config.update((current) => ({
        ...current,
        gateway: pending.draft.gatewayId,
        model: selection.model.modelId,
        model_config: selection.model.reasoningEffort
          ? { ...current.model_config, reasoning_effort: selection.model.reasoningEffort }
          : {},
        gateway_options: pending.candidate.kind === "local"
          ? {
              ...current.gateway_options,
              [pending.candidate.gatewayId]: { base_url: pending.candidate.baseUrl },
            }
          : current.gateway_options,
      }));
      if (applyLive && this.dependencies.applyLiveSelection) {
        liveApplyAttempted = true;
        await this.dependencies.applyLiveSelection(
          pending.draft.gatewayId,
          selection.model,
        );
      }
      return { gatewayId: pending.draft.gatewayId, model: { ...selection.model } };
    } catch {
      await this.dependencies.auth.update(() => previousAuth).catch(() => undefined);
      await this.dependencies.config.update(() => previousConfig).catch(() => undefined);
      if (previousBaseUrl) adapter?.setBaseUrl?.(previousBaseUrl);
      const previousRunnable = RunnableConfigSchema.safeParse(previousConfig);
      if (liveApplyAttempted && previousRunnable.success && this.dependencies.applyLiveSelection) {
        await Promise.resolve(this.dependencies.applyLiveSelection(previousRunnable.data.gateway, {
          modelId: previousRunnable.data.model,
          ...(previousRunnable.data.model_config.reasoning_effort
            ? { reasoningEffort: previousRunnable.data.model_config.reasoning_effort }
            : {}),
        })).catch(() => undefined);
      }
      throw new Error("Gateway switch failed; the previous configuration is still active.");
    } finally {
      this.discardDraft(selection.draftId);
    }
  }

  private async applyCandidateAuth(candidate: PendingCandidate): Promise<void> {
    if (candidate.kind === "api_key") {
      const provider = API_PROVIDER[candidate.gatewayId];
      await this.dependencies.auth.update((current) => CubeAuthSchema.parse({
        ...current,
        api_keys: {
          ...current.api_keys,
          [provider]: { api_key: candidate.apiKey },
        },
      }));
    } else if (candidate.kind === "subscription") {
      await this.dependencies.auth.update((current) => CubeAuthSchema.parse({
        ...current,
        subscriptions: { ...current.subscriptions, openai: candidate.credential },
      }));
    }
  }
}
