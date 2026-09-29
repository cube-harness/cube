import { z } from "zod";
import { ApiKeyProviderSchema } from "./auth.schema.js";

export const GATEWAY_IDS = [
  ...ApiKeyProviderSchema.options.map((provider) => `api_key/${provider}` as const),
  "oauth/openai",
  "oauth/xai",
  "oauth/anthropic",
  "oauth/google",
  "local/ollama",
  "local/lmstudio",
] as const;

export const GatewayIdSchema = z.enum(GATEWAY_IDS);

export type GatewayId = z.infer<typeof GatewayIdSchema>;
export type ApiKeyGatewayId = Extract<GatewayId, `api_key/${string}`>;
export type LocalGatewayId = Extract<GatewayId, `local/${string}`>;

const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nullableString = z.string().min(1).nullable().default(null);
const modelReference = z.string().min(1);

const storage = z.object({
  provider: z.literal("sqlite"),
  mode: z.literal("local"),
}).strict();

const vector = z.object({
  enabled: z.boolean(),
  provider: z.literal("sqlite"),
  mode: z.literal("local"),
}).strict();

const embedder = z.object({
  enabled: z.boolean(),
  model: nullableString,
}).strict();

const generateTitle = z.object({
  enabled: z.boolean(),
  model: modelReference,
  instructions: z.string().min(1),
}).strict();

const semanticRecall = z.object({
  enabled: z.boolean(),
  top_k: positiveInteger,
  message_range: z.object({
    before: nonNegativeInteger,
    after: nonNegativeInteger,
  }).strict(),
  scope: z.enum(["resource", "thread"]),
  threshold: z.number().min(0).max(1).nullable(),
}).strict();

const workingMemory = z.object({
  enabled: z.boolean(),
  scope: z.enum(["resource", "thread"]),
  use_state_signals: z.boolean(),
  agent_managed: z.boolean(),
  template: z.string().min(1),
}).strict();

const compaction = z.object({
  manual_min_ratio: z.number().gt(0).lt(1),
  keep_recent_ratio: z.number().gt(0).lt(1),
  reserve_tokens: positiveInteger,
}).strict();

const memory = z.object({
  storage,
  vector,
  embedder,
  generate_title: generateTitle,
  semantic_recall: semanticRecall,
  working_memory: workingMemory,
  compaction,
}).strict().superRefine((value, ctx) => {
  const vectorFeatureEnabled = value.vector.enabled && value.embedder.enabled;
  if (value.embedder.enabled && value.embedder.model === null) {
    ctx.addIssue({
      code: "custom",
      path: ["embedder", "model"],
      message: "embedder.model is required when embedder.enabled is true.",
    });
  }
  if (value.embedder.enabled && !value.vector.enabled) {
    ctx.addIssue({
      code: "custom",
      path: ["embedder", "enabled"],
      message: "Embedder requires vector.enabled to be true.",
    });
  }
  if (value.semantic_recall.enabled && !vectorFeatureEnabled) {
    ctx.addIssue({
      code: "custom",
      path: ["semantic_recall", "enabled"],
      message:
        "Semantic Recall requires both Vector and Embedder to be enabled.",
    });
  }
});

export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
]);

export const ModelConfigSchema = z.object({
  reasoning_effort: ReasoningEffortSchema.optional(),
}).strict();

const configSettingsShape = {
  skills: z.object({ disabled: z.array(z.string().min(1)).default([]) }).strict().default({ disabled: [] }),
  model_config: ModelConfigSchema.nullish().transform((val) => val ?? {}),
  theme: z.string().min(1).default("default"),
  app_title: z.array(z.string().min(1)).min(1).default(["model", "workspace", "threadId"]),
  status_line: z.array(z.string().min(1)).min(1).default(["model", "workspace", "agentMd", "threadId"]),
  telemetry: z.boolean(),
  soul: z.object({
    max_characters: z.number().int().min(1).max(1_000_000),
  }).strict(),
  memory,
  permissions: z.object({
    require_approval_for: z.array(z.string().min(1)),
  }).strict(),
};

const gatewayOptions = z.object({
  "local/ollama": z.object({
    base_url: z.string().url(),
  }).strict().optional(),
  "local/lmstudio": z.object({
    base_url: z.string().url(),
  }).strict().optional(),
}).strict().default({});

export const ConfigSchema = z.object({
  gateway: GatewayIdSchema.optional(),
  model: modelReference.optional(),
  gateway_options: gatewayOptions,
  ...configSettingsShape,
}).strict();

export const RunnableConfigSchema = ConfigSchema.extend({
  gateway: GatewayIdSchema,
  model: modelReference,
});

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type CubeConfigDocument = z.infer<typeof ConfigSchema>;
export type RunnableCubeConfig = z.infer<typeof RunnableConfigSchema>;
export type CubeConfig = RunnableCubeConfig;
