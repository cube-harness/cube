import type { Home } from "./home.js";
import { ModelCatalogStore, ConfigStore } from "./store/store.js";
import type { ModelCatalog, CatalogModel } from "./schemas/model-catalog.schema.js";
import {
  providers as snapshotProviders,
  models as canonicalModels,
} from "@opencode-ai/models/snapshot";
import { Models } from "@opencode-ai/models";

export interface ProviderCatalogItem {
  id: string;
  name: string;
  models: CatalogModel[];
}

const isValidApiKey = (val?: string): boolean => {
  if (!val) return false;
  const clean = val.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!clean || clean.length < 5) return false;
  const lower = clean.toLowerCase();
  if (
    lower.includes("your-api-key") ||
    lower.includes("your_api_key") ||
    lower.includes("your-key") ||
    lower.includes("your_key") ||
    lower.includes("placeholder") ||
    lower.includes("todo") ||
    lower === "none" ||
    lower === "null" ||
    lower === "undefined"
  ) {
    return false;
  }
  return true;
};

export class ModelManager {
  constructor(private readonly home: Home) {}

  /**
   * Helper to check if a provider has active credentials in process.env.
   */
  private hasCredentials(envVars?: string[]): boolean {
    if (!envVars || envVars.length === 0) return false;
    return envVars.some((key) => isValidApiKey(process.env[key]));
  }

  /**
   * Resolves capabilities and limits for an Ollama model by matching against
   * canonical open-weights model metadata in @opencode-ai/models or model details.
   */
  private resolveOllamaModelMetadata(
    name: string,
    details?: { family?: string; parameter_size?: string },
  ): Omit<CatalogModel, "provider" | "modelId"> {
    const normalized = name.toLowerCase().replace(/[:_]/g, "-");
    const canonical = Object.entries(canonicalModels).find(
      ([id]) =>
        id.toLowerCase() === normalized ||
        normalized.startsWith(id.toLowerCase()) ||
        id.toLowerCase().startsWith(normalized),
    )?.[1];

    if (canonical) {
      return {
        name: canonical.name || name,
        family: canonical.family || details?.family,
        reasoning: Boolean(canonical.reasoning),
        tool_call: Boolean(canonical.tool_call),
        structured_output: Boolean(canonical.structured_output),
        attachment: Boolean(canonical.attachment),
        open_weights: true,
        limit: {
          context: canonical.limit?.context ?? 32768,
          output: canonical.limit?.output ?? 8192,
          input: canonical.limit?.input,
        },
        modalities: {
          input: (canonical.modalities?.input as string[]) ?? ["text"],
          output: (canonical.modalities?.output as string[]) ?? ["text"],
        },
      };
    }

    const family = details?.family?.toLowerCase() || "";
    const isVision = ["llava", "vision", "clip", "mllama"].some((f) =>
      family.includes(f) || name.toLowerCase().includes(f),
    );
    const isReasoning = ["r1", "reason", "think"].some((f) =>
      family.includes(f) || name.toLowerCase().includes(f),
    );
    const hasTools = ["qwen", "llama", "mistral", "command-r"].some((f) =>
      family.includes(f) || name.toLowerCase().includes(f),
    );

    return {
      name,
      family: details?.family || "ollama",
      reasoning: isReasoning,
      tool_call: hasTools,
      structured_output: true,
      attachment: isVision,
      open_weights: true,
      limit: {
        context: 32768,
        output: 8192,
      },
      modalities: {
        input: isVision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
    };
  }

  /**
   * Queries Ollama /api/tags to get the list of models actually pulled locally.
   */
  private async fetchOllamaModels(baseUrl: string): Promise<CatalogModel[]> {
    try {
      const cleanUrl = baseUrl.replace(/\/api\/?$/, "").replace(/\/+$/, "");
      const res = await fetch(`${cleanUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{
          name: string;
          details?: { family?: string; parameter_size?: string };
        }>;
      };
      if (!data.models || !Array.isArray(data.models)) return [];

      return data.models.map((m) => {
        const meta = this.resolveOllamaModelMetadata(m.name, m.details);
        return {
          provider: "ollama",
          modelId: `ollama/${m.name}`,
          ...meta,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Detects all provider IDs that have valid credentials in process.env or local config.
   * Leverages provider.env from @opencode-ai/models for cloud providers and OLLAMA_BASE_URL for local Ollama.
   */
  async getActiveProviderIds(): Promise<string[]> {
    const config = await ConfigStore(this.home).read().catch(() => null);
    const active: string[] = [];

    // 1. Check Ollama (Local)
    const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;
    if (ollamaUrl) {
      active.push("ollama");
    }

    // 2. Check Cloud Providers from @opencode-ai/models
    for (const [providerId, provider] of Object.entries(snapshotProviders)) {
      const envList = (provider as { env?: string[] }).env || [];
      if (this.hasCredentials(envList)) {
        active.push(providerId);
      }
    }

    return active.sort();
  }

  /**
   * Gets the catalog. Uses cached model-catalog.json if active providers match,
   * otherwise rebuilds catalog and saves.
   */
  async getCatalog(): Promise<ModelCatalog> {
    const activeProviderIds = await this.getActiveProviderIds();
    const store = ModelCatalogStore(this.home);

    try {
      const cached = await store.read();
      if (cached && cached.models) {
        const cachedProviders = Array.from(
          new Set(cached.models.map((m) => m.provider)),
        ).sort();

        // If cached providers match current active providers, return cache instantly (0ms)
        if (
          cachedProviders.length === activeProviderIds.length &&
          cachedProviders.every((p, i) => p === activeProviderIds[i])
        ) {
          return cached;
        }
      }
    } catch {
      // Cache missing or corrupted, rebuild
    }

    return this.refreshCatalog();
  }

  /**
   * Rebuilds catalog for active providers from @opencode-ai/models and local Ollama,
   * writes to model-catalog.json, and returns the ModelCatalog.
   */
  async refreshCatalog(): Promise<ModelCatalog> {
    let providers: Record<string, any>;
    try {
      const client = Models.make();
      providers = await client.providers({ signal: AbortSignal.timeout(5_000) });
    } catch {
      providers = snapshotProviders as Record<string, any>;
    }

    const ollamaUrl = process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST;

    const models: CatalogModel[] = [];

    // 1. Local Ollama Models via /api/tags (Strictly genuine pulled models only)
    if (ollamaUrl) {
      const localModels = await this.fetchOllamaModels(ollamaUrl);
      if (localModels.length > 0) {
        models.push(...localModels);
      }
    }

    // 2. Cloud Providers from @opencode-ai/models
    for (const [providerId, provider] of Object.entries(providers)) {
      if (providerId === "ollama") continue;
      if (!this.hasCredentials(provider.env)) continue;
      for (const [modelId, model] of Object.entries<any>(provider.models || {})) {
        models.push({
          provider: providerId,
          modelId: `${providerId}/${modelId}`,
          name: model.name || modelId,
          family: model.family,
          reasoning: Boolean(model.reasoning),
          tool_call: Boolean(model.tool_call),
          structured_output: Boolean(model.structured_output),
          attachment: Boolean(model.attachment),
          open_weights: Boolean(model.open_weights),
          limit: {
            context: model.limit?.context ?? 128000,
            output: model.limit?.output ?? 8192,
            input: model.limit?.input,
          },
          modalities: {
            input: model.modalities?.input ?? ["text"],
            output: model.modalities?.output ?? ["text"],
          },
          cost: model.cost
            ? {
                input: model.cost.input ?? 0,
                output: model.cost.output ?? 0,
                cache_read: model.cost.cache_read,
                cache_write: model.cost.cache_write,
              }
            : undefined,
        });
      }
    }

    const catalog: ModelCatalog = { updatedAt: new Date().toISOString(), models };
    await ModelCatalogStore(this.home).write(catalog);
    return catalog;
  }

  /**
   * Returns models grouped by provider for the TUI picker.
   */
  async getProvidersWithModels(): Promise<ProviderCatalogItem[]> {
    const catalog = await this.getCatalog();
    const grouped = new Map<string, CatalogModel[]>();

    for (const model of catalog.models) {
      if (!grouped.has(model.provider)) {
        grouped.set(model.provider, []);
      }
      grouped.get(model.provider)!.push(model);
    }

    const result: ProviderCatalogItem[] = [];
    for (const [providerId, models] of grouped.entries()) {
      if (providerId === "ollama") {
        result.push({
          id: "ollama",
          name: "Ollama (Local)",
          models,
        });
        continue;
      }

      const providerInfo = (snapshotProviders as Record<string, any>)[providerId];
      result.push({
        id: providerId,
        name: providerInfo?.name || providerId.toUpperCase(),
        models,
      });
    }

    return result;
  }
}
