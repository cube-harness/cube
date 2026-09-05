import type { MastraModelGatewayInterface } from "@mastra/core/llm";
import type {
  AuthStore,
  GatewayId,
  RunnableCubeConfig,
} from "@cube/workspace";
import { CubeApiKeyGateway } from "./api-key.gateway.js";
import { LMStudioGateway } from "./lmstudio.gateway.js";
import { OllamaGateway } from "./ollama.gateway.js";
import { OpenAISubscriptionGateway } from "./openai-subscription.gateway.js";
import type { OpenAISubscriptionCredentialProvider } from "./types.js";

export type CubeGatewayAdapter = MastraModelGatewayInterface & {
  gatewayId: GatewayId;
  getBaseUrl?(): string;
  setBaseUrl?(baseUrl: string): void;
};

export type CreateCubeGatewaysOptions = {
  auth: Pick<AuthStore, "getApiKey">;
  openAISubscription: OpenAISubscriptionCredentialProvider;
  openAISubscriptionModelIds: readonly string[];
  gatewayOptions?: RunnableCubeConfig["gateway_options"];
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export type CubeGatewayComposition = {
  record: Record<string, CubeGatewayAdapter>;
  ordered: CubeGatewayAdapter[];
  byGatewayId: ReadonlyMap<GatewayId, CubeGatewayAdapter>;
};

export const createCubeGateways = (
  options: CreateCubeGatewaysOptions,
): CubeGatewayComposition => {
  const sharedLocal = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  const ordered: CubeGatewayAdapter[] = [
    new CubeApiKeyGateway("api_key/google", options.auth),
    new CubeApiKeyGateway("api_key/openrouter", options.auth),
    new CubeApiKeyGateway("api_key/openai", options.auth),
    new OpenAISubscriptionGateway(
      options.openAISubscription,
      options.openAISubscriptionModelIds,
    ),
    new OllamaGateway({
      ...sharedLocal,
      baseUrl: options.gatewayOptions?.["local/ollama"]?.base_url,
    }),
    new LMStudioGateway({
      ...sharedLocal,
      baseUrl: options.gatewayOptions?.["local/lmstudio"]?.base_url,
    }),
  ];
  return {
    record: Object.fromEntries(ordered.map((adapter) => [adapter.id, adapter])),
    ordered,
    byGatewayId: new Map(ordered.map((adapter) => [adapter.gatewayId, adapter])),
  };
};
