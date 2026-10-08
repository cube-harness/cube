import { z } from "zod";
import { ApiKeyProviderSchema } from "./auth.schema.js";
import { PermissionsSchema } from "./permission.schema.js";
import {
  DEFAULT_OLLAMA_URL,
  DEFAULT_LMSTUDIO_URL,
  HOME_LIMITS,
  DURABLE_MEMORY_DEFAULTS,
  INHERIT_MODEL,
  DEFAULT_BACKGROUND_TASKS,
  DEFAULT_SUBAGENTS,
} from "../constants.js";

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

const storage = z
  .object({
    provider: z.literal("sqlite").default("sqlite"),
    mode: z.literal("local").default("local"),
  })
  .strict();

const vector = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.literal("sqlite").default("sqlite"),
    mode: z.literal("local").default("local"),
  })
  .strict();

const embedder = z
  .object({
    enabled: z.boolean().default(false),
    model: nullableString,
  })
  .strict();

const generateTitle = z
  .object({
    enabled: z.boolean().default(false),
    model: modelReference.default(INHERIT_MODEL),
    instructions: z.string().min(1).default("Generate a concise title under 80 characters."),
  })
  .strict();

const semanticRecall = z
  .object({
    enabled: z.boolean().default(false),
    top_k: positiveInteger.default(4),
    message_range: z
      .object({
        before: nonNegativeInteger.default(1),
        after: nonNegativeInteger.default(1),
      })
      .strict().default({ before: 1, after: 1 }),
    scope: z.enum(["resource", "thread"]).default("resource"),
    threshold: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();

const compaction = z
  .object({
    model: modelReference.default(INHERIT_MODEL),
    manual_min_ratio: z.number().gt(0).lt(1).default(0.30),
    keep_recent_ratio: z.number().gt(0).lt(1).default(0.20),
    reserve_tokens: positiveInteger.default(16384),
  })
  .strict();

const memory = z
  .object({
    storage: storage.default(storage.parse({})),
    vector: vector.default(vector.parse({})),
    embedder: embedder.default(embedder.parse({})),
    generate_title: generateTitle.default(generateTitle.parse({})),
    semantic_recall: semanticRecall.default(semanticRecall.parse({})),
    compaction: compaction.default(compaction.parse({})),
    durable: z.object({
      enabled: z.boolean().default(DURABLE_MEMORY_DEFAULTS.enabled),
      model: modelReference.default(DURABLE_MEMORY_DEFAULTS.model),
      min_idle_hours: z.number().finite().min(0).max(720).default(DURABLE_MEMORY_DEFAULTS.min_idle_hours),
    }).strict().default(DURABLE_MEMORY_DEFAULTS),
  })
  .strict()
  .superRefine((value, ctx) => {
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
        message: "Semantic Recall requires both Vector and Embedder to be enabled.",
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

export const ModelConfigSchema = z
  .object({
    reasoning_effort: ReasoningEffortSchema.optional(),
  })
  .strict();

const soul = z
  .object({
    max_characters: z.number().int().min(1).max(1_000_000).default(HOME_LIMITS.SOUL_MAX_CHARACTERS),
  })
  .strict();

const configSettingsShape = {
  subagents: z.object({
    concurrency: z.number().int().min(1).max(32).default(DEFAULT_SUBAGENTS.concurrency),
    model: modelReference.default(DEFAULT_SUBAGENTS.model),
    timeout_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_SUBAGENTS.timeout_ms),
  }).strict().default(DEFAULT_SUBAGENTS),
  background_tasks: z.object({
    enabled: z.boolean().default(DEFAULT_BACKGROUND_TASKS.enabled),
    concurrency: z.number().int().min(1).max(32).default(DEFAULT_BACKGROUND_TASKS.concurrency),
    timeout_ms: z.number().int().min(0).max(600000).default(DEFAULT_BACKGROUND_TASKS.timeout_ms),
  }).strict().default(DEFAULT_BACKGROUND_TASKS),
  skills: z
    .object({ disabled: z.array(z.string().min(1)).default([]) })
    .strict()
    .default({ disabled: [] }),
  model_config: ModelConfigSchema.default({}),
  theme: z.string().min(1).default("default"),
  app_title: z.array(z.string().min(1)).min(1).default(["workspace", "threadId"]),
  status_line: z
    .array(z.string().min(1))
    .min(1)
    .default(["workspace", "model"]),
  telemetry: z.boolean().default(false),
  soul: soul.default(soul.parse({})),
  memory: memory.default(memory.parse({})),
};

const gatewayOptions = z
  .object({
    "local/ollama": z
      .object({
        base_url: z.string().url().default(DEFAULT_OLLAMA_URL),
      })
      .strict()
      .optional(),
    "local/lmstudio": z
      .object({
        base_url: z.string().url().default(DEFAULT_LMSTUDIO_URL),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export const ConfigSchema = z
  .object({
    gateway: GatewayIdSchema.optional(),
    model: modelReference.optional(),
    gateway_options: gatewayOptions,
    ...configSettingsShape,
  })
  .strict();

export const RunnableConfigSchema = ConfigSchema.extend({
  gateway: GatewayIdSchema,
  model: modelReference,
  // Effective runtime policy; persisted only in permission.json, never config.yaml.
  permissions: PermissionsSchema.default(PermissionsSchema.parse({})),
});

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type CubeConfigDocument = z.infer<typeof ConfigSchema>;
export type RunnableCubeConfig = z.infer<typeof RunnableConfigSchema>;
export type CubeConfig = RunnableCubeConfig;
