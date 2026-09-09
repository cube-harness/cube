import {
  ModelsDevGateway,
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type MastraModelGatewayInterface,
  type ProviderConfig,
} from "@mastra/core/llm";
import { createOllama } from "ollama-ai-provider-v2";
import {
  DEFAULT_OLLAMA_URL,
  DEFAULT_LMSTUDIO_URL,
  type LocalGatewayId,
  type RunnableCubeConfig,
} from "@cube/workspace";

export type LocalGatewayOptions = {
  gatewayOptions?: RunnableCubeConfig["gateway_options"];
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export const normalizeOllamaBaseUrl = (baseUrl = DEFAULT_OLLAMA_URL): string => {
  const normalized = baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama base URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
};

export const normalizeLMStudioBaseUrl = (baseUrl = DEFAULT_LMSTUDIO_URL): string => {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/v1")) normalized = `${normalized}/v1`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LM Studio base URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
};

export class LocalGateway implements MastraModelGatewayInterface {
  readonly id = "cube-local";
  readonly name = "Cube local";
  private readonly urls: Record<LocalGatewayId, string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: LocalGatewayOptions = {}) {
    this.urls = {
      "local/ollama": normalizeOllamaBaseUrl(options.gatewayOptions?.["local/ollama"]?.base_url),
      "local/lmstudio": normalizeLMStudioBaseUrl(
        options.gatewayOptions?.["local/lmstudio"]?.base_url,
      ),
    };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  }

  handlesModel(modelId: string): boolean {
    return modelId.startsWith("ollama/") || modelId.startsWith("lmstudio/");
  }

  setBaseUrl(baseUrl: string, gatewayId: LocalGatewayId): void {
    this.urls[gatewayId] =
      gatewayId === "local/ollama"
        ? normalizeOllamaBaseUrl(baseUrl)
        : normalizeLMStudioBaseUrl(baseUrl);
  }

  getBaseUrl(gatewayId: LocalGatewayId): string {
    return this.urls[gatewayId];
  }

  async listCanonicalModelIds(gatewayId: LocalGatewayId): Promise<string[]> {
    const ollama = gatewayId === "local/ollama";
    const label = ollama ? "Ollama" : "LM Studio";
    const baseUrl = this.urls[gatewayId];
    let payload: Record<string, unknown>;
    try {
      const response = await this.fetchImpl(`${baseUrl}${ollama ? "/api/tags" : "/models"}`, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) throw new Error("request rejected");
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`${label} is unavailable at ${baseUrl}.`);
    }
    const models = payload?.[ollama ? "models" : "data"];
    if (!Array.isArray(models)) throw new Error(`${label} returned an invalid model catalog.`);
    return models.flatMap((model: unknown) => {
      if (!model || typeof model !== "object") return [];
      const id = (model as Record<string, unknown>)[ollama ? "name" : "id"];
      return typeof id === "string" && id.length > 0
        ? [`${ollama ? "ollama" : "lmstudio"}/${id}`]
        : [];
    });
  }

  private providerConfig(gatewayId: LocalGatewayId, models: string[]): ProviderConfig {
    const ollama = gatewayId === "local/ollama";
    return {
      name: ollama ? "Ollama" : "LM Studio",
      apiKeyEnvVar: ollama ? "CUBE_OLLAMA_LOCAL" : "CUBE_LMSTUDIO_LOCAL",
      gateway: this.id,
      url: `${this.urls[gatewayId]}${ollama ? "/api" : ""}`,
      ...(!ollama ? { npm: "@ai-sdk/openai-compatible" } : {}),
      models,
    };
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const providers = await Promise.all(
      (Object.keys(this.urls) as LocalGatewayId[]).map(async (id) => {
        // A stopped local server must not hide models from the other server.
        const canonical = await this.listCanonicalModelIds(id).catch(() => []);
        const provider = id.slice("local/".length);
        return [
          provider,
          this.providerConfig(
            id,
            canonical.map((model) => model.slice(provider.length + 1)),
          ),
        ];
      }),
    );
    return Object.fromEntries(providers);
  }

  buildUrl(modelId: string): string {
    const canonical = modelId.startsWith(`${this.id}/`)
      ? modelId.slice(this.id.length + 1)
      : modelId;
    const provider = canonical.split("/")[0];
    if (provider !== "ollama" && provider !== "lmstudio")
      throw new Error("Unknown local model provider.");
    return this.providerConfig(`local/${provider}`, []).url!;
  }

  getApiKey(): Promise<string> {
    return Promise.resolve("cube-local");
  }

  resolveAuth(_request: GatewayAuthRequest): GatewayAuthResult {
    return { apiKey: "cube-local", source: "gateway" };
  }

  resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> | GatewayLanguageModel {
    if (args.providerId === "ollama") {
      return createOllama({ baseURL: `${this.urls["local/ollama"]}/api`, fetch: this.fetchImpl })(
        args.modelId,
      );
    }
    if (args.providerId !== "lmstudio") throw new Error("Unknown local model provider.");
    return new ModelsDevGateway({
      lmstudio: this.providerConfig("local/lmstudio", [args.modelId]),
    }).resolveLanguageModel(args);
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
