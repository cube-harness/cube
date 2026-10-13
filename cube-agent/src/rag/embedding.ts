import { ModelRouterEmbeddingModel, EMBEDDING_MODELS, getProviderConfig } from "@mastra/core/llm";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { ApiKeyProviderSchema, MEMORY_RETRIEVAL_LIMITS, memoryHash, type AuthStore, type CubeConfig, type MemoryRetrievalConfig } from "@cube/workspace";
import { normalizeOllamaBaseUrl, normalizeLMStudioBaseUrl } from "../gateways/local.gateway.js";

const nativeOptions = z.record(z.string(), z.record(z.string(), z.json()));
export type EmbeddingProfile = {
  id: string;
  config: MemoryRetrievalConfig;
  endpoint: string;
};
export type MemoryEmbedding = {
  profile: EmbeddingProfile;
  batchSize: number;
  embed(values: string[], kind: "document" | "query", signal: AbortSignal): Promise<number[][]>;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",") + "}";
  return JSON.stringify(value);
}
export function validateEmbeddings(vectors: number[][], count: number, dimension: number | null) {
  if (vectors.length !== count || vectors.some(vector => !Array.isArray(vector) || !vector.length || vector.length > MEMORY_RETRIEVAL_LIMITS.max_dimensions ||
    vector.length !== (dimension ?? vectors[0]?.length) || !vector.every(value => Number.isFinite(Math.fround(value))) || !vector.some(value => Math.fround(value) !== 0)))
    throw new Error("Embedding provider returned invalid vectors or dimensions");
  return vectors;
}

export async function resolveMemoryEmbedding(options: {
  config: MemoryRetrievalConfig;
  auth: Pick<AuthStore, "getApiKey">;
  localOptions: CubeConfig["gateway_options"];
}): Promise<MemoryEmbedding> {
  const config = structuredClone(options.config);
  if (!config.enabled || !config.model) throw new Error("Memory retrieval embedding is disabled");
  const split = config.model.indexOf("/");
  const provider = config.model.slice(0, split), modelId = config.model.slice(split + 1);
  const ollama = provider === "ollama", lmstudio = provider === "lmstudio";
  const endpoint = ollama ? `${normalizeOllamaBaseUrl(options.localOptions["local/ollama"]?.base_url)}/api`
    : lmstudio ? normalizeLMStudioBaseUrl(options.localOptions["local/lmstudio"]?.base_url)
    : getProviderConfig(provider)?.url ?? `native:${provider}`;
  const parsedUrl = endpoint.startsWith("native:") ? undefined : new URL(endpoint);
  if (parsedUrl && (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash))
    throw new Error("Embedding endpoint must not contain credentials, query or fragment");
  async function model() {
    if (ollama) return createOllama({ baseURL: endpoint }).embedding(modelId, { truncate: false, ...(config.dimensions === null ? {} : { dimensions: config.dimensions }) });
    const apiKey = lmstudio ? "cube-local" : await options.auth.getApiKey(ApiKeyProviderSchema.parse(provider));
    if (!apiKey) throw new Error(`Missing API key for memory retrieval: ${provider}`);
    return new ModelRouterEmbeddingModel({ providerId: provider, modelId, apiKey, ...(lmstudio ? { url: endpoint } : {}) });
  }
  const initial = await model();
  const batchSize = Math.min(16, (await initial.maxEmbeddingsPerCall) ?? 16);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid native embedding batch limit");
  const known = EMBEDDING_MODELS.find(item => item.provider === provider && (item.id === modelId || item.id === config.model));
  const profile: EmbeddingProfile = { config, endpoint,
    id: memoryHash(canonical({ ...config, endpoint, policy: "recursive-offset-mask-1" })),
  };
  return {
    profile, batchSize,
    async embed(values, kind, signal) {
      signal.throwIfAborted();
      if (!values.length || values.length > batchSize) throw new Error("Invalid embedding batch size");
      const providerOptions = nativeOptions.parse(config.provider_options[kind]);
      const namespace = provider === "google" ? "google" : provider === "openai" ? "openai" : ollama ? "ollama" : "openaiCompatible";
      if (config.dimensions !== null) providerOptions[namespace] = { ...providerOptions[namespace], [provider === "google" ? "outputDimensionality" : "dimensions"]: config.dimensions };
      if (ollama) providerOptions.ollama = { ...providerOptions.ollama, truncate: false };
      const prefix = kind === "document" ? config.document_prefix : config.query_prefix;
      const input = values.map(value => prefix + value);
      // Conservative UTF-8 byte ceiling when a native input-token limit is known.
      // ponytail: no cross-provider tokenizer; users can lower max_chars for unknown limits.
      if (known && input.some(value => Buffer.byteLength(value) > known.maxInputTokens)) throw new Error("Memory embedding input exceeds its conservative model limit; lower chunk.max_chars");
      const result = await (await model()).doEmbed({ values: input, abortSignal: signal, providerOptions });
      if ("warnings" in result && Array.isArray(result.warnings) && result.warnings.length)
        throw new Error("Embedding provider reported unsupported options");
      signal.throwIfAborted();
      return validateEmbeddings(result.embeddings, values.length, config.dimensions);
    },
  };
}
