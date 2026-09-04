import { z } from "zod";

export const ApiKeyProviderSchema = z.enum(["google", "openrouter", "openai"]);

export const OpenAISubscriptionCredentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_at: z.number().int().nonnegative(),
  account_id: z.string().min(1),
}).strict();

export const CubeAuthSchema = z.object({
  version: z.literal(1),
  api_keys: z.partialRecord(
    ApiKeyProviderSchema,
    z.object({ api_key: z.string().min(1) }).strict(),
  ),
  subscriptions: z.object({
    openai: OpenAISubscriptionCredentialSchema.optional(),
  }).strict(),
}).strict();

export type ApiKeyProvider = z.infer<typeof ApiKeyProviderSchema>;
export type OpenAISubscriptionCredential = z.infer<
  typeof OpenAISubscriptionCredentialSchema
>;
export type CubeAuth = z.infer<typeof CubeAuthSchema>;
