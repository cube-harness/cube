import { ChatGoogle } from "@langchain/google";
import { ChatOllama } from "@langchain/ollama";
import { getProviderCredential, isModelSupported, providers } from "@/provider/provider-registry.js";

export type SupportedProvider = (typeof providers)[number]["provider"];

export interface CreateModelOptions {
  provider: SupportedProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

interface FactoryParams {
  model: string;
  temperature: number;
  maxTokens?: number;
  credential?: string;
}

// ---- Registry: mỗi provider đăng ký 1 factory function ----
// Không khai báo type chung (ModelFactory / BaseChatModel) — để TypeScript tự
// infer type cụ thể của từng factory (ChatGoogle, ChatOllama...), nhờ vậy
// bindTools giữ nguyên signature bắt buộc thay vì bị widen thành optional.
const factories = {
  gemini: ({ model, temperature, maxTokens, credential }: FactoryParams) => {
    if (!credential) throw new Error("Missing GEMINI_API_KEY in env");
    return new ChatGoogle({
      apiKey: credential,
      model,
      temperature,
      maxOutputTokens: maxTokens,
    });
  },

  ollama: ({ model, temperature, credential }: FactoryParams) => {
    return new ChatOllama({
      baseUrl: credential ?? "http://ollama:11434",
      model,
      temperature,
    });
  },
};

type FactoryKey = keyof typeof factories;

/**
 * Factory duy nhất để tạo chat model cho toàn bộ LangGraph project.
 * Tự validate model có nằm trong model-registry.json không,
 * tự lấy credential tương ứng từ env.ts.
 */
export function createChatModel(options: CreateModelOptions) {
  const { provider, model, temperature = 0, maxTokens } = options;

  if (!isModelSupported(provider, model)) {
    throw new Error(
      `Model "${model}" chưa được khai báo cho provider "${provider}" trong model-registry.json`
    );
  }

  const factory = factories[provider as FactoryKey];
  if (!factory) {
    throw new Error(`Chưa đăng ký factory cho provider "${provider}"`);
  }

  const credential = getProviderCredential(provider);
  return factory({ model, temperature, maxTokens, credential });
}