import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama"
import { env, type ProviderConfig } from "@/config/env.js";

export interface LLMOptions {
  temperature?: number;
  [key: string]: any;
}

function getProviderSecret(cfg: ProviderConfig): string {
  const value = env[cfg.apiKeyEnv as keyof typeof env];
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing env var "${cfg.apiKeyEnv}" referenced by provider "${cfg.provider}".`);
  }

  return value;
}

export function getLLMProvider(
  provider: string = env.DEFAULT_CHAT_PROVIDER,
  modelName: string = env.DEFAULT_CHAT_MODEL,
  options: LLMOptions = {}
) {
  const cfg = env.LLM_PROVIDERS.find((p) => p.provider === provider);
  if (!cfg) {
    throw new Error(`Provider "${provider}" not found in LLM_PROVIDERS configuration.`);
  }

  if (!cfg.models.includes(modelName)) {
    throw new Error(`Model "${modelName}" is not registered for provider "${provider}".`);
  }

  const { temperature = 0, ...restOptions } = options;
  const providerSecret = getProviderSecret(cfg);

  switch (provider) {
    case "gemini":
      return new ChatGoogleGenerativeAI({
        apiKey: providerSecret,
        model: modelName,
        temperature,
        ...restOptions,
      });
    case "ollama":
      return new ChatOllama({
        baseUrl: providerSecret,
        model: modelName,
        temperature,
        ...restOptions,
      });
    default:
      throw new Error(`Provider "${provider}" is declared but not yet implemented.`);
  }
}
