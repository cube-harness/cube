import {
  ModelsDevGateway,
  type GatewayAuthRequest,
  type GatewayAuthResult,
  type GatewayLanguageModel,
  type MastraModelGatewayInterface,
  type ProviderConfig,
} from "@mastra/core/llm";
import type { OAuthCredentialProviders } from "./types.js";
import { wrapLanguageModel } from "ai";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const GROK_BUILD_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
// Experimental subscription compatibility; isolated from the native API-key gateway.
export const ANTHROPIC_OAUTH_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
  "user-agent": "claude-cli/2.1.251 (external, sdk-cli)",
  "x-app": "cli",
};
export const GROK_BUILD_HEADERS = {
  "x-xai-token-auth": "xai-grok-cli",
  "x-grok-client-identifier": "grok-shell",
  "x-grok-client-version": "0.2.99",
};

type OAuthDelegate = Pick<ModelsDevGateway, "resolveLanguageModel">;

export class OAuthGateway implements MastraModelGatewayInterface {
  readonly id = "cube-oauth";
  readonly name = "Cube OAuth";

  constructor(
    private readonly credentials: OAuthCredentialProviders,
    private readonly delegate?: OAuthDelegate,
  ) {}

  private readonly providers: Record<string, ProviderConfig> = Object.fromEntries(
    (
      [
        ["openai", "OpenAI", OPENAI_CODEX_BASE_URL],
        ["xai", "xAI", GROK_BUILD_BASE_URL],
        ["anthropic", "Anthropic", ANTHROPIC_BASE_URL],
      ] as const
    ).map(([provider, name, url]) => [
      provider,
      {
        name,
        url,
        apiKeyEnvVar: [],
        gateway: this.id,
        npm: provider === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai",
        models: [],
      },
    ]),
  );
  private readonly grokSessionId = crypto.randomUUID();
  private grokTurn = 0;

  fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return Promise.resolve(structuredClone(this.providers));
  }

  buildUrl(modelId: string, _envVars?: Record<string, string>): string {
    const provider = modelId.replace(/^cube-oauth\//, "").split("/")[0]!;
    const config = this.providers[provider];
    if (!config) throw new Error("Unsupported OAuth provider.");
    return `${config.url}/${provider === "anthropic" ? "messages" : "responses"}`;
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult> {
    if (request.providerId === "anthropic") {
      if (!this.credentials.anthropic)
        throw new Error("Anthropic OAuth is not configured. Run /gateway to sign in.");
      const credential = await this.credentials.anthropic.getValidCredential();
      return {
        bearerToken: credential.access_token,
        apiKey: credential.access_token,
        headers: { ...ANTHROPIC_OAUTH_HEADERS },
        source: "gateway",
      };
    }
    if (request.providerId === "xai") {
      if (!this.credentials.xai)
        throw new Error("Grok Build is not configured. Run /gateway to sign in.");
      const credential = await this.credentials.xai.getValidCredential();
      return {
        bearerToken: credential.access_token,
        apiKey: credential.access_token,
        headers: { ...GROK_BUILD_HEADERS },
        source: "gateway",
      };
    }
    if (request.providerId !== "openai") throw new Error("Unsupported OAuth provider.");
    const credential = await this.credentials.openai.getValidCredential();
    return {
      bearerToken: credential.access_token,
      apiKey: credential.access_token,
      headers: { "ChatGPT-Account-Id": credential.account_id },
      source: "gateway",
    };
  }

  async getApiKey(modelId: string): Promise<string> {
    const providerId = modelId.replace(/^cube-oauth\//, "").split("/")[0]!;
    return (await this.resolveAuth({ gatewayId: this.id, providerId, modelId, routerId: modelId }))
      .apiKey!;
  }

  async resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const provider = this.providers[args.providerId];
    if (!provider) throw new Error("Unsupported OAuth provider.");
    const delegate =
      this.delegate ??
      new ModelsDevGateway({
        [args.providerId]: {
          ...provider,
          models: [args.modelId],
          ...(args.providerId === "anthropic" ? {} : { modelOverrides: { [args.modelId]: { shape: "responses" as const } } }),
        },
      });
    const model = await delegate.resolveLanguageModel(args);
    if (model.specificationVersion !== "v3") throw new Error("Unsupported oauth model adapter.");
    if (args.providerId === "anthropic") {
      return wrapLanguageModel({
        model,
        middleware: {
          specificationVersion: "v3",
          transformParams: async ({ params }) => {
            if (!this.credentials.anthropic)
              throw new Error("Anthropic OAuth is not configured. Run /gateway to sign in.");
            const credential = await this.credentials.anthropic.getValidCredential();
            return {
              ...params,
              headers: {
                ...params.headers,
                ...ANTHROPIC_OAUTH_HEADERS,
                "x-api-key": undefined,
                authorization: `Bearer ${credential.access_token}`,
              },
              // The subscription endpoint requires this preamble. Cube's instructions/tools remain intact.
              prompt: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." }, ...params.prompt],
            };
          },
        },
      });
    }
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        transformParams: async ({ params }) =>
          args.providerId === "xai"
            ? {
                ...params,
                // One stateless Grok session per Cube runtime; no server-side history is shared.
                headers: {
                  ...params.headers,
                  ...GROK_BUILD_HEADERS,
                  authorization: `Bearer ${(await this.credentials.xai!.getValidCredential()).access_token}`,
                  "x-grok-session-id": this.grokSessionId,
                  "x-grok-conv-id": this.grokSessionId,
                  "x-grok-req-id": crypto.randomUUID(),
                  "x-grok-turn-idx": String(++this.grokTurn),
                  "x-grok-model-override": args.modelId,
                },
                providerOptions: {
                  ...params.providerOptions,
                  openai: {
                    ...params.providerOptions?.openai,
                    store: false,
                    previousResponseId: undefined,
                    forceReasoning: true,
                    systemMessageMode: "system",
                    reasoningEffort: /^grok-4\.5(?:$|-)/.test(args.modelId)
                      ? params.providerOptions?.openai?.reasoningEffort
                      : undefined,
                    reasoningSummary: "concise",
                    include: ["reasoning.encrypted_content"],
                  },
                },
              }
            : {
                ...params,
                headers: {
                  ...params.headers,
                  ...(await (async () => {
                    const credential = await this.credentials.openai.getValidCredential();
                    return {
                      authorization: `Bearer ${credential.access_token}`,
                      "ChatGPT-Account-Id": credential.account_id,
                    };
                  })()),
                },
                temperature: undefined,
                topP: undefined,
                maxOutputTokens: undefined,
                prompt: params.prompt.filter((message) => message.role !== "system"),
                providerOptions: {
                  ...params.providerOptions,
                  openai: {
                    ...params.providerOptions?.openai,
                    store: false,
                    instructions: params.prompt
                      .filter((message) => message.role === "system")
                      .map((message) => message.content)
                      .join("\n\n"),
                  },
                },
              },
      },
    });
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
