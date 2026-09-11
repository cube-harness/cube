import {
  ApiKeyProviderSchema,
  type ApiKeyProvider,
  type ApiKeyGatewayId,
  type GatewayId,
  type OpenAIOAuthCredential,
  type GrokOAuthCredential,
  type AnthropicOAuthCredential,
  type GoogleOAuthCredential,
} from "@cube/workspace";

export type GatewayGroup = "api_key" | "oauth" | "local";
export type GatewayProviderId = ApiKeyProvider | "ollama" | "lmstudio";

export type GatewayDescriptor = {
  internalId: string;
  group: GatewayGroup;
  providerId: GatewayProviderId;
};

export const gatewayDescriptors = {
  ...(Object.fromEntries(
    ApiKeyProviderSchema.options.map((providerId) => [
      `api_key/${providerId}`,
      { internalId: "cube-api", group: "api_key", providerId },
    ]),
  ) as Record<
    ApiKeyGatewayId,
    { internalId: "cube-api"; group: "api_key"; providerId: ApiKeyProvider }
  >),
  "oauth/openai": {
    internalId: "cube-oauth",
    group: "oauth",
    providerId: "openai",
  },
  "oauth/xai": {
    internalId: "cube-oauth",
    group: "oauth",
    providerId: "xai",
  },
  "oauth/anthropic": {
    internalId: "cube-oauth",
    group: "oauth",
    providerId: "anthropic",
  },
  "oauth/google": {
    internalId: "cube-oauth",
    group: "oauth",
    providerId: "google",
  },
  "local/ollama": {
    internalId: "cube-local",
    group: "local",
    providerId: "ollama",
  },
  "local/lmstudio": {
    internalId: "cube-local",
    group: "local",
    providerId: "lmstudio",
  },
} as const satisfies Record<GatewayId, GatewayDescriptor>;

export const toMastraRouterId = (gatewayId: GatewayId, canonicalModelId: string): string => {
  const descriptor = gatewayDescriptors[gatewayId];
  if (!canonicalModelId.startsWith(`${descriptor.providerId}/`)) {
    throw new Error(`Model ${canonicalModelId} does not belong to gateway ${gatewayId}.`);
  }
  return `${descriptor.internalId}/${canonicalModelId}`;
};

export const toCanonicalModelId = (gatewayId: GatewayId, routerModelId: string): string => {
  const prefix = `${gatewayDescriptors[gatewayId].internalId}/`;
  if (!routerModelId.startsWith(`${prefix}${gatewayDescriptors[gatewayId].providerId}/`)) {
    throw new Error(`Model route ${routerModelId} does not belong to gateway ${gatewayId}.`);
  }
  return routerModelId.slice(prefix.length);
};

export const getCanonicalModelId = (routerOrCanonicalModelId: string): string => {
  for (const descriptor of Object.values(gatewayDescriptors)) {
    const prefix = `${descriptor.internalId}/`;
    if (routerOrCanonicalModelId.startsWith(prefix)) {
      return routerOrCanonicalModelId.slice(prefix.length);
    }
  }
  return routerOrCanonicalModelId;
};

export interface OpenAIOAuthCredentialProvider {
  getValidCredential(): Promise<OpenAIOAuthCredential>;
}

export type OAuthCredentialProviders = {
  openai: OpenAIOAuthCredentialProvider;
  xai?: { getValidCredential(): Promise<GrokOAuthCredential> };
  anthropic?: { getValidCredential(): Promise<AnthropicOAuthCredential> };
  google?: { getValidCredential(): Promise<GoogleOAuthCredential> };
};

export type { ApiKeyGatewayId };
