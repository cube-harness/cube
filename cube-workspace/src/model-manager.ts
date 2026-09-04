import type { HomeManager } from "./home-manager.js";
import { ModelCatalogStore } from "./store/store.js";
import type { CatalogModel, ModelCatalog } from "./schemas/model-catalog.schema.js";
import { providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import { Models } from "@opencode-ai/models";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  models: CatalogModel[];
}

type RawModel = {
  name?: string;
  family?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: unknown[] }>;
  tool_call?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  open_weights?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

type RawProvider = {
  name?: string;
  models?: Record<string, RawModel>;
};

export type CanonicalProviderSource = () => Promise<Record<string, RawProvider>>;

const loadCanonicalProviders: CanonicalProviderSource = async () => {
  try {
    return await Models.make().providers({ signal: AbortSignal.timeout(5_000) });
  } catch {
    return snapshotProviders as Record<string, RawProvider>;
  }
};

const reasoningEfforts = (model: RawModel): string[] | undefined => {
  if (model.reasoning_options?.length) {
    const effort = model.reasoning_options.find(
      (option) => option.type === "effort" && Array.isArray(option.values),
    );
    if (effort?.values) {
      return effort.values.map((value) => value === null ? "none" : String(value));
    }
    if (model.reasoning_options.some((option) => option.type === "toggle")) {
      return ["none", "default"];
    }
  }
  return model.reasoning ? ["none", "default"] : undefined;
};

const toCatalogModel = (
  providerId: string,
  modelId: string,
  model: RawModel,
): CatalogModel => ({
  modelId: `${providerId}/${modelId}`,
  name: model.name || modelId,
  ...(model.family ? { family: model.family } : {}),
  reasoning: Boolean(model.reasoning),
  ...(reasoningEfforts(model) ? { reasoning_efforts: reasoningEfforts(model) } : {}),
  tool_call: Boolean(model.tool_call),
  structured_output: Boolean(model.structured_output),
  attachment: Boolean(model.attachment),
  open_weights: Boolean(model.open_weights),
  limit: {
    context: model.limit?.context ?? 128_000,
    output: model.limit?.output ?? 8_192,
    ...(model.limit?.input === undefined ? {} : { input: model.limit.input }),
  },
  modalities: {
    input: model.modalities?.input ?? ["text"],
    output: model.modalities?.output ?? ["text"],
  },
  ...(model.cost
    ? {
        cost: {
          input: model.cost.input ?? 0,
          output: model.cost.output ?? 0,
          ...(model.cost.cache_read === undefined ? {} : { cache_read: model.cost.cache_read }),
          ...(model.cost.cache_write === undefined ? {} : { cache_write: model.cost.cache_write }),
        },
      }
    : {}),
});

export class ModelManager {
  constructor(
    private readonly home: HomeManager,
    private readonly source: CanonicalProviderSource = loadCanonicalProviders,
  ) {}

  async getCatalog(): Promise<ModelCatalog> {
    const store = ModelCatalogStore(this.home);
    try {
      const cached = await store.read();
      const age = Date.now() - new Date(cached.updatedAt).getTime();
      if (Number.isFinite(age) && age <= this.home.getModelCatalogTtlMs()) {
        return cached;
      }
    } catch {
      // Missing, stale-schema, or corrupt derived caches are rebuilt below.
    }
    return this.refreshCatalog();
  }

  async refreshCatalog(): Promise<ModelCatalog> {
    const providers = await this.source();
    const catalogProviders: ModelCatalog["providers"] = {};

    for (const [providerId, provider] of Object.entries(providers)) {
      if (providerId === "ollama" || providerId === "lmstudio") continue;
      const models = Object.entries(provider.models ?? {}).map(([modelId, model]) =>
        toCatalogModel(providerId, modelId, model),
      );
      if (models.length > 0) {
        catalogProviders[providerId] = {
          name: provider.name || providerId,
          models,
        };
      }
    }

    const catalog: ModelCatalog = {
      version: 2,
      updatedAt: new Date().toISOString(),
      providers: catalogProviders,
    };
    await ModelCatalogStore(this.home).write(catalog);
    return catalog;
  }

  async getProvidersWithModels(): Promise<ProviderCatalogItem[]> {
    const catalog = await this.getCatalog();
    return Object.entries(catalog.providers).map(([id, group]) => ({
      id,
      name: group.name,
      models: group.models,
    }));
  }
}
