import { createHash } from "node:crypto";
import { ZodError } from "zod";
import { providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import { Models } from "@opencode-ai/models";
import type { HomeManager } from "./home-manager.js";
import { ConfigStore, ModelCatalogStore } from "./store/store.js";
import { AuthStore } from "./store/auth.store.js";
import { CubeAuthSchema, type CubeAuth } from "./schemas/auth.schema.js";
import { ConfigSchema, GatewayIdSchema, type CubeConfigDocument, type GatewayId, type LocalGatewayId } from "./schemas/config.schema.js";
import { API_KEY_PROVIDERS } from "./constants.js";
import { CatalogModelSchema, ModelCatalogSchema, ModelCatalogCacheSchema,
  type CatalogModel, type ModelCatalog, type ModelCatalogCache, type ModelCatalogEntry } from "./schemas/model-catalog.schema.js";

type RawModel = Partial<Omit<CatalogModel, "modelId" | "reasoning_efforts">> & {
  reasoning_options?: Array<{ type?: string; values?: unknown[] }>;
};
type RawProvider = { name?: string; models?: Record<string, RawModel> };
export type CanonicalProviderSource = () => Promise<Record<string, RawProvider>>;
export type CatalogContext = { auth: CubeAuth; config: CubeConfigDocument };
export type ModelManagerOptions = {
  readContext?: () => Promise<CatalogContext>;
  writeCatalog?: (value: ModelCatalogCache) => Promise<void>;
};

const loadCanonicalProviders: CanonicalProviderSource = async () => {
  try {
    return await Models.make().providers({ signal: AbortSignal.timeout(5_000) });
  } catch {
    return snapshotProviders as Record<string, RawProvider>;
  }
};

const parts = (gatewayId: GatewayId) => {
  const [strategy, provider] = GatewayIdSchema.parse(gatewayId).split("/");
  return { strategy: strategy as keyof ModelCatalogCache, provider: provider! };
};

const reasoningEfforts = (model: RawModel): string[] | undefined => {
  const effort = model.reasoning_options?.find(option => option.type === "effort" && Array.isArray(option.values));
  if (effort?.values) return effort.values.flatMap(value => value === null ? ["none"] : typeof value === "string" ? [value] : []);
  if (model.reasoning_options?.some(option => option.type === "toggle")) return ["none", "default"];
  return undefined;
};

const toCatalogModel = (provider: string, id: string, raw: RawModel): CatalogModel =>
  CatalogModelSchema.parse({
    modelId: `${provider}/${id}`,
    name: raw.name || id,
    ...Object.fromEntries(["family", "reasoning", "tool_call", "structured_output", "attachment",
      "open_weights", "limit", "modalities", "cost"].flatMap(key =>
        raw[key as keyof RawModel] === undefined ? [] : [[key, raw[key as keyof RawModel]]])),
    ...(reasoningEfforts(raw) ? { reasoning_efforts: reasoningEfforts(raw) } : {}),
    ...(raw.limit ? { limit: CatalogModelSchema.shape.limit.unwrap().strip().parse(raw.limit) } : {}),
    ...(raw.modalities ? { modalities: CatalogModelSchema.shape.modalities.unwrap().strip().parse(raw.modalities) } : {}),
    ...(raw.cost ? { cost: CatalogModelSchema.shape.cost.unwrap().strip().parse(raw.cost) } : {}),
  });

export class ModelManager {
  // ponytail: per-home serialization within one process; external writers reconcile on the next read.
  private static readonly updates = new Map<string, Promise<unknown>>();

  constructor(
    private readonly home: HomeManager,
    private readonly source: CanonicalProviderSource = loadCanonicalProviders,
    private readonly options: ModelManagerOptions = {},
  ) {}

  static sourceKey(gatewayId: GatewayId, context: CatalogContext): string | undefined {
    const { strategy, provider } = parts(gatewayId);
    const auth = CubeAuthSchema.parse(context.auth);
    const config = ConfigSchema.parse(context.config);
    let identity: string[];
    if (strategy === "api_key") {
      const key = auth.api_keys[provider as keyof typeof auth.api_keys]?.api_key;
      if (!key) return undefined;
      identity = [key];
    } else if (strategy === "oauth") {
      const credential = auth.oauth[provider as keyof typeof auth.oauth];
      if (!credential) return undefined;
      identity = ["account_id" in credential ? credential.account_id : "", credential.refresh_token];
      if ("project_id" in credential) identity.push(credential.project_id);
    } else {
      const endpoint = config.gateway_options[gatewayId as LocalGatewayId]?.base_url;
      if (!endpoint) return undefined;
      let normalized = endpoint.trim().replace(/\/+$/, "");
      if (provider === "ollama") normalized = normalized.replace(/\/api$/, "");
      else if (!normalized.endsWith("/v1")) normalized += "/v1";
      const url = new URL(normalized);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid local gateway endpoint.");
      identity = [url.toString().replace(/\/$/, "")];
    }
    return createHash("sha256").update(JSON.stringify([gatewayId, ...identity])).digest("hex");
  }

  private async readContext(): Promise<CatalogContext> {
    const context = this.options.readContext ? await this.options.readContext() : {
      auth: await new AuthStore(this.home).read(), config: await ConfigStore(this.home).read(),
    };
    return { auth: CubeAuthSchema.parse(context.auth), config: ConfigSchema.parse(context.config) };
  }

  private async readCache(): Promise<ModelCatalogCache> {
    try { return await ModelCatalogStore(this.home).read(); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof ZodError || (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { api_key: {}, oauth: {}, local: {} };
      }
      throw new Error("Cube model catalog could not be read.", { cause: error });
    }
  }

  private async writeCache(cache: ModelCatalogCache): Promise<void> {
    try {
      const valid = ModelCatalogCacheSchema.parse(cache);
      if (this.options.writeCatalog) await this.options.writeCatalog(valid);
      else await ModelCatalogStore(this.home).write(valid);
    } catch (error) {
      throw new Error("Cube model catalog could not be updated. Run /gateway to retry.", { cause: error });
    }
  }

  private queued<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.home.getModelCatalogPath();
    const next = (ModelManager.updates.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    ModelManager.updates.set(key, next);
    void next.finally(() => {
      if (ModelManager.updates.get(key) === next) ModelManager.updates.delete(key);
    }).catch(() => undefined);
    return next;
  }

  private branch(cache: ModelCatalogCache, gatewayId: GatewayId): Record<string, ModelCatalogEntry | undefined> {
    return cache[parts(gatewayId).strategy];
  }

  getCatalog(gatewayId: GatewayId): Promise<ModelCatalog | undefined> {
    return this.queued(async () => {
      const context = await this.readContext();
      const cache = await this.readCache();
      let changed = false;
      for (const [strategy, providers] of Object.entries(cache)) {
        for (const [provider, entry] of Object.entries(providers)) {
          if (entry.sourceKey !== ModelManager.sourceKey(`${strategy}/${provider}` as GatewayId, context)) {
            delete (providers as Record<string, ModelCatalogEntry>)[provider];
            changed = true;
          }
        }
      }
      if (changed) await this.writeCache(cache);
      const { provider } = parts(gatewayId);
      const entry = this.branch(cache, gatewayId)[provider];
      if (!entry) return undefined;
      const age = Date.now() - Date.parse(entry.updatedAt);
      if (age < 0 || age > this.home.getModelCatalogTtlMs()) return undefined;
      return { updatedAt: entry.updatedAt, providers: { [provider]: { name: entry.name, models: entry.models } } };
    });
  }

  async preview(gatewayId: GatewayId, available?: readonly CatalogModel[]): Promise<ModelCatalog> {
    const { strategy, provider } = parts(gatewayId);
    if (available === undefined && strategy !== "api_key") throw new Error("Gateway model discovery is required.");
    const canonical = (await this.source())[provider];
    const known = new Map(Object.entries(canonical?.models ?? {}).map(([id, raw]) => {
      const model = toCatalogModel(provider, id, raw);
      return [model.modelId, model] as const;
    }));
    const models = [...new Map((available ?? [...known.values()]).map(input => [input.modelId, input])).values()].map(input => {
      const model = CatalogModelSchema.parse(input);
      if (!model.modelId.startsWith(`${provider}/`) || model.modelId === `${provider}/`) throw new Error("Model does not belong to the selected gateway.");
      const base = known.get(model.modelId);
      const result: CatalogModel = { ...base, ...model,
        name: model.name === model.modelId.slice(provider.length + 1) ? base?.name ?? model.name : model.name,
      };
      for (const key of ["limit", "modalities", "cost"] as const) {
        if (base?.[key] || model[key]) Object.assign(result, { [key]: { ...base?.[key], ...model[key] } });
      }
      if (strategy === "oauth") delete result.cost;
      return CatalogModelSchema.parse(result);
    });
    return { updatedAt: new Date().toISOString(), providers: {
      [provider]: { name: canonical?.name ?? API_KEY_PROVIDERS[provider as keyof typeof API_KEY_PROVIDERS]
        ?? (provider === "lmstudio" ? "LM Studio" : "Ollama"), models },
    } };
  }

  publish(gatewayId: GatewayId, expectedSourceKey: string, view: ModelCatalog): Promise<boolean> {
    return this.queued(async () => {
      const context = await this.readContext();
      if (ModelManager.sourceKey(gatewayId, context) !== expectedSourceKey) return false;
      const { provider } = parts(gatewayId);
      const valid = ModelCatalogSchema.parse(view);
      if (Object.keys(valid.providers).length !== 1 || !valid.providers[provider]) throw new Error("Invalid gateway catalog view.");
      const cache = await this.readCache();
      this.branch(cache, gatewayId)[provider] = { ...valid.providers[provider], updatedAt: valid.updatedAt, sourceKey: expectedSourceKey };
      await this.writeCache(cache);
      return true;
    });
  }

  remove(gatewayId: GatewayId, expectedSourceKey?: string): Promise<void> {
    return this.queued(async () => {
      await this.readContext();
      const cache = await this.readCache();
      const branch = this.branch(cache, gatewayId);
      const { provider } = parts(gatewayId);
      if (!branch[provider] || (expectedSourceKey && branch[provider]?.sourceKey !== expectedSourceKey)) return;
      delete branch[provider];
      await this.writeCache(cache);
    });
  }
}
