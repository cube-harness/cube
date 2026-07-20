import { z } from "zod";
import { env, type Env } from "@/config/env.js";
import providersRaw from "@/provider/provider-registry.json" with { type: "json" };

// Schema validate Json
const providerSchema = z.object({
  provider: z.string(),
  apiKeyEnv: z.string(), 
  models: z.array(z.string()).min(1),
});

const providersSchema = z.array(providerSchema);

export type ProviderConfig = z.infer<typeof providerSchema>;

// ---- Validate ngay khi load module ----
export const providers: ProviderConfig[] = providersSchema.parse(providersRaw);

// Helper

/**
 * Lấy config của 1 provider theo tên (vd: "gemini", "openai", "ollama")
 */
export function getProviderConfig(providerName: string): ProviderConfig {
  const config = providers.find((p) => p.provider === providerName);
  if (!config) {
    throw new Error(`Provider "${providerName}" not found in model-registry.json`);
  }
  return config;
}

/**
 * Lấy giá trị thật (API key / base URL) của provider từ env.ts
 * dựa trên field apiKeyEnv trong JSON.
 */
export function getProviderCredential(providerName: string): string | undefined {
  const config = getProviderConfig(providerName);
  const key = config.apiKeyEnv as keyof Env;
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Kiểm tra 1 model có thuộc provider đó không.
 */
export function isModelSupported(providerName: string, model: string): boolean {
  return getProviderConfig(providerName).models.includes(model);
}

/**
 * Trả về provider đầu tiên có credential hợp lệ (không rỗng).
 * Hữu ích khi muốn fallback tự động: gemini -> openai -> ollama.
 */
export function getAvailableProviders(): ProviderConfig[] {
  return providers.filter((p) => {
    const value = getProviderCredential(p.provider);
    return value !== undefined && value.length > 0;
  });
}