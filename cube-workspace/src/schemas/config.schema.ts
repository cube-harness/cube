import { z } from "zod";

const ratio = z.number().gt(0).lte(1);
const positiveInteger = z.number().int().positive();
const modelSettings = z.object({ temperature: z.number() }).strict();

export const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const ModelConfigSchema = z.object({
  reasoning_effort: ReasoningEffortSchema.optional(),
}).strict();

const workingMemory = z.object({
  enabled: z.boolean().default(true),
  scope: z.enum(["resource", "thread"]).default("resource"),
  use_state_signals: z.boolean().default(true),
  agent_managed: z.boolean().default(false),
  template: z.string(),
}).strict();

const observationalMemory = z.object({
  enabled: z.boolean().default(true),
  scope: z.enum(["resource", "thread"]).default("thread"),
  model: z.string().min(1).default("inherit"),
  activate_after_idle: z.union([
    z.literal("auto"),
    z.literal(false),
    z.number().nonnegative(),
    z.string().min(1),
  ]).default("auto"),
  activate_on_provider_change: z.boolean().default(true),
  share_token_budget: z.boolean().default(false),
  temporal_markers: z.boolean().default(false),
  retrieval: z.object({
    vector: z.boolean().default(false),
    scope: z.enum(["resource", "thread"]).default("thread"),
  }).strict(),
  observation: z.object({
    message_tokens: positiveInteger,
    buffer_tokens: z.union([z.literal(false), z.number().positive()]),
    buffer_activation: ratio,
    block_after: z.number().gt(1),
    previous_observer_tokens: z.union([z.literal(false), z.number().int().nonnegative()]),
    max_tokens_per_batch: positiveInteger,
    manage_working_memory: z.boolean(),
    observe_attachments: z.union([z.literal("auto"), z.boolean()]),
    model_settings: modelSettings,
  }).strict(),
  reflection: z.object({
    observation_tokens: positiveInteger,
    buffer_activation: ratio,
    block_after: z.number().gt(1),
    model_settings: modelSettings,
  }).strict(),
}).strict();

export const ConfigSchema = z.object({
  version: z.literal(1),
  model: z.string().min(1),
  model_config: ModelConfigSchema.nullish().transform((val) => val ?? {}),
  fallback_model: z.string().min(1).nullable(),
  theme: z.enum(["dark", "light"]),
  telemetry: z.boolean(),
  soul: z.object({
    max_characters: z.number().int().min(1).max(1_000_000),
  }).strict(),
  memory: z.object({
    working_memory: workingMemory,
    observational_memory: observationalMemory,
    semantic_recall: z.boolean(),
  }).strict(),
  permissions: z.object({
    require_approval_for: z.array(z.string().min(1)),
  }).strict(),
});

export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type CubeConfig = z.infer<typeof ConfigSchema>;
