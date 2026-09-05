import type {
  GatewayAuthRequest,
  GatewayAuthResult,
  GatewayLanguageModel,
  MastraModelGatewayInterface,
  ProviderConfig,
} from "@mastra/core/llm";
import { ModelsDevGateway } from "@mastra/core/llm";
import type { AuthStore } from "@cube/workspace";
import { gatewayDescriptors, toCanonicalModelId, type ApiKeyGatewayId } from "./types.js";

type ModelsDevDelegate = Pick<
  ModelsDevGateway,
  "fetchProviders" | "buildUrl" | "resolveLanguageModel"
>;

type ApiKeyReader = Pick<AuthStore, "getApiKey">;

export class CubeApiKeyGateway implements MastraModelGatewayInterface {
  readonly id: string;
  readonly name: string;
  private readonly providerId: "google" | "openrouter" | "openai";

  constructor(
    readonly gatewayId: ApiKeyGatewayId,
    private readonly auth: ApiKeyReader,
    private readonly delegate: ModelsDevDelegate = new ModelsDevGateway(),
  ) {
    const descriptor = gatewayDescriptors[gatewayId];
    this.id = descriptor.internalId;
    this.name = `Cube ${descriptor.providerId} API key`;
    this.providerId = descriptor.providerId;
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const providers = await this.delegate.fetchProviders();
    const provider = providers[this.providerId];
    return provider
      ? { [this.providerId]: { ...provider, gateway: this.id } }
      : {};
  }

  buildUrl(
    routerId: string,
    envVars: Record<string, string>,
  ): string | undefined | Promise<string | undefined> {
    return this.delegate.buildUrl(
      toCanonicalModelId(this.gatewayId, routerId),
      envVars,
    );
  }

  async resolveAuth(_request: GatewayAuthRequest): Promise<GatewayAuthResult | undefined> {
    const apiKey = await this.auth.getApiKey(this.providerId);
    return apiKey ? { apiKey, source: "gateway" } : undefined;
  }

  async getApiKey(_modelId: string): Promise<string> {
    const apiKey = await this.auth.getApiKey(this.providerId);
    if (!apiKey) {
      throw new Error(`Missing API key for ${this.gatewayId}. Run /gateway to configure it.`);
    }
    return apiKey;
  }

  resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> | GatewayLanguageModel {
    return this.delegate.resolveLanguageModel(args);
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
