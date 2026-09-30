import { z } from "zod";
import { ApiKeyProviderSchema } from "./auth.schema.js";

const ModalitiesSchema = z.object({
  input: z.array(z.string()).optional(),
  output: z.array(z.string()).optional(),
}).strict();

const LimitSchema = z.object({
  context: z.number().int().nonnegative().optional(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
}).strict();

const CostSchema = z.object({
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
}).strict();

export const CatalogModelSchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  visibility: z.string().optional(),
  family: z.string().optional(),
  reasoning: z.boolean().optional(),
  reasoning_efforts: z.array(z.string()).optional(),
  reasoning_effort_descriptions: z.record(z.string(), z.string()).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  attachment: z.boolean().optional(),
  open_weights: z.boolean().optional(),
  limit: LimitSchema.optional(),
  modalities: ModalitiesSchema.optional(),
  cost: CostSchema.optional(), 
}).strict();

export const ProviderCatalogGroupSchema = z.object({
  name: z.string().min(1),
  models: z.array(CatalogModelSchema),
}).strict();

export const ModelCatalogSchema = z.object({
  updatedAt: z.string(),
  providers: z.record(z.string(), ProviderCatalogGroupSchema),
}).strict();

export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type ProviderCatalogGroup = z.infer<typeof ProviderCatalogGroupSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const ModelCatalogEntrySchema = ProviderCatalogGroupSchema.extend({
  updatedAt: z.iso.datetime(),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
});

export const ModelCatalogCacheSchema = z.object({
  api_key: z.partialRecord(ApiKeyProviderSchema, ModelCatalogEntrySchema),
  oauth: z.partialRecord(z.enum(["openai", "xai", "anthropic", "google"]), ModelCatalogEntrySchema),
  local: z.partialRecord(z.enum(["ollama", "lmstudio"]), ModelCatalogEntrySchema),
}).strict().superRefine((cache, ctx) => {
  for (const [strategy, providers] of Object.entries(cache)) {
    for (const [provider, entry] of Object.entries(providers)) {
      entry.models.forEach((model, index) => {
        if (!model.modelId.startsWith(`${provider}/`) || model.modelId === `${provider}/`) {
          ctx.addIssue({ code: "custom", message: "Model does not belong to the catalog provider.",
            path: [strategy, provider, "models", index, "modelId"] });
        }
      });
    }
  }
});

export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;
export type ModelCatalogCache = z.infer<typeof ModelCatalogCacheSchema>;
