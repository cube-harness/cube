import assert from "node:assert/strict";
import test from "node:test";
import {
  ConfigSchema,
  RunnableConfigSchema,
} from "../src/schemas/config.schema.js";
import {
  GATEWAY_IDS,
  GatewayIdSchema,
} from "../src/gateway.js";
import { migrateConfig } from "../src/config-migration.js";

const legacyConfig = (model = "google/gemini-3.7-flash") => ({
  version: 1,
  model,
  model_config: { reasoning_effort: "medium" },
  fallback_model: "ollama/qwen2.5:7b",
  theme: "default",
  app_title: ["model", "workspace", "threadId"],
  status_line: ["model", "workspace", "agentMd", "threadId"],
  telemetry: false,
  soul: { max_characters: 20_000 },
  memory: {
    storage: { provider: "sqlite", mode: "local" },
    vector: { enabled: false, provider: "sqlite", mode: "local" },
    embedder: { enabled: false, model: null },
    generate_title: {
      enabled: false,
      model: "inherit",
      instructions: "Generate a concise title under 80 characters.",
    },
    semantic_recall: {
      enabled: false,
      top_k: 4,
      message_range: { before: 1, after: 1 },
      scope: "resource",
      threshold: null,
    },
    working_memory: {
      enabled: true,
      scope: "thread",
      use_state_signals: true,
      agent_managed: false,
      template: "# Thread Task State",
    },
    observational_memory: {
      enabled: true,
      scope: "thread",
      activate_after_idle: false,
      activate_on_provider_change: true,
      share_token_budget: false,
      temporal_markers: false,
      retrieval: { enabled: true, vector: false, scope: "thread" },
      observation: {
        model: "inherit",
        message_tokens: 30_000,
        buffer_tokens: 0.2,
        buffer_on_idle: false,
        buffer_activation: 0.8,
        block_after: 1.2,
        previous_observer_tokens: 2_000,
        instruction: null,
        manage_working_memory: true,
        thread_title: false,
        observe_attachments: "auto",
      },
      reflection: {
        model: "inherit",
        observation_tokens: 40_000,
        buffer_activation: 0.5,
        block_after: 1.2,
        instruction: null,
      },
    },
  },
  permissions: { require_approval_for: ["execute_command"] },
});

const migrationContext = (options: {
  apiKeys?: string[];
  subscription?: boolean;
  reachable?: string[];
} = {}) => ({
  hasApiKey: (provider: "google" | "openrouter" | "openai") =>
    options.apiKeys?.includes(provider) ?? false,
  hasOpenAISubscription: options.subscription ?? false,
  localReachable: async (_provider: "ollama" | "lmstudio", baseUrl: string) =>
    options.reachable?.includes(baseUrl) ?? false,
});

test("GatewayIdSchema exposes the six stable persisted gateway IDs", () => {
  assert.deepEqual(GATEWAY_IDS, [
    "api_key/google",
    "api_key/openrouter",
    "api_key/openai",
    "subscription/openai",
    "local/ollama",
    "local/lmstudio",
  ]);
  for (const gatewayId of GATEWAY_IDS) {
    assert.equal(GatewayIdSchema.parse(gatewayId), gatewayId);
  }
});

test("ConfigSchema accepts incomplete v2 onboarding state and rejects fallback_model", () => {
  const migrated = {
    ...legacyConfig(),
    version: 2,
    gateway: undefined,
    model: undefined,
  };
  delete (migrated as { fallback_model?: string }).fallback_model;

  assert.equal(ConfigSchema.safeParse(migrated).success, true);
  assert.equal(RunnableConfigSchema.safeParse(migrated).success, false);
  assert.equal(
    ConfigSchema.safeParse({ ...migrated, fallback_model: "ollama/qwen2.5:7b" }).success,
    false,
  );
});

test("migrateConfig preserves settings, removes fallback_model, and infers Google", async () => {
  const result = await migrateConfig(legacyConfig(), migrationContext({ apiKeys: ["google"] }));

  assert.equal(result.inferredGateway, "api_key/google");
  assert.equal(result.config.version, 2);
  assert.equal(result.config.gateway, "api_key/google");
  assert.equal(result.config.model, "google/gemini-3.7-flash");
  assert.equal(result.config.model_config.reasoning_effort, "medium");
  assert.equal(result.config.theme, "default");
  assert.equal("fallback_model" in result.config, false);
  assert.equal(JSON.stringify(result.config).includes("ollama/qwen2.5:7b"), false);
  assert.equal(RunnableConfigSchema.safeParse(result.config).success, true);
});

test("migrateConfig does not guess between OpenAI API-key and subscription routes", async () => {
  const result = await migrateConfig(
    legacyConfig("openai/gpt-5.5"),
    migrationContext({ apiKeys: ["openai"], subscription: true }),
  );

  assert.equal(result.inferredGateway, null);
  assert.equal(result.config.gateway, undefined);
  assert.equal(result.config.model, "openai/gpt-5.5");
  assert.equal(ConfigSchema.safeParse(result.config).success, true);
  assert.equal(RunnableConfigSchema.safeParse(result.config).success, false);
});

test("migrateConfig infers a reachable legacy Ollama route", async () => {
  const result = await migrateConfig(
    legacyConfig("ollama/qwen2.5:7b"),
    migrationContext({ reachable: ["http://127.0.0.1:11434"] }),
  );

  assert.equal(result.inferredGateway, "local/ollama");
  assert.equal(result.config.gateway, "local/ollama");
  assert.equal(result.config.gateway_options["local/ollama"]?.base_url, "http://127.0.0.1:11434");
});

test("migrateConfig preserves the model but leaves readiness incomplete without a valid route", async () => {
  const result = await migrateConfig(legacyConfig(), migrationContext());

  assert.equal(result.inferredGateway, null);
  assert.equal(result.config.gateway, undefined);
  assert.equal(result.config.model, "google/gemini-3.7-flash");
  assert.equal(RunnableConfigSchema.safeParse(result.config).success, false);
});
