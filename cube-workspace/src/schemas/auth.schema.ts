import { z } from "zod";
import { API_KEY_PROVIDERS } from "../constants.js";

export const ApiKeyProviderSchema = z.enum(
  Object.keys(API_KEY_PROVIDERS) as Array<keyof typeof API_KEY_PROVIDERS>,
);
export type ApiKeyProvider = z.infer<typeof ApiKeyProviderSchema>;

export const OpenAIOAuthCredentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
  account_id: z.string().min(1),
}).strict();

export const GrokOAuthCredentialSchema = OpenAIOAuthCredentialSchema.omit({ account_id: true });
export type GrokOAuthCredential = z.infer<typeof GrokOAuthCredentialSchema>;

export const AnthropicOAuthCredentialSchema = GrokOAuthCredentialSchema;
export type AnthropicOAuthCredential = z.infer<typeof AnthropicOAuthCredentialSchema>;

export const CubeAuthSchema = z.object({
  api_keys: z.partialRecord(
    ApiKeyProviderSchema,
    z.object({ api_key: z.string().min(1) }).strict(),
  ),
  oauth: z.object({
    openai: OpenAIOAuthCredentialSchema.optional(),
    xai: GrokOAuthCredentialSchema.optional(),
    anthropic: AnthropicOAuthCredentialSchema.optional(),
  }).strict(),
}).strict();

export type OpenAIOAuthCredential = z.infer<
  typeof OpenAIOAuthCredentialSchema
>;
export type CubeAuth = z.infer<typeof CubeAuthSchema>;
