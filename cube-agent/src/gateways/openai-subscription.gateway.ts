import {
  ModelsDevGateway,
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type MastraModelGatewayInterface,
  type ProviderConfig,
} from "@mastra/core/llm";
import type { OpenAISubscriptionCredentialProvider } from "./types.js";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export const selectOpenAISubscriptionModels = (
  canonicalModelIds: readonly string[],
): string[] => [...new Set(canonicalModelIds.flatMap((modelId) =>
  modelId.startsWith("openai/") && modelId.length > "openai/".length
    ? [modelId.slice("openai/".length)]
    : [],
))];

type SubscriptionDelegate = Pick<ModelsDevGateway, "resolveLanguageModel">;

export class OpenAISubscriptionGateway implements MastraModelGatewayInterface {
  readonly id = "cube-subscription-openai";
  readonly name = "Cube OpenAI subscription";
  readonly gatewayId = "subscription/openai" as const;

  constructor(
    private readonly credentials: OpenAISubscriptionCredentialProvider,
    supportedCanonicalModelIds: readonly string[],
    private readonly delegate: SubscriptionDelegate = new ModelsDevGateway({
      openai: {
        name: "OpenAI subscription",
        apiKeyEnvVar: "CUBE_OPENAI_SUBSCRIPTION_INTERNAL",
        gateway: "cube-subscription-openai",
        url: OPENAI_CODEX_BASE_URL,
        npm: "@ai-sdk/openai",
        models: selectOpenAISubscriptionModels(supportedCanonicalModelIds),
        modelOverrides: Object.fromEntries(
          selectOpenAISubscriptionModels(supportedCanonicalModelIds)
            .map((modelId) => [modelId, { shape: "responses" as const }]),
        ),
      },
    }),
  ) {
    this.supportedModelIds = selectOpenAISubscriptionModels(supportedCanonicalModelIds);
  }

  private readonly supportedModelIds: string[];

  fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return Promise.resolve({
      openai: {
        name: "OpenAI subscription",
        apiKeyEnvVar: "CUBE_OPENAI_SUBSCRIPTION_INTERNAL",
        gateway: this.id,
        url: OPENAI_CODEX_BASE_URL,
        npm: "@ai-sdk/openai",
        models: [...this.supportedModelIds],
        modelOverrides: Object.fromEntries(
          this.supportedModelIds.map((modelId) => [modelId, { shape: "responses" as const }]),
        ),
      },
    });
  }

  buildUrl(): string {
    return `${OPENAI_CODEX_BASE_URL}/responses`;
  }

  async resolveAuth(_request: GatewayAuthRequest): Promise<GatewayAuthResult> {
    const credential = await this.credentials.getValidCredential();
    return {
      bearerToken: credential.access_token,
      apiKey: credential.access_token,
      headers: { "ChatGPT-Account-Id": credential.account_id },
      source: "gateway",
    };
  }

  async getApiKey(_modelId: string): Promise<string> {
    return (await this.credentials.getValidCredential()).access_token;
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
