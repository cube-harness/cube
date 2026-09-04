import type {
  ApiKeyGatewayId,
  GatewayId,
  OpenAISubscriptionCredential,
} from "@cube/workspace";

export type GatewayGroup = "api_key" | "subscription" | "local";
export type GatewayProviderId = "google" | "openrouter" | "openai" | "ollama" | "lmstudio";

export type GatewayDescriptor = {
  internalId: string;
  group: GatewayGroup;
  providerId: GatewayProviderId;
};

export const gatewayDescriptors = {
  "api_key/google": {
    internalId: "cube-api-google",
    group: "api_key",
    providerId: "google",
  },
  "api_key/openrouter": {
    internalId: "cube-api-openrouter",
    group: "api_key",
    providerId: "openrouter",
  },
  "api_key/openai": {
    internalId: "cube-api-openai",
    group: "api_key",
    providerId: "openai",
  },
  "subscription/openai": {
    internalId: "cube-subscription-openai",
    group: "subscription",
    providerId: "openai",
  },
  "local/ollama": {
    internalId: "cube-local-ollama",
    group: "local",
    providerId: "ollama",
  },
  "local/lmstudio": {
    internalId: "cube-local-lmstudio",
    group: "local",
    providerId: "lmstudio",
  },
} as const satisfies Record<GatewayId, GatewayDescriptor>;

export const toMastraRouterId = (
  gatewayId: GatewayId,
  canonicalModelId: string,
): string => {
  const descriptor = gatewayDescriptors[gatewayId];
  if (!canonicalModelId.startsWith(`${descriptor.providerId}/`)) {
    throw new Error(`Model ${canonicalModelId} does not belong to gateway ${gatewayId}.`);
  }
  return `${descriptor.internalId}/${canonicalModelId}`;
};

export const toCanonicalModelId = (
  gatewayId: GatewayId,
  routerModelId: string,
): string => {
  const prefix = `${gatewayDescriptors[gatewayId].internalId}/`;
  if (!routerModelId.startsWith(prefix)) {
    throw new Error(`Model route ${routerModelId} does not belong to gateway ${gatewayId}.`);
  }
  return routerModelId.slice(prefix.length);
};

export interface OpenAISubscriptionCredentialProvider {
  getValidCredential(): Promise<OpenAISubscriptionCredential>;
}

export type { ApiKeyGatewayId };
