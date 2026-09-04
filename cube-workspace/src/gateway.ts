import { z } from "zod";

export const GATEWAY_IDS = [
  "api_key/google",
  "api_key/openrouter",
  "api_key/openai",
  "subscription/openai",
  "local/ollama",
  "local/lmstudio",
] as const;

export const GatewayIdSchema = z.enum(GATEWAY_IDS);

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_LMSTUDIO_URL = "http://127.0.0.1:1234/v1";

export type GatewayId = z.infer<typeof GatewayIdSchema>;
export type ApiKeyGatewayId = Extract<GatewayId, `api_key/${string}`>;
export type LocalGatewayId = Extract<GatewayId, `local/${string}`>;
