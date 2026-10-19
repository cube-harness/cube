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
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { EventSourceParserStream } from "eventsource-parser/stream";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const GROK_BUILD_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const GOOGLE_CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal";
export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal";
export const ANTIGRAVITY_HEADERS = {
  "user-agent": "antigravity/ide/2.11.0 darwin/arm64",
  "x-client-name": "antigravity",
  "x-client-version": "2.11.0",
  "x-request-source": "local",
};
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
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private readonly providers: Record<string, ProviderConfig> = Object.fromEntries(
    (
      [
        ["openai", "OpenAI", OPENAI_CODEX_BASE_URL],
        ["xai", "xAI", GROK_BUILD_BASE_URL],
        ["anthropic", "Anthropic", ANTHROPIC_BASE_URL],
        ["google", "Google (Antigravity)", ANTIGRAVITY_BASE_URL],
      ] as const
    ).map(([provider, name, url]) => [
      provider,
      {
        name,
        url,
        apiKeyEnvVar: [],
        gateway: this.id,
        npm:
          provider === "google"
            ? "@ai-sdk/google"
            : provider === "anthropic"
              ? "@ai-sdk/anthropic"
              : "@ai-sdk/openai",
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
    if (provider === "google") return `${config.url}:streamGenerateContent?alt=sse`;
    return `${config.url}/${provider === "anthropic" ? "messages" : "responses"}`;
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult> {
    let accessToken: string;
    let headers: Record<string, string>;
    if (request.providerId === "google") {
      if (!this.credentials.google)
        throw new Error("Google OAuth is not configured. Run /gateway to sign in.");
      accessToken = (await this.credentials.google.getValidCredential()).access_token;
      headers = { ...ANTIGRAVITY_HEADERS };
    } else if (request.providerId === "anthropic") {
      if (!this.credentials.anthropic)
        throw new Error("Anthropic OAuth is not configured. Run /gateway to sign in.");
      accessToken = (await this.credentials.anthropic.getValidCredential()).access_token;
      headers = { ...ANTHROPIC_OAUTH_HEADERS };
    } else if (request.providerId === "xai") {
      if (!this.credentials.xai)
        throw new Error("Grok Build is not configured. Run /gateway to sign in.");
      accessToken = (await this.credentials.xai.getValidCredential()).access_token;
      headers = { ...GROK_BUILD_HEADERS };
    } else {
      if (request.providerId !== "openai") throw new Error("Unsupported OAuth provider.");
      const credential = await this.credentials.openai.getValidCredential();
      accessToken = credential.access_token;
      headers = { "ChatGPT-Account-Id": credential.account_id };
    }
    return {
      bearerToken: accessToken,
      apiKey: accessToken,
      headers,
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
    if (args.providerId === "google") {
      // Keep the native SDK's tools/thought signatures/usage. Only adapt the Antigravity envelope.
      const sessionId = crypto.randomUUID();
      const trajectoryId = crypto.randomUUID();
      let step = 0;
      return createGoogleGenerativeAI({
        apiKey: args.apiKey,
        baseURL: ANTIGRAVITY_BASE_URL,
        fetch: async (input, init) => {
          if (!this.credentials.google)
            throw new Error("Google OAuth is not configured. Run /gateway to sign in.");
          const credential = await this.credentials.google.getValidCredential();
          init?.signal?.throwIfAborted();
          const stream = String(input).includes(":streamGenerateContent");
          const headers = new Headers(init?.headers);
          headers.delete("x-goog-api-key");
          headers.set("authorization", `Bearer ${credential.access_token}`);
          for (const [name, value] of Object.entries(ANTIGRAVITY_HEADERS)) headers.set(name, value);
          const response = await this.fetchImpl(
            `${ANTIGRAVITY_BASE_URL}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
            {
              ...init,
              headers,
              redirect: "error",
              body: JSON.stringify({
                project: credential.project_id,
                model: args.modelId,
                userAgent: "antigravity",
                requestType: "agent",
                requestId: `agent/${sessionId}/${Date.now()}/${trajectoryId}/${++step}`,
                request: { ...JSON.parse(String(init?.body)), sessionId },
              }),
            },
          );
          if (!response.ok || !response.body) return response;
          const unwrap = (value: unknown) => {
            if (!value || typeof value !== "object")
              throw new Error("Invalid Antigravity response.");
            const data = value as Record<string, unknown>;
            if (data.error) {
              const error = data.error as { message?: unknown };
              throw new Error(
                typeof error.message === "string" ? error.message : "Antigravity request failed.",
              );
            }
            if (!data.response || typeof data.response !== "object" || Array.isArray(data.response))
              throw new Error("Invalid Antigravity response.");
            return { responseId: data.traceId, ...data.response };
          };
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-length");
          responseHeaders.delete("content-encoding");
          if (!stream)
            return Response.json(unwrap(await response.json()), { headers: responseHeaders });
          const body = response.body
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream())
            .pipeThrough(
              new TransformStream({
                transform(event, controller) {
                  if (event.data === "[DONE]") return;
                  controller.enqueue(`data: ${JSON.stringify(unwrap(JSON.parse(event.data)))}\n\n`);
                },
              }),
            )
            .pipeThrough(new TextEncoderStream());
          return new Response(body, { headers: responseHeaders });
        },
      }).chat(args.modelId);
    }
    const delegate =
      this.delegate ??
      new ModelsDevGateway({
        [args.providerId]: {
          ...provider,
          models: [args.modelId],
          ...(args.providerId === "anthropic"
            ? {}
            : { modelOverrides: { [args.modelId]: { shape: "responses" as const } } }),
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
              prompt: [
                {
                  role: "system",
                  content: "You are Claude Code, Anthropic's official CLI for Claude.",
                },
                ...params.prompt,
              ],
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
