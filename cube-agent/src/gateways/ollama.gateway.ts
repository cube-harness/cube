import type {
  GatewayAuthRequest,
  GatewayAuthResult,
  GatewayLanguageModel,
  MastraModelGatewayInterface,
  ProviderConfig,
} from "@mastra/core/llm";
import { createOllama } from "ollama-ai-provider-v2";
import { DEFAULT_OLLAMA_URL } from "@cube/workspace";

export type LocalGatewayOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export const normalizeOllamaBaseUrl = (baseUrl = DEFAULT_OLLAMA_URL): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Ollama base URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
};

export class OllamaGateway implements MastraModelGatewayInterface {
  readonly id = "cube-local-ollama";
  readonly name = "Cube Ollama";
  readonly gatewayId = "local/ollama" as const;
  private baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: LocalGatewayOptions = {}) {
    this.baseUrl = normalizeOllamaBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeOllamaBaseUrl(baseUrl);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  async listCanonicalModelIds(): Promise<string[]> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { models?: Array<{ name?: unknown }> };
      if (!Array.isArray(payload.models)) throw new Error("invalid payload");
      return payload.models.flatMap((model) =>
        typeof model.name === "string" && model.name.length > 0
          ? [`ollama/${model.name}`]
          : [],
      );
    } catch {
      throw new Error(`Ollama is unavailable at ${this.baseUrl}.`);
    }
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const models = (await this.listCanonicalModelIds()).map((id) => id.slice("ollama/".length));
    return {
      ollama: {
        name: "Ollama",
        apiKeyEnvVar: "CUBE_OLLAMA_LOCAL",
        gateway: this.id,
        url: `${this.baseUrl}/api`,
        models,
      },
    };
  }

  buildUrl(): string {
    return `${this.baseUrl}/api`;
  }

  getApiKey(): Promise<string> {
    return Promise.resolve("ollama-local");
  }

  resolveAuth(_request: GatewayAuthRequest): GatewayAuthResult {
    return { apiKey: "ollama-local", source: "gateway" };
  }

  resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): GatewayLanguageModel {
    return createOllama({
      baseURL: `${this.baseUrl}/api`,
      fetch: this.fetchImpl,
    })(args.modelId);
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
