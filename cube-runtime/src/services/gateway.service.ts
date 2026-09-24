import crypto from "node:crypto";
import {
  GROK_BUILD_BASE_URL,
  GROK_BUILD_HEADERS,
  ANTHROPIC_BASE_URL,
  ANTHROPIC_OAUTH_HEADERS,
  gatewayDescriptors,
  normalizeLMStudioBaseUrl,
  normalizeOllamaBaseUrl,
} from "@cube/agent";
import {
  CubeAuthSchema,
  ModelManager,
  type CatalogModel,
  ApiKeyProviderSchema,
  RunnableConfigSchema,
  type ApiKeyGatewayId,
  type CubeAuth,
  type CubeConfigDocument,
  type GatewayId,
  type LocalGatewayId,
  type ModelCatalog,
  type OpenAIOAuthCredential,
  type GrokOAuthCredential,
  type AnthropicOAuthCredential,
  type GoogleOAuthCredential,
} from "@cube/workspace";
import { getOpenAISubscriptionUsage, type OpenAILoginHandle } from "../auth/openai.js";
import { getAnthropicSubscriptionUsage } from "../auth/anthropic.js";
import { fetchGoogleModels, getGoogleSubscriptionUsage } from "../auth/google.js";
import { getGrokSubscriptionUsage } from "../auth/grok.js";
import type {
  AnthropicAuthManager,
  GoogleAuthManager,
  GrokAuthManager,
} from "../auth/auth-manager.js";
import type {
  CredentialGatewayId,
  GatewayRemovalResult,
  GatewayChoice,
  GatewayDraft,
  GatewayReadiness,
  GatewaySelection,
  GatewayState,
  ModelSelection,
  SubscriptionUsage,
} from "../types.js";

type UpdatingStore<T> = {
  read(): Promise<T>;
  update(mutator: (current: T) => T): Promise<T>;
};

export type GatewayRuntimeAdapter = {
  getBaseUrl?(gatewayId: LocalGatewayId): string;
  setBaseUrl?(baseUrl: string, gatewayId: LocalGatewayId): void;
};

type OpenAILoginSource = {
  beginLogin(signal?: AbortSignal): Promise<OpenAILoginHandle>;
  getValidCredential?(): Promise<OpenAIOAuthCredential>;
};

export type GatewayServiceDependencies = {
  config: UpdatingStore<CubeConfigDocument>;
  auth: UpdatingStore<CubeAuth>;
  adapters: ReadonlyMap<GatewayId, GatewayRuntimeAdapter>;
  catalog: Pick<ModelManager, "getCatalog" | "preview" | "publish" | "remove">;
  mutationKey?: string;
  onActiveCredentialRemoved?: (gatewayId: CredentialGatewayId) => void | Promise<void>;
  openAIAuth?: OpenAILoginSource;
  grokAuth?: Pick<GrokAuthManager, "beginLogin" | "getValidCredential">;
  anthropicAuth?: Pick<AnthropicAuthManager, "beginLogin" | "getValidCredential">;
  googleAuth?: Pick<GoogleAuthManager, "beginLogin" | "getValidCredential">;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  applyLiveSelection?: (gatewayId: GatewayId, model: ModelSelection) => void | Promise<void>;
};

type PendingCandidate =
  | { kind: "stored" }
  | { kind: "api_key"; gatewayId: ApiKeyGatewayId; apiKey: string }
  | { kind: "oauth"; provider: "openai"; credential: OpenAIOAuthCredential }
  | { kind: "oauth"; provider: "xai"; credential: GrokOAuthCredential }
  | { kind: "oauth"; provider: "anthropic"; credential: AnthropicOAuthCredential }
  | { kind: "oauth"; provider: "google"; credential: GoogleOAuthCredential }
  | { kind: "local"; gatewayId: LocalGatewayId; baseUrl: string };

type PendingDraft = {
  draft: GatewayDraft;
  candidate: PendingCandidate;
  timeout: ReturnType<typeof setTimeout>;
  generation: number;
  sourceKey?: string;
};

const OPENAI_BACKEND = "https://chatgpt.com/backend-api/codex/models?client_version=0.153.1";

const containsModel = (catalog: ModelCatalog, modelId: string): boolean =>
  Object.values(catalog.providers).some((provider) =>
    provider.models.some((model) => model.modelId === modelId),
  );

export class GatewayService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingDraft>();
  private readonly logins = new Map<GatewayId, { cancel(): Promise<void> }>();
  private static readonly mutations = new Map<object | string, Promise<unknown>>();
  private readonly generations = new Map<GatewayId, number>();

  private generation(gatewayId: GatewayId): number {
    return this.generations.get(gatewayId) ?? 0;
  }

  private async cancelLogin(gatewayId: GatewayId): Promise<void> {
    const login = this.logins.get(gatewayId);
    if (!login) return;
    try {
      await login.cancel();
    } finally {
      if (this.logins.get(gatewayId) === login) this.logins.delete(gatewayId);
    }
  }

  private invalidate(gatewayId: GatewayId): number {
    const generation = this.generation(gatewayId) + 1;
    this.generations.set(gatewayId, generation);
    for (const pending of this.pending.values()) {
      if (pending.draft.gatewayId === gatewayId) this.discardDraft(pending.draft.draftId);
    }
    return generation;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.dependencies.mutationKey ?? this.dependencies.auth;
    const next = (GatewayService.mutations.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    GatewayService.mutations.set(key, next);
    void next
      .finally(() => {
        if (GatewayService.mutations.get(key) === next) GatewayService.mutations.delete(key);
      })
      .catch(() => undefined);
    return next;
  }

  private assertGeneration(gatewayId: GatewayId, generation: number): void {
    if (this.generation(gatewayId) !== generation)
      throw new Error("Gateway selection expired. Run /gateway again.");
  }

  private async sourceKey(gatewayId: GatewayId): Promise<string | undefined> {
    return ModelManager.sourceKey(gatewayId, {
      auth: await this.dependencies.auth.read(),
      config: await this.dependencies.config.read(),
    });
  }

  constructor(private readonly dependencies: GatewayServiceDependencies) {
    this.fetchImpl = dependencies.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 5_000;
  }

  async getSubscriptionUsage(): Promise<SubscriptionUsage | undefined> {
    const config = await this.dependencies.config.read();
    const gatewayId = config.gateway;
    let account: CubeAuth["oauth"];
    let readUsage: () => Promise<SubscriptionUsage>;
    // Keep each reader paired with the credential returned by its refresh manager.
    const fetchUsage = this.fetchImpl;
    switch (gatewayId) {
      case "oauth/openai": {
        const credential = await this.dependencies.openAIAuth?.getValidCredential?.();
        if (!credential) throw new Error("OpenAI OAuth is not configured. Run /gateway to sign in.");
        account = { openai: credential };
        readUsage = () => getOpenAISubscriptionUsage(credential, fetchUsage, AbortSignal.timeout(this.requestTimeoutMs));
        break;
      }
      case "oauth/anthropic": {
        const credential = await this.dependencies.anthropicAuth?.getValidCredential();
        if (!credential) throw new Error("Anthropic OAuth is not configured. Run /gateway to sign in.");
        account = { anthropic: credential };
        readUsage = () => getAnthropicSubscriptionUsage(credential, fetchUsage, AbortSignal.timeout(this.requestTimeoutMs));
        break;
      }
      case "oauth/google": {
        const credential = await this.dependencies.googleAuth?.getValidCredential();
        if (!credential) throw new Error("Google OAuth is not configured. Run /gateway to sign in.");
        account = { google: credential };
        readUsage = () => getGoogleSubscriptionUsage(credential, fetchUsage, AbortSignal.timeout(this.requestTimeoutMs));
        break;
      }
      case "oauth/xai": {
        const credential = await this.dependencies.grokAuth?.getValidCredential();
        if (!credential) throw new Error("xAI OAuth is not configured. Run /gateway to sign in.");
        account = { xai: credential };
        readUsage = () => getGrokSubscriptionUsage(credential, fetchUsage, AbortSignal.timeout(this.requestTimeoutMs));
        break;
      }
      default: return undefined;
    }
    const sourceKey = ModelManager.sourceKey(gatewayId, { config, auth: { api_keys: {}, oauth: account } });
    const usage = await readUsage();
    if ((await this.dependencies.config.read()).gateway !== gatewayId ||
        !sourceKey || sourceKey !== await this.sourceKey(gatewayId))
      throw new Error("Gateway or account changed. Run /status again.");
    return usage;
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
    return (
      Object.entries(gatewayDescriptors) as Array<
        [GatewayId, (typeof gatewayDescriptors)[GatewayId]]
      >
    ).map(([gatewayId, descriptor]) => ({
      gatewayId,
      group: descriptor.group,
      provider: descriptor.providerId,
      configured:
        descriptor.group === "api_key"
          ? Boolean(auth.api_keys[descriptor.providerId as keyof typeof auth.api_keys])
          : descriptor.group === "oauth"
            ? Boolean(auth.oauth[descriptor.providerId as keyof typeof auth.oauth])
            : Boolean(config.gateway_options[gatewayId as LocalGatewayId]),
    }));
  }

  async listModels(gatewayId?: GatewayId): Promise<ModelCatalog> {
    const config = await this.dependencies.config.read();
    const selected = gatewayId ?? config.gateway;
    if (!selected) {
      return { updatedAt: new Date().toISOString(), providers: {} };
    }
    const generation = this.generation(selected);
    const catalog = await this.discover(selected, { kind: "stored" }, config, undefined, true);
    this.assertGeneration(selected, generation);
    return catalog;
  }

  async createStoredDraft(gatewayId: GatewayId, signal?: AbortSignal): Promise<GatewayDraft> {
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
    const normalized =
      gatewayId === "local/ollama"
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
    const generation = this.invalidate("oauth/openai");
    await this.cancelLogin("oauth/openai");
    const sourceKey = await this.sourceKey("oauth/openai");
    const login = await this.dependencies.openAIAuth.beginLogin(signal);
    if (this.generation("oauth/openai") !== generation) {
      void login.completion.catch(() => undefined);
      await login.cancel();
      this.assertGeneration("oauth/openai", generation);
    }
    this.logins.set("oauth/openai", login);
    const completion = login.completion
      .then(async (credential) => {
        this.assertGeneration("oauth/openai", generation);
        if ((await this.sourceKey("oauth/openai")) !== sourceKey)
          throw new Error("OpenAI account changed. Run /gateway again.");
        const config = await this.dependencies.config.read();
        return this.createDraft(
          "oauth/openai",
          { kind: "oauth", provider: "openai", credential },
          config,
          signal,
          generation,
          sourceKey,
        );
      })
      .finally(() => {
        if (this.logins.get("oauth/openai") === login) this.logins.delete("oauth/openai");
      });
    void completion.catch(() => undefined);
    return { authorizationUrl: login.authorizationUrl, cancel: login.cancel, completion };
  }

  async beginAnthropicLogin(signal?: AbortSignal) {
    if (!this.dependencies.anthropicAuth) throw new Error("Anthropic sign-in is unavailable.");
    const gatewayId = "oauth/anthropic";
    const generation = this.invalidate(gatewayId);
    await this.cancelLogin(gatewayId);
    const sourceKey = await this.sourceKey(gatewayId);
    const login = await this.dependencies.anthropicAuth.beginLogin(signal);
    if (this.generation(gatewayId) !== generation) {
      void login.completion.catch(() => undefined);
      await login.cancel();
      this.assertGeneration(gatewayId, generation);
    }
    this.logins.set(gatewayId, login);
    const completion = login.completion
      .then(async (credential) => {
        this.assertGeneration(gatewayId, generation);
        if ((await this.sourceKey(gatewayId)) !== sourceKey)
          throw new Error("Anthropic account changed. Run /gateway again.");
        return this.createDraft(
          gatewayId,
          { kind: "oauth", provider: "anthropic", credential },
          await this.dependencies.config.read(),
          signal,
          generation,
          sourceKey,
        );
      })
      .finally(() => {
        if (this.logins.get(gatewayId) === login) this.logins.delete(gatewayId);
      });
    void completion.catch(() => undefined);
    return { ...login, completion };
  }

  async beginGoogleLogin(signal?: AbortSignal) {
    if (!this.dependencies.googleAuth) throw new Error("Google sign-in is unavailable.");
    const gatewayId = "oauth/google";
    const generation = this.invalidate(gatewayId);
    await this.cancelLogin(gatewayId);
    const sourceKey = await this.sourceKey(gatewayId);
    const login = await this.dependencies.googleAuth.beginLogin(signal);
    if (this.generation(gatewayId) !== generation) {
      void login.completion.catch(() => undefined);
      await login.cancel();
      this.assertGeneration(gatewayId, generation);
    }
    this.logins.set(gatewayId, login);
    const completion = login.completion
      .then(async (credential) => {
        this.assertGeneration(gatewayId, generation);
        if ((await this.sourceKey(gatewayId)) !== sourceKey)
          throw new Error("Google account changed. Run /gateway again.");
        return this.createDraft(
          gatewayId,
          { kind: "oauth", provider: "google", credential },
          await this.dependencies.config.read(),
          signal,
          generation,
          sourceKey,
        );
      })
      .finally(() => {
        if (this.logins.get(gatewayId) === login) this.logins.delete(gatewayId);
      });
    void completion.catch(() => undefined);
    return { ...login, completion };
  }

  discardDraft(draftId: string): void {
    const pending = this.pending.get(draftId);
    if (pending) clearTimeout(pending.timeout);
    this.pending.delete(draftId);
  }

  async beginGrokLogin(signal?: AbortSignal) {
    if (!this.dependencies.grokAuth) throw new Error("Grok Build sign-in is unavailable.");
    const generation = this.invalidate("oauth/xai");
    await this.cancelLogin("oauth/xai");
    const sourceKey = await this.sourceKey("oauth/xai");
    const login = await this.dependencies.grokAuth.beginLogin(signal);
    if (this.generation("oauth/xai") !== generation) {
      void login.completion.catch(() => undefined);
      await login.cancel();
      this.assertGeneration("oauth/xai", generation);
    }
    this.logins.set("oauth/xai", login);
    const completion = login.completion.then(async (credential) => {
      this.assertGeneration("oauth/xai", generation);
      if ((await this.sourceKey("oauth/xai")) !== sourceKey)
        throw new Error("xAI account changed. Run /gateway again.");
      return this.createDraft(
        "oauth/xai",
        { kind: "oauth", provider: "xai", credential },
        await this.dependencies.config.read(),
        signal,
        generation,
        sourceKey,
      );
    });
    void completion
      .finally(() => {
        if (this.logins.get("oauth/xai") === login) this.logins.delete("oauth/xai");
      })
      .catch(() => undefined);
    return {
      authorizationUrl: login.authorizationUrl,
      userCode: login.userCode,
      expiresAt: login.expiresAt,
      cancel: login.cancel,
      completion,
    };
  }

  commitInitial(selection: GatewaySelection): Promise<GatewayState> {
    return this.mutate(() => this.commit(selection, false));
  }

  set(selection: GatewaySelection): Promise<GatewayState> {
    return this.mutate(() => this.commit(selection, true));
  }

  removeCredential(gatewayId: CredentialGatewayId): Promise<GatewayRemovalResult> {
    if (!gatewayId.startsWith("oauth/") && !gatewayId.startsWith("api_key/"))
      throw new Error("This gateway has no credential to remove.");
    this.invalidate(gatewayId);
    void this.cancelLogin(gatewayId).catch(() => undefined);
    return this.mutate(async () => {
      const config = await this.dependencies.config.read();
      const expectedKey = await this.sourceKey(gatewayId);
      const [, provider] = gatewayId.split("/");
      await this.dependencies.auth.update((current) => {
        const next = structuredClone(current);
        if (gatewayId.startsWith("oauth/")) delete next.oauth[provider as keyof typeof next.oauth];
        else delete next.api_keys[provider as keyof typeof next.api_keys];
        return next;
      });
      const active = config.gateway === gatewayId;
      if (active) await this.dependencies.onActiveCredentialRemoved?.(gatewayId);
      let cacheCleared = true;
      try {
        await this.dependencies.catalog.remove(gatewayId, expectedKey);
      } catch {
        cacheCleared = false;
      }
      return { gatewayId, active, cacheCleared };
    });
  }

  private async createDraft(
    gatewayId: GatewayId,
    candidate: PendingCandidate,
    config: CubeConfigDocument,
    signal?: AbortSignal,
    generation = this.invalidate(gatewayId),
    expectedSourceKey?: string,
  ): Promise<GatewayDraft> {
    if (candidate.kind === "stored" && gatewayId === "oauth/openai")
      await this.dependencies.openAIAuth?.getValidCredential?.();
    if (candidate.kind === "stored" && gatewayId === "oauth/xai")
      await this.dependencies.grokAuth?.getValidCredential();
    if (candidate.kind === "stored" && gatewayId === "oauth/anthropic")
      await this.dependencies.anthropicAuth?.getValidCredential();
    if (candidate.kind === "stored" && gatewayId === "oauth/google")
      await this.dependencies.googleAuth?.getValidCredential();
    const sourceKey = expectedSourceKey ?? (await this.sourceKey(gatewayId));
    const catalog = await this.discover(gatewayId, candidate, config, signal);
    signal?.throwIfAborted();
    this.assertGeneration(gatewayId, generation);
    if ((await this.sourceKey(gatewayId)) !== sourceKey)
      throw new Error("Gateway credential changed. Run /gateway again.");
    const draftId = crypto.randomUUID();
    const draft: GatewayDraft = {
      draftId,
      gatewayId,
      catalog,
      ...(sourceKey &&
      config.gateway === gatewayId &&
      config.model &&
      containsModel(catalog, config.model)
        ? { currentModelId: config.model }
        : {}),
    };
    const timeout = setTimeout(() => this.pending.delete(draftId), 10 * 60_000);
    timeout.unref?.();
    this.pending.set(draftId, { draft, candidate, timeout, generation, sourceKey });
    return structuredClone(draft);
  }

  private async discover(
    gatewayId: GatewayId,
    candidate: PendingCandidate,
    config: CubeConfigDocument,
    signal?: AbortSignal,
    persist = false,
  ): Promise<ModelCatalog> {
    if (candidate.kind === "stored" && gatewayId === "oauth/openai")
      await this.dependencies.openAIAuth?.getValidCredential?.();
    if (candidate.kind === "stored" && gatewayId === "oauth/xai")
      await this.dependencies.grokAuth?.getValidCredential();
    if (candidate.kind === "stored" && gatewayId === "oauth/anthropic")
      await this.dependencies.anthropicAuth?.getValidCredential();
    if (candidate.kind === "stored" && gatewayId === "oauth/google")
      await this.dependencies.googleAuth?.getValidCredential();
    const auth = await this.dependencies.auth.read();
    const sourceKey = ModelManager.sourceKey(gatewayId, { auth, config });
    if (candidate.kind === "stored") {
      const cached = await this.dependencies.catalog.getCatalog(gatewayId);
      // Refresh incomplete OpenAI metadata; an empty map means the provider supplied no descriptions.
      if (cached && !(gatewayId === "oauth/openai" && cached.providers.openai?.models.some(
        model => model.reasoning_efforts?.length && model.reasoning_effort_descriptions === undefined,
      ))) return cached;
    }
    let canonicalModelIds: string[] | undefined;
    let available: CatalogModel[] | undefined;

    if (gatewayId.startsWith("api_key/")) {
      const typedGateway = gatewayId as ApiKeyGatewayId;
      const provider = ApiKeyProviderSchema.parse(typedGateway.slice("api_key/".length));
      const apiKey =
        candidate.kind === "api_key" && candidate.gatewayId === typedGateway
          ? candidate.apiKey
          : auth.api_keys[provider]?.api_key;
      if (!apiKey)
        throw new Error(`Missing API key for ${gatewayId}. Run /gateway to configure it.`);
    } else if (gatewayId === "oauth/openai") {
      const credential =
        candidate.kind === "oauth" && candidate.provider === "openai"
          ? candidate.credential
          : auth.oauth.openai;
      if (!credential) {
        throw new Error("OpenAI OAuth is not configured. Run /gateway to sign in.");
      }
      if (credential.expires_at <= Date.now()) {
        throw new Error("OpenAI OAuth credential expired. Run /gateway to sign in.");
      }
      const payload = await this.fetchJson(
        OPENAI_BACKEND,
        {
          headers: {
            authorization: `Bearer ${credential.access_token}`,
            "ChatGPT-Account-Id": credential.account_id,
            originator: "codex_cli_rs",
          },
        },
        "OpenAI OAuth",
        signal,
      );
      const ids = this.readStringArray(payload, "models", "slug");
      const rows = (payload as { models: Array<Record<string, unknown>> }).models;
      available = ids.map((id) => {
        const row = rows.find((item) => item.slug === id)!;
        const descriptions: Array<[string, string]> = [];
        const efforts = Array.isArray(row.supported_reasoning_levels)
          ? row.supported_reasoning_levels.flatMap((value) => {
              const effort =
                typeof value === "object" && value !== null
                  ? (value as Record<string, unknown>).effort
                  : value;
              if (typeof effort !== "string") return [];
              const description = typeof value === "object" && value !== null
                ? (value as Record<string, unknown>).description : undefined;
              if (typeof description === "string") descriptions.push([effort, description]);
              return [effort];
            })
          : undefined;
        return {
          modelId: `openai/${id}`,
          name: typeof row.display_name === "string" ? row.display_name : id,
          ...(typeof row.context_window === "number" && row.context_window >= 0
            ? { limit: { context: row.context_window } }
            : {}),
          ...(efforts ? { reasoning_efforts: efforts } : {}),
          reasoning_effort_descriptions: Object.fromEntries(descriptions),
          ...(Array.isArray(row.input_modalities) &&
          row.input_modalities.every((value) => typeof value === "string")
            ? { modalities: { input: row.input_modalities as string[] } }
            : {}),
        };
      });
    } else if (gatewayId === "oauth/google") {
      const credential =
        candidate.kind === "oauth" && candidate.provider === "google"
          ? candidate.credential
          : auth.oauth.google;
      if (!credential || credential.expires_at <= Date.now())
        throw new Error("Google session is unavailable or expired. Run /gateway to sign in.");
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const models = await fetchGoogleModels(credential, this.fetchImpl,
        signal ? AbortSignal.any([signal, timeout]) : timeout);
      // Provider metadata overrides exact models.dev matches; missing capabilities stay unknown.
      available = models.map(([id, model]) => ({
        modelId: `google/${id}`, name: model.displayName || id,
        ...(model.supportsThinking === undefined ? {} : { reasoning: model.supportsThinking }),
        ...(model.supportsImages === undefined ? {} : { attachment: model.supportsImages }),
        ...(model.maxOutputTokens === undefined ? {} : { limit: { output: model.maxOutputTokens } }),
      }));
      if (!available.length)
        throw new Error("Google did not return any models for this account.");
    } else if (gatewayId === "oauth/anthropic") {
      const credential =
        candidate.kind === "oauth" && candidate.provider === "anthropic"
          ? candidate.credential
          : auth.oauth.anthropic;
      if (!credential || credential.expires_at <= Date.now())
        throw new Error("Anthropic session is unavailable or expired. Run /gateway to sign in.");
      canonicalModelIds = [];
      const cursors = new Set<string>();
      let after = "";
      while (true) {
        const payload = await this.fetchJson(
          `${ANTHROPIC_BASE_URL}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
          {
            headers: {
              ...ANTHROPIC_OAUTH_HEADERS,
              authorization: `Bearer ${credential.access_token}`,
            },
          },
          "Anthropic OAuth",
          signal,
        );
        canonicalModelIds.push(
          ...this.readStringArray(payload, "data", "id").map((id) => `anthropic/${id}`),
        );
        const page = payload as { has_more?: boolean; last_id?: string };
        if (!page.has_more) break;
        if (typeof page.last_id !== "string" || !page.last_id || cursors.has(page.last_id))
          throw new Error("Invalid Anthropic model catalog pagination.");
        after = page.last_id;
        cursors.add(after);
      }
    } else if (gatewayId === "oauth/xai") {
      const credential =
        candidate.kind === "oauth" && candidate.provider === "xai"
          ? candidate.credential
          : auth.oauth.xai;
      if (!credential || credential.expires_at <= Date.now())
        throw new Error("Grok Build session is unavailable or expired. Run /gateway to sign in.");
      const payload = await this.fetchJson(
        `${GROK_BUILD_BASE_URL}/models`,
        {
          headers: { ...GROK_BUILD_HEADERS, authorization: `Bearer ${credential.access_token}` },
        },
        "Grok Build",
        signal,
      );
      canonicalModelIds = this.readStringArray(payload, "data", "id").map((id) => `xai/${id}`);
    } else {
      const local = gatewayId as LocalGatewayId;
      const configuredUrl =
        candidate.kind === "local" && candidate.gatewayId === local
          ? candidate.baseUrl
          : config.gateway_options[local]?.base_url;
      if (!configuredUrl) throw new Error(`Missing endpoint for ${gatewayId}.`);
      if (local === "local/ollama") {
        const baseUrl = normalizeOllamaBaseUrl(configuredUrl);
        const payload = await this.fetchJson(`${baseUrl}/api/tags`, {}, "Ollama", signal);
        canonicalModelIds = this.readStringArray(payload, "models", "name").map(
          (id) => `ollama/${id}`,
        );
      } else {
        const baseUrl = normalizeLMStudioBaseUrl(configuredUrl);
        const payload = await this.fetchJson(`${baseUrl}/models`, {}, "LM Studio", signal);
        canonicalModelIds = this.readStringArray(payload, "data", "id").map(
          (id) => `lmstudio/${id}`,
        );
      }
    }

    const view = await this.dependencies.catalog.preview(
      gatewayId,
      available ??
        canonicalModelIds?.map((modelId) => ({
          modelId,
          name: modelId.slice(modelId.indexOf("/") + 1),
        })),
    );
    signal?.throwIfAborted();
    if (candidate.kind === "stored") {
      if (!sourceKey || (await this.sourceKey(gatewayId)) !== sourceKey)
        throw new Error("Gateway credential changed. Run /gateway again.");
      if (persist && !(await this.dependencies.catalog.publish(gatewayId, sourceKey, view)))
        throw new Error("Gateway credential changed. Run /gateway again.");
    }
    return view;
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
      signal?.throwIfAborted();
      if (status === 401 || status === 403) {
        throw new Error(`${label} credential was rejected.`);
      }
      if (status === 429 || status === 402) {
        throw new Error(`${label} quota or rate limit reached.`);
      }
      if (status !== undefined)
        throw new Error(`${label} model catalog request failed (HTTP ${status}).`);
      throw new Error(`${label} gateway is unavailable or timed out.`);
    }
  }

  private readStringArray(payload: unknown, collectionKey: string, valueKey: string): string[] {
    if (payload === null || typeof payload !== "object")
      throw new Error("Invalid gateway model catalog.");
    const collection = (payload as Record<string, unknown>)[collectionKey];
    if (!Array.isArray(collection)) throw new Error("Invalid gateway model catalog.");
    return collection.flatMap((item) => {
      if (item === null || typeof item !== "object")
        throw new Error("Invalid gateway model catalog.");
      const value = (item as Record<string, unknown>)[valueKey];
      if (typeof value !== "string" || !value) throw new Error("Invalid gateway model catalog.");
      return [value];
    });
  }

  private async commit(selection: GatewaySelection, applyLive: boolean): Promise<GatewayState> {
    const pending = this.pending.get(selection.draftId);
    if (!pending) throw new Error("Gateway selection expired. Run /gateway again.");
    if (!containsModel(pending.draft.catalog, selection.model.modelId)) {
      throw new Error(
        `Model ${selection.model.modelId} is not available through ${pending.draft.gatewayId}.`,
      );
    }

    const gatewayId = pending.draft.gatewayId;
    this.assertGeneration(gatewayId, pending.generation);
    if ((await this.sourceKey(gatewayId)) !== pending.sourceKey)
      throw new Error("Gateway credential changed. Run /gateway again.");
    const previousConfig = await this.dependencies.config.read();
    const previousAuth = await this.dependencies.auth.read();
    const stagedAuth = structuredClone(previousAuth);
    const stagedConfig = structuredClone(previousConfig);
    if (pending.candidate.kind === "oauth") {
      Object.assign(stagedAuth.oauth, {
        [pending.candidate.provider]: pending.candidate.credential,
      });
    } else if (pending.candidate.kind === "api_key") {
      stagedAuth.api_keys[ApiKeyProviderSchema.parse(gatewayId.slice("api_key/".length))] = {
        api_key: pending.candidate.apiKey,
      };
    } else if (pending.candidate.kind === "local") {
      stagedConfig.gateway_options[pending.candidate.gatewayId] = {
        base_url: pending.candidate.baseUrl,
      };
    }
    const expectedKey = ModelManager.sourceKey(gatewayId, {
      auth: stagedAuth,
      config: stagedConfig,
    });
    const adapter = this.dependencies.adapters.get(pending.draft.gatewayId);
    const localId = pending.draft.gatewayId.startsWith("local/")
      ? (pending.draft.gatewayId as LocalGatewayId)
      : undefined;
    const previousBaseUrl = localId ? adapter?.getBaseUrl?.(localId) : undefined;
    let liveApplyAttempted = false;

    try {
      await this.applyCandidateAuth(pending.candidate, pending, previousConfig);
      this.assertGeneration(gatewayId, pending.generation);
      if (pending.candidate.kind === "local") {
        adapter?.setBaseUrl?.(pending.candidate.baseUrl, pending.candidate.gatewayId);
      }
      await this.dependencies.config.update((current) => ({
        ...current,
        gateway: pending.draft.gatewayId,
        model: selection.model.modelId,
        model_config: selection.model.reasoningEffort
          ? { ...current.model_config, reasoning_effort: selection.model.reasoningEffort }
          : {},
        gateway_options:
          pending.candidate.kind === "local"
            ? {
                ...current.gateway_options,
                [pending.candidate.gatewayId]: { base_url: pending.candidate.baseUrl },
              }
            : current.gateway_options,
      }));
      if (applyLive && this.dependencies.applyLiveSelection) {
        liveApplyAttempted = true;
        await this.dependencies.applyLiveSelection(pending.draft.gatewayId, selection.model);
      }
      this.assertGeneration(gatewayId, pending.generation);
      if (
        !expectedKey ||
        !(await this.dependencies.catalog.publish(gatewayId, expectedKey, pending.draft.catalog))
      )
        throw new Error("Gateway credential changed.");
      this.assertGeneration(gatewayId, pending.generation);
      return { gatewayId: pending.draft.gatewayId, model: { ...selection.model } };
    } catch (originalError) {
      const rollbackErrors: unknown[] = [];
      const restore = async (action: () => unknown | Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          rollbackErrors.push(error);
        }
      };
      await restore(() =>
        this.dependencies.auth.update((current) => {
          const [, provider] = gatewayId.split("/");
          const branch = gatewayId.startsWith("oauth/") ? "oauth" : "api_keys";
          if (pending.candidate.kind === "local" || pending.candidate.kind === "stored")
            return current;
          const expected =
            pending.candidate.kind === "oauth"
              ? pending.candidate.credential
              : { api_key: pending.candidate.apiKey };
          if (
            JSON.stringify((current[branch] as Record<string, unknown>)[provider!]) !==
            JSON.stringify(expected)
          )
            return current;
          const next = structuredClone(current);
          const target = next[branch] as Record<string, unknown>;
          const old = (previousAuth[branch] as Record<string, unknown>)[provider!];
          if (old === undefined) delete target[provider!];
          else target[provider!] = old;
          return next;
        }),
      );
      await restore(() =>
        this.dependencies.config.update((current) =>
          current.gateway !== gatewayId || current.model !== selection.model.modelId
            ? current
            : {
                ...current,
                gateway: previousConfig.gateway,
                model: previousConfig.model,
                model_config: previousConfig.model_config,
                gateway_options: localId
                  ? {
                      ...current.gateway_options,
                      [localId]: previousConfig.gateway_options[localId],
                    }
                  : current.gateway_options,
              },
        ),
      );
      if (previousBaseUrl && localId)
        await restore(() => adapter?.setBaseUrl?.(previousBaseUrl, localId));
      const previousRunnable = RunnableConfigSchema.safeParse(previousConfig);
      if (liveApplyAttempted && previousRunnable.success && this.dependencies.applyLiveSelection) {
        await restore(() =>
          this.dependencies.applyLiveSelection!(previousRunnable.data.gateway, {
            modelId: previousRunnable.data.model,
            ...(previousRunnable.data.model_config.reasoning_effort
              ? { reasoningEffort: previousRunnable.data.model_config.reasoning_effort }
              : {}),
          }),
        );
      }
      if (rollbackErrors.length) {
        throw new AggregateError(
          [originalError, ...rollbackErrors],
          "Gateway switch failed and rollback failed; configuration may be inconsistent. Run /gateway to recover.",
        );
      }
      throw new Error("Gateway switch failed; the previous configuration is still active.", {
        cause: originalError,
      });
    } finally {
      this.discardDraft(selection.draftId);
    }
  }

  private async applyCandidateAuth(
    candidate: PendingCandidate,
    pending: PendingDraft,
    config: CubeConfigDocument,
  ): Promise<void> {
    const check = (current: CubeAuth) => {
      this.assertGeneration(pending.draft.gatewayId, pending.generation);
      if (
        ModelManager.sourceKey(pending.draft.gatewayId, { auth: current, config }) !==
        pending.sourceKey
      )
        throw new Error("Gateway credential changed. Run /gateway again.");
      return current;
    };
    if (candidate.kind === "api_key") {
      const provider = ApiKeyProviderSchema.parse(candidate.gatewayId.slice("api_key/".length));
      await this.dependencies.auth.update((stored) =>
        CubeAuthSchema.parse({
          ...check(stored),
          api_keys: {
            ...stored.api_keys,
            [provider]: { api_key: candidate.apiKey },
          },
        }),
      );
    } else if (candidate.kind === "oauth") {
      await this.dependencies.auth.update((stored) =>
        CubeAuthSchema.parse({
          ...check(stored),
          oauth: { ...stored.oauth, [candidate.provider]: candidate.credential },
        }),
      );
    }
  }
}
