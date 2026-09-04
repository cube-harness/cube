import {
  ModelsDevGateway,
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type MastraModelGatewayInterface,
  type ProviderConfig,
} from "@mastra/core/llm";
import { DEFAULT_LMSTUDIO_URL } from "@cube/workspace";
import type { LocalGatewayOptions } from "./ollama.gateway.js";

export const normalizeLMStudioBaseUrl = (baseUrl = DEFAULT_LMSTUDIO_URL): string => {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized.endsWith("/v1")) normalized = `${normalized}/v1`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("LM Studio base URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
};

export class LMStudioGateway implements MastraModelGatewayInterface {
  readonly id = "cube-local-lmstudio";
  readonly name = "Cube LM Studio";
  readonly gatewayId = "local/lmstudio" as const;
  private baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: LocalGatewayOptions = {}) {
    this.baseUrl = normalizeLMStudioBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeLMStudioBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async listCanonicalModelIds(): Promise<string[]> {
    let payload: { data?: Array<{ id?: unknown }> };
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json() as { data?: Array<{ id?: unknown }> };
    } catch {
      throw new Error(`LM Studio is unavailable at ${this.baseUrl}.`);
    }
    if (!Array.isArray(payload.data)) {
      throw new Error("LM Studio returned an invalid model catalog.");
    }
    return payload.data.flatMap((model) =>
      typeof model.id === "string" && model.id.length > 0
        ? [`lmstudio/${model.id}`]
        : [],
    );
  }

  private providerConfig(models: string[]): ProviderConfig {
    return {
      name: "LM Studio",
      apiKeyEnvVar: "CUBE_LMSTUDIO_LOCAL",
      gateway: this.id,
      url: this.baseUrl,
      npm: "@ai-sdk/openai-compatible",
      models,
    };
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const models = (await this.listCanonicalModelIds()).map((id) => id.slice("lmstudio/".length));
    return { lmstudio: this.providerConfig(models) };
  }

  buildUrl(): string {
    return this.baseUrl;
  }

  getApiKey(): Promise<string> {
    return Promise.resolve("lmstudio-local");
  }

  resolveAuth(_request: GatewayAuthRequest): GatewayAuthResult {
    return { apiKey: "lmstudio-local", source: "gateway" };
  }

  resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> | GatewayLanguageModel {
    const delegate = new ModelsDevGateway({
      lmstudio: this.providerConfig([args.modelId]),
    });
    return delegate.resolveLanguageModel(args);
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
