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

const ratio = z.number().gt(0).lte(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const nullableString = z.string().min(1).nullable().default(null);
const modelReference = z.string().min(1);

const activationTtl = z.union([
  z.literal("auto"),
  z.literal(false),
  z.number().nonnegative(),
  z.string().min(1),
]);

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

const retrieval = z.object({
  enabled: z.boolean(),
  vector: z.boolean(),
  scope: z.enum(["resource", "thread"]),
}).strict();

const blockAfter = z.number().gte(1);

const observation = z.object({
  model: modelReference,
  message_tokens: positiveInteger,
  buffer_tokens: z.union([z.literal(false), z.number().positive()]),
  buffer_on_idle: z.boolean(),
  buffer_activation: z.number().refine(
    value => (value > 0 && value <= 1) || value >= 1000,
    "buffer_activation must be a ratio in (0, 1] or an absolute retention value >= 1000",
  ),
  block_after: blockAfter,
  previous_observer_tokens: z.union([z.literal(false), nonNegativeInteger]),
  manage_working_memory: z.boolean(),
  thread_title: z.boolean(),
  observe_attachments: z.union([
    z.literal("auto"),
    z.boolean(),
    z.array(z.string().min(1)),
  ]),
}).strict();

const reflection = z.object({
  model: modelReference,
  observation_tokens: positiveInteger,
  buffer_activation: ratio,
  block_after: blockAfter,
}).strict();

const observationalMemory = z.object({
  enabled: z.boolean(),
  scope: z.enum(["resource", "thread"]),
  activate_after_idle: activationTtl,
  activate_on_provider_change: z.boolean(),
  share_token_budget: z.literal(false),
  temporal_markers: z.boolean(),
  retrieval,
  observation,
  reflection,
}).strict();

const memory = z.object({
  storage,
  vector,
  embedder,
  generate_title: generateTitle,
  semantic_recall: semanticRecall,
  working_memory: workingMemory,
  observational_memory: observationalMemory,
}).strict().superRefine((value, ctx) => {
  const wm = value.working_memory;
  const om = value.observational_memory;
  const observerManagesWorkingMemory =
    om.enabled && om.observation.manage_working_memory;

  if (wm.enabled && !wm.agent_managed && !observerManagesWorkingMemory) {
    ctx.addIssue({
      code: "custom",
      path: ["working_memory"],
      message:
        "Working Memory is enabled but has no manager. Enable working_memory.agent_managed or observational_memory.observation.manage_working_memory.",
    });
  }

  if (om.observation.manage_working_memory && (!om.enabled || !wm.enabled)) {
    ctx.addIssue({
      code: "custom",
      path: ["observational_memory", "observation", "manage_working_memory"],
      message:
        "manage_working_memory requires both Working Memory and Observational Memory to be enabled.",
    });
  }

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
  if (om.enabled && om.retrieval.enabled && om.retrieval.vector && !vectorFeatureEnabled) {
    ctx.addIssue({
      code: "custom",
      path: ["observational_memory", "retrieval", "vector"],
      message:
        "Vector-based observational retrieval requires both Vector and Embedder to be enabled.",
    });
  }

  const validateAbsoluteBlockAfter = (
    configured: number,
    threshold: number,
    path: (string | number)[],
  ) => {
    if (configured >= 100 && configured < threshold) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `Absolute block_after (${configured}) must be greater than or equal to its token threshold (${threshold}).`,
      });
    }
  };

  validateAbsoluteBlockAfter(
    om.observation.block_after,
    om.observation.message_tokens,
    ["observational_memory", "observation", "block_after"],
  );
  validateAbsoluteBlockAfter(
    om.reflection.block_after,
    om.reflection.observation_tokens,
    ["observational_memory", "reflection", "block_after"],
  );
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
