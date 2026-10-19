import { ModelRouterEmbeddingModel, EMBEDDING_MODELS, getProviderConfig } from "@mastra/core/llm";
import { createOllama } from "ollama-ai-provider-v2";
import { ApiKeyProviderSchema, MEMORY_RETRIEVAL_LIMITS, memoryHash, type AuthStore, type CubeConfig, type MemoryRetrievalConfig } from "@cube/workspace";
import { normalizeOllamaBaseUrl, normalizeLMStudioBaseUrl } from "../gateways/local.gateway.js";

export type EmbeddingProfile = {
  id: string;
  documentPrefix: string;
  maxInputBytes: number;
};
export type MemoryEmbedding = {
  profile: EmbeddingProfile;
  batchSize: number;
  embed(values: string[], kind: "document" | "query", signal: AbortSignal): Promise<number[][]>;
};
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
    if (ollama) return createOllama({ baseURL: endpoint }).embedding(modelId, { truncate: false });
    const apiKey = lmstudio ? "cube-local" : await options.auth.getApiKey(ApiKeyProviderSchema.parse(provider));
    if (!apiKey) throw new Error(`Missing API key for memory retrieval: ${provider}`);
    return new ModelRouterEmbeddingModel({ providerId: provider, modelId, apiKey, ...(lmstudio ? { url: endpoint } : {}) });
  }
  const initial = await model();
  const batchSize = Math.min(16, (await initial.maxEmbeddingsPerCall) ?? 16);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid native embedding batch limit");
  const known = EMBEDDING_MODELS.find(item => item.provider === provider && (item.id === modelId || item.id === config.model));
  const nomic = /(?:^|\/)nomic-embed-text(?:-v1(?:\.5)?|:[^/]*)?$/.test(modelId);
  const e5 = /(?:^|\/)(?:multilingual-)?e5-(?:small|base|large)(?:-v2)?(?::[^/]*)?$/.test(modelId);
  const googleTasks = provider === "google" && /^(gemini-embedding-001|text-embedding-004|embedding-001)$/.test(modelId);
  const google2 = provider === "google" && modelId === "gemini-embedding-2";
  const documentPrefix = nomic ? "search_document: " : e5 ? "passage: " : google2 ? "title: none | text: " : "";
  const queryPrefix = nomic ? "search_query: " : e5 ? "query: " : google2 ? "task: search result | query: " : "";
  // UTF-8 bytes are a conservative token bound without a cross-provider tokenizer.
  // Unknown models use 2K; overflow/provider errors remain safe BM25 fallbacks.
  const maxInputBytes = (known?.maxInputTokens ?? (nomic || google2 ? 8192 : e5 ? 512 : 2048)) - 128;
  const profile: EmbeddingProfile = { documentPrefix, maxInputBytes,
    id: memoryHash(JSON.stringify({ model: config.model, endpoint, documentPrefix, queryPrefix,
      googleTasks, maxInputBytes, policy: "section-byte-mask-2" })),
  };
  return {
    profile, batchSize,
    async embed(values, kind, signal) {
      signal.throwIfAborted();
      if (!values.length || values.length > batchSize) throw new Error("Invalid embedding batch size");
      const providerOptions: Record<string, Record<string, string | boolean>> = {};
      if (googleTasks) providerOptions.google = { taskType: kind === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY" };
      if (ollama) providerOptions.ollama = { truncate: false };
      const prefix = kind === "document" ? documentPrefix : queryPrefix;
      const input = values.map(value => prefix + value);
      if (input.some(value => Buffer.byteLength(value) > maxInputBytes))
        throw new Error("Memory embedding input exceeds its conservative model limit");
      const result = await (await model()).doEmbed({ values: input, abortSignal: signal, providerOptions });
      if ("warnings" in result && Array.isArray(result.warnings) && result.warnings.length)
        throw new Error("Embedding provider reported unsupported options");
      signal.throwIfAborted();
      return validateEmbeddings(result.embeddings, values.length, null);
    },
  };
}
