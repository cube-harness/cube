import {
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_OLLAMA_URL,
  type GatewayId,
} from "./gateway.js";
import {
  ConfigSchema,
  LegacyConfigSchema,
  type CubeConfig,
} from "./schemas/config.schema.js";

export type ConfigMigrationContext = {
  hasApiKey(provider: "google" | "openrouter" | "openai"): boolean;
  hasOpenAISubscription: boolean;
  localReachable(
    provider: "ollama" | "lmstudio",
    baseUrl: string,
  ): Promise<boolean>;
};

export type ConfigMigrationResult = {
  config: CubeConfig;
  inferredGateway: GatewayId | null;
};

const inferGateway = async (
  model: string,
  context: ConfigMigrationContext,
): Promise<GatewayId | null> => {
  const provider = model.slice(0, model.indexOf("/"));
  const candidates: GatewayId[] = [];

  if (
    (provider === "google" || provider === "openrouter" || provider === "openai") &&
    context.hasApiKey(provider)
  ) {
    candidates.push(`api_key/${provider}`);
  }
  if (provider === "openai" && context.hasOpenAISubscription) {
    candidates.push("subscription/openai");
  }
  if (
    provider === "ollama" &&
    await context.localReachable("ollama", DEFAULT_OLLAMA_URL)
  ) {
    candidates.push("local/ollama");
  }
  if (
    provider === "lmstudio" &&
    await context.localReachable("lmstudio", DEFAULT_LMSTUDIO_URL)
  ) {
    candidates.push("local/lmstudio");
  }

  return candidates.length === 1 ? candidates[0]! : null;
};

export const migrateConfig = async (
  input: unknown,
  context: ConfigMigrationContext,
): Promise<ConfigMigrationResult> => {
  const current = ConfigSchema.safeParse(input);
  if (current.success) {
    return {
      config: current.data,
      inferredGateway: current.data.gateway ?? null,
    };
  }

  const legacy = LegacyConfigSchema.parse(input);
  const gateway = await inferGateway(legacy.model, context);
  const {
    version: _version,
    fallback_model: _fallbackModel,
    ...preserved
  } = legacy;
  const config = ConfigSchema.parse({
    ...preserved,
    version: 2,
    ...(gateway ? { gateway } : {}),
    gateway_options: {
      "local/ollama": { base_url: DEFAULT_OLLAMA_URL },
      "local/lmstudio": { base_url: DEFAULT_LMSTUDIO_URL },
    },
  });

  return { config, inferredGateway: gateway };
};
