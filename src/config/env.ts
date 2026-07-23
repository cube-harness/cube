import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const boolFromString = z
  .string()
  .optional()
  .transform((val) => val === "true");

const envSchema = z.object({
  // LangSmith
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_TRACING: boolFromString,
  LANGSMITH_PROJECT: z.string().optional(),
  LANGCHAIN_VERBOSE: boolFromString,

  // LLM API keys (theo model-registry.json: gemini, openai, ollama)
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://ollama:11434"),

  // Tavily
  TAVILY_API_KEY: z.string().optional(),

  // LangGraph server
  LANGGRAPH_API_URL: z.string().default("http://localhost:8123"),
  LANGGRAPH_ASSISTANT_ID: z.string().default("main-agent"),

  // Logging
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  TELEGRAM_WEBHOOK_DOMAIN: z.string().min(1, "TELEGRAM_WEBHOOK_DOMAIN is required"),
  TELEGRAM_WEBHOOK_PATH: z.string().default("/telegram/webhook"),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1, "TELEGRAM_WEBHOOK_SECRET is required"),
  TELEGRAM_WEBHOOK_PORT: z.string().default("3000")
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error("Invalid environment variables:");
    console.error(JSON.stringify(z.flattenError(parsed.error).fieldErrors, null, 2));
    throw new Error("Invalid environment variables");
  }

  return parsed.data;
}

export const env = loadEnv();