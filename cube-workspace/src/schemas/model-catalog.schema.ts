import { z } from "zod";

const ModalitiesSchema = z.object({
  input: z.array(z.string()),
  output: z.array(z.string()),
}).strict();

const LimitSchema = z.object({
  context: z.number().int().nonnegative(),
  input: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative(),
}).strict();

const CostSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cache_read: z.number().nonnegative().optional(),
  cache_write: z.number().nonnegative().optional(),
}).strict();

export const CatalogModelSchema = z.object({
  modelId: z.string().min(1),
  name: z.string().min(1),
  family: z.string().optional(),
  reasoning: z.boolean().default(false),
  reasoning_efforts: z.array(z.string()).optional(),
  tool_call: z.boolean().default(false),
  structured_output: z.boolean().default(false),
  attachment: z.boolean().default(false),
  open_weights: z.boolean().default(false),
  limit: LimitSchema,
  modalities: ModalitiesSchema,
  cost: CostSchema.optional(), 
}).strict();

export const ProviderCatalogGroupSchema = z.object({
  name: z.string().min(1),
  models: z.array(CatalogModelSchema),
}).strict();

export const ModelCatalogSchema = z.object({
  version: z.literal(2),
  updatedAt: z.string(),
  providers: z.record(z.string(), ProviderCatalogGroupSchema),
}).strict();

export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type ProviderCatalogGroup = z.infer<typeof ProviderCatalogGroupSchema>;
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;
