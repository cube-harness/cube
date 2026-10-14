import { z } from "zod";
import { ApiKeyProviderSchema } from "./auth.schema.js";
import { PermissionsSchema } from "./permission.schema.js";
import {
  DEFAULT_OLLAMA_URL,
  DEFAULT_LMSTUDIO_URL,
  HOME_LIMITS,
  DURABLE_MEMORY_DEFAULTS,
  MEMORY_RETRIEVAL_DEFAULTS,
  INHERIT_MODEL,
  DEFAULT_BACKGROUND_TASKS,
  DEFAULT_SUBAGENTS,
  DEFAULT_COMMAND_TRUNCATION,
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
const modelReference = z.string().min(1);

export const ReasoningEffortSchema = z.enum([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "default",
]);

const generateTitle = z
  .object({
    enabled: z.boolean().default(false),
    model: modelReference.default(INHERIT_MODEL),
    reasoning_effort: ReasoningEffortSchema.optional(),
    instructions: z.string().min(1).default("Generate a concise title under 80 characters."),
  })
  .strict();

const retrievalDefaults = MEMORY_RETRIEVAL_DEFAULTS;
export const MemoryRetrievalSchema = z.object({
  enabled: z.boolean().default(retrievalDefaults.enabled),
  model: z.string().trim().min(1).refine(value => {
    const slash = value.indexOf("/");
    const provider = value.slice(0, slash);
    return slash > 0 && value.slice(slash + 1).trim().length > 0 &&
      (ApiKeyProviderSchema.safeParse(provider).success || ["ollama", "lmstudio"].includes(provider));
  }, "Use a concrete API-key or local provider/model for retrieval (not OAuth or inherit).")
    .nullable().default(retrievalDefaults.model),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.model) ctx.addIssue({ code: "custom", path: ["model"], message: "retrieval.model is required when enabled." });
});
export type MemoryRetrievalConfig = z.infer<typeof MemoryRetrievalSchema>;

const compaction = z
  .object({
    model: modelReference.default(INHERIT_MODEL),
    reasoning_effort: ReasoningEffortSchema.optional(),
    manual_min_ratio: z.number().gt(0).lt(1).default(0.30),
    keep_recent_ratio: z.number().gt(0).lt(1).default(0.20),
    reserve_tokens: positiveInteger.default(16384),
  })
  .strict();

const memory = z
  .object({
    generate_title: generateTitle.default(generateTitle.parse({})),
    compaction: compaction.default(compaction.parse({})),
    durable: z.object({
      enabled: z.boolean().default(DURABLE_MEMORY_DEFAULTS.enabled),
      model: modelReference.default(DURABLE_MEMORY_DEFAULTS.model),
      reasoning_effort: ReasoningEffortSchema.optional(),
      min_idle_hours: z.number().finite().min(0).max(720).default(DURABLE_MEMORY_DEFAULTS.min_idle_hours),
      retrieval: MemoryRetrievalSchema.default(MemoryRetrievalSchema.parse({})),
    }).strict().default(DURABLE_MEMORY_DEFAULTS),
  })
  .strict();

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
  truncation_policy: z.object({
    execute_command: z.object({
      max_bytes: z.number().int().min(4).max(256 * 1024).default(DEFAULT_COMMAND_TRUNCATION.max_bytes),
      max_lines: z.number().int().min(1).max(2000).default(DEFAULT_COMMAND_TRUNCATION.max_lines),
    }).strict().default(DEFAULT_COMMAND_TRUNCATION),
  }).strict().default({ execute_command: DEFAULT_COMMAND_TRUNCATION }),
  subagents: z.object({
    concurrency: z.number().int().min(1).max(32).default(DEFAULT_SUBAGENTS.concurrency),
    model: modelReference.default(DEFAULT_SUBAGENTS.model),
    reasoning_effort: ReasoningEffortSchema.optional(),
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
