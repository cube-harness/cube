import type { MastraModelGatewayInterface } from "@mastra/core/llm";
import type { AuthStore, GatewayId, LocalGatewayId, RunnableCubeConfig } from "@cube/workspace";
import { CubeApiKeyGateway } from "./api-key.gateway.js";
import { LocalGateway } from "./local.gateway.js";
import { OAuthGateway } from "./oauth.gateway.js";
import { gatewayDescriptors, type OAuthCredentialProviders } from "./types.js";

export type CubeGatewayAdapter = MastraModelGatewayInterface & {
  getBaseUrl?(gatewayId: LocalGatewayId): string;
  setBaseUrl?(baseUrl: string, gatewayId: LocalGatewayId): void;
};

export type CreateCubeGatewaysOptions = {
  auth: Pick<AuthStore, "getApiKey">;
  oauth: OAuthCredentialProviders;
  gatewayOptions?: RunnableCubeConfig["gateway_options"];
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
};

export type CubeGatewayComposition = {
  record: Record<string, CubeGatewayAdapter>;
  ordered: CubeGatewayAdapter[];
  byGatewayId: ReadonlyMap<GatewayId, CubeGatewayAdapter>;
};

export const createCubeGateways = (options: CreateCubeGatewaysOptions): CubeGatewayComposition => {
  const sharedLocal = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
  };
  const ordered: CubeGatewayAdapter[] = [
    new CubeApiKeyGateway(options.auth),
    new OAuthGateway(options.oauth),
    new LocalGateway({
      ...sharedLocal,
      gatewayOptions: options.gatewayOptions,
    }),
  ];
  return {
    record: Object.fromEntries(ordered.map((adapter) => [adapter.id, adapter])),
    ordered,
    byGatewayId: new Map(
      (Object.entries(gatewayDescriptors) as Array<[GatewayId, { internalId: string }]>).map(
        ([gatewayId, descriptor]) => [
          gatewayId,
          ordered.find((adapter) => adapter.id === descriptor.internalId)!,
        ],
      ),
    ),
  };
};
