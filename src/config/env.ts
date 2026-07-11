import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ProviderConfigSchema = z.object({
  provider: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  models: z.array(z.string().min(1)).min(1, "models must have at least 1 entry"),
});

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),

  // MongoDB
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB: z.string().default("agentic-agent"),

  // Langsmith (optional)
  LANGSMITH_API_KEY: z.string().optional().default(""),

  // LLM provider keys (dùng trực tiếp ở nơi khác, vd store.ts)
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OLLAMA_BASE_URL: z.string().optional().default(""),
  TAVILY_API_KEY: z.string().min(1, "TAVILY_API_KEY is required"),

  DEFAULT_CHAT_PROVIDER: z.string().min(1).default("ollama"),
  DEFAULT_CHAT_MODEL: z.string().min(1).default("qwen2.5:7b"),

  LLM_PROVIDERS: z
    .string()
    .min(1, "LLM_PROVIDERS is required")
    .transform((val, ctx) => {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(val);
      } catch {
        ctx.addIssue({ code: "custom", message: "LLM_PROVIDERS is not valid JSON" });
        return z.NEVER;
      }

      const result = z.array(ProviderConfigSchema).safeParse(parsedJson);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          message: `LLM_PROVIDERS invalid shape: ${result.error.message}`,
        });
        return z.NEVER;
      }

      return result.data;
    }),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error("Invalid environment variables:");
  console.error(parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;

export type ProviderConfig = (typeof env.LLM_PROVIDERS)[number];
