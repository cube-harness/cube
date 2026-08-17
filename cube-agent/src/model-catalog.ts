import type { ReasoningEffort } from "@cube/workspace";
import { z } from "zod";

const GOOGLE_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";

const COMMON_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const GOOGLE_THINKING_LEVELS: ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
];

const openAiSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

const anthropicSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

const googleSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
    supportedGenerationMethods: z.array(z.string()).optional(),
    thinking: z.boolean().optional(),
  }).passthrough()),
}).passthrough();

const openRouterSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    supported_parameters: z.array(z.string()).optional(),
  }).passthrough()),
}).passthrough();

const groqSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    active: z.boolean().optional(),
  }).passthrough()),
}).passthrough();

const deepSeekSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

const ollamaSchema = z.object({
  models: z.array(z.object({
    name: z.unknown().optional(),
    model: z.unknown().optional(),
  }).passthrough()).optional(),
}).passthrough();

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  config: {
    reasoningEffort?: { values: ReasoningEffort[] };
  };
}

export interface ModelCatalogResult {
  models: ModelCatalogEntry[];
  warnings: string[];
}

export interface ModelCatalog {
  list: (signal?: AbortSignal) => Promise<ModelCatalogResult>;
  find: (modelId: string, signal?: AbortSignal) => Promise<ModelCatalogEntry | null>;
}

export interface CreateModelCatalogInput {
  ollamaBaseUrl: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
}

type CloudProvider =
  | "google"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "groq"
  | "deepseek";

interface CloudSource {
  provider: CloudProvider;
  label: string;
  load: (signal?: AbortSignal) => Promise<ModelCatalogEntry[]>;
}

const errorMessage = (error: unknown): string =>
  error instanceof z.ZodError
    ? "response format is unsupported."
    : error instanceof Error ? error.message : String(error);

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

const modelConfig = (
  efforts: ReasoningEffort[],
): ModelCatalogEntry["config"] => efforts.length > 0
  ? { reasoningEffort: { values: efforts } }
  : {};

const mergeModels = (
  sources: ModelCatalogEntry[][],
): ModelCatalogEntry[] => {
  const models = new Map<string, ModelCatalogEntry>();
  for (const source of sources) {
    for (const model of source) models.set(model.id, model);
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const isOpenAiAgentModel = (modelId: string): boolean => {
  const id = modelId.toLowerCase();
  const isTextFamily = id.startsWith("gpt-") || /^o\d(?:-|$)/.test(id);
  const isNonText = [
    "audio",
    "image",
    "moderation",
    "realtime",
    "transcribe",
    "tts",
  ].some((marker) => id.includes(marker));
  return isTextFamily && !isNonText;
};

const openAiEfforts = (modelId: string): ReasoningEffort[] =>
  /^(gpt-5(?:[.-]|$)|o[134](?:-|$))/i.test(modelId)
    ? COMMON_REASONING_EFFORTS
    : [];

const isGroqAgentModel = (modelId: string): boolean => ![
  "guard",
  "orpheus",
  "prompt-guard",
  "tts",
  "whisper",
].some((marker) => modelId.toLowerCase().includes(marker));

export const createModelCatalog = (
  input: CreateModelCatalogInput,
): ModelCatalog => {
  const env = input.env ?? process.env;
  const fetcher = input.fetcher ?? fetch;
  const ollamaTagsUrl = `${input.ollamaBaseUrl.replace(/\/$/, "")}/tags`;
  const cloudCache = new Map<CloudProvider, Promise<ModelCatalogEntry[]>>();

  const fetchJson = async (
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    throwIfAborted(signal);
    const response = await fetcher(url, { ...init, signal });
    if (!response.ok) throw new Error(`returned HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    throwIfAborted(signal);
    return payload;
  };

  const apiKey = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value || undefined;
  };

  const sources: CloudSource[] = [];

  const googleApiKey = apiKey("GOOGLE_API_KEY");
  if (googleApiKey) {
    sources.push({
      provider: "google",
      label: "Google",
      load: async (signal) => {
        const payload = googleSchema.parse(await fetchJson(
          GOOGLE_MODELS_URL,
          { headers: { "x-goog-api-key": googleApiKey } },
          signal,
        ));
        return payload.models.flatMap((model) => {
          if (!model.supportedGenerationMethods?.includes("generateContent")) return [];
          const modelName = model.name.replace(/^models\//, "").trim();
          if (!modelName) return [];
          const efforts = model.thinking && /^gemini-3(?:[.-]|$)/i.test(modelName)
            ? GOOGLE_THINKING_LEVELS
            : [];
          return [{
            id: `google/${modelName}`,
            provider: "google",
            config: modelConfig(efforts),
          }];
        });
      },
    });
  }

  const openAiApiKey = apiKey("OPENAI_API_KEY");
  if (openAiApiKey) {
    sources.push({
      provider: "openai",
      label: "OpenAI",
      load: async (signal) => {
        const payload = openAiSchema.parse(await fetchJson(
          OPENAI_MODELS_URL,
          { headers: { authorization: `Bearer ${openAiApiKey}` } },
          signal,
        ));
        return payload.data.flatMap(({ id }) => {
          const modelName = id.trim();
          return isOpenAiAgentModel(modelName)
            ? [{
                id: `openai/${modelName}`,
                provider: "openai",
                config: modelConfig(openAiEfforts(modelName)),
              }]
            : [];
        });
      },
    });
  }

  const anthropicApiKey = apiKey("ANTHROPIC_API_KEY");
  if (anthropicApiKey) {
    sources.push({
      provider: "anthropic",
      label: "Anthropic",
      load: async (signal) => {
        const payload = anthropicSchema.parse(await fetchJson(
          ANTHROPIC_MODELS_URL,
          {
            headers: {
              "anthropic-version": "2023-06-01",
              "x-api-key": anthropicApiKey,
            },
          },
          signal,
        ));
        return payload.data.flatMap(({ id }) => {
          const modelName = id.trim();
          return modelName
            ? [{
                id: `anthropic/${modelName}`,
                provider: "anthropic",
                config: {},
              }]
            : [];
        });
      },
    });
  }

  const openRouterApiKey = apiKey("OPENROUTER_API_KEY");
  if (openRouterApiKey) {
    sources.push({
      provider: "openrouter",
      label: "OpenRouter",
      load: async (signal) => {
        const payload = openRouterSchema.parse(await fetchJson(
          OPENROUTER_MODELS_URL,
          { headers: { authorization: `Bearer ${openRouterApiKey}` } },
          signal,
        ));
        return payload.data.flatMap((model) => {
          const modelName = model.id.trim();
          if (!modelName) return [];
          const efforts = model.supported_parameters?.includes("reasoning")
            ? COMMON_REASONING_EFFORTS
            : [];
          return [{
            id: `openrouter/${modelName}`,
            provider: "openrouter",
            config: modelConfig(efforts),
          }];
        });
      },
    });
  }

  const groqApiKey = apiKey("GROQ_API_KEY");
  if (groqApiKey) {
    sources.push({
      provider: "groq",
      label: "Groq",
      load: async (signal) => {
        const payload = groqSchema.parse(await fetchJson(
          GROQ_MODELS_URL,
          { headers: { authorization: `Bearer ${groqApiKey}` } },
          signal,
        ));
        return payload.data.flatMap((model) => {
          const modelName = model.id.trim();
          return model.active !== false && modelName && isGroqAgentModel(modelName)
            ? [{ id: `groq/${modelName}`, provider: "groq", config: {} }]
            : [];
        });
      },
    });
  }

  const deepSeekApiKey = apiKey("DEEPSEEK_API_KEY");
  if (deepSeekApiKey) {
    sources.push({
      provider: "deepseek",
      label: "DeepSeek",
      load: async (signal) => {
        const payload = deepSeekSchema.parse(await fetchJson(
          DEEPSEEK_MODELS_URL,
          { headers: { authorization: `Bearer ${deepSeekApiKey}` } },
          signal,
        ));
        return payload.data.flatMap(({ id }) => {
          const modelName = id.trim();
          return modelName
            ? [{ id: `deepseek/${modelName}`, provider: "deepseek", config: {} }]
            : [];
        });
      },
    });
  }

  const getCloud = (
    source: CloudSource,
    signal?: AbortSignal,
  ): Promise<ModelCatalogEntry[]> => {
    const cached = cloudCache.get(source.provider);
    if (cached) return cached;

    const pending = source.load(signal);
    const retryable = pending.catch((error: unknown) => {
      if (cloudCache.get(source.provider) === retryable) {
        cloudCache.delete(source.provider);
      }
      throw error;
    });
    cloudCache.set(source.provider, retryable);
    return retryable;
  };

  const loadOllama = async (signal?: AbortSignal): Promise<ModelCatalogEntry[]> => {
    const payload = ollamaSchema.parse(await fetchJson(
      ollamaTagsUrl,
      {},
      signal,
    ));
    return payload.models?.flatMap((model) => {
      const modelName = typeof model.name === "string"
        ? model.name
        : typeof model.model === "string" ? model.model : "";
      return modelName
        ? [{ id: `ollama/${modelName}`, provider: "ollama", config: {} }]
        : [];
    }) ?? [];
  };

  const list = async (signal?: AbortSignal): Promise<ModelCatalogResult> => {
    throwIfAborted(signal);
    const settled = await Promise.allSettled([
      ...sources.map((source) => getCloud(source, signal)),
      loadOllama(signal),
    ]);
    throwIfAborted(signal);

    const warnings: string[] = [];
    const modelSources: ModelCatalogEntry[][] = [];
    sources.forEach((source, index) => {
      const result = settled[index];
      if (result?.status === "fulfilled") {
        modelSources.push(result.value);
      } else if (result?.status === "rejected") {
        warnings.push(`${source.label}: ${errorMessage(result.reason)}`);
      }
    });

    const ollama = settled[sources.length];
    if (ollama?.status === "fulfilled") {
      modelSources.push(ollama.value);
    } else if (ollama?.status === "rejected") {
      warnings.push(`Ollama: ${errorMessage(ollama.reason)}`);
    }

    const models = mergeModels(modelSources);
    if (models.length === 0) {
      if (ollama?.status === "fulfilled" && ollama.value.length === 0) {
        warnings.push("Ollama: no local models are available.");
      }
      if (sources.length === 0) {
        warnings.push("No cloud provider API key is configured.");
      }
      throw new Error(warnings.join("\n"));
    }

    return { models, warnings };
  };

  const find = async (
    modelId: string,
    signal?: AbortSignal,
  ): Promise<ModelCatalogEntry | null> => {
    const result = await list(signal);
    return result.models.find(({ id }) => id === modelId) ?? null;
  };

  return { list, find };
};
