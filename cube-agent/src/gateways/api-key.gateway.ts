import type {
  GatewayAuthRequest,
  GatewayAuthResult,
  GatewayLanguageModel,
  MastraModelGatewayInterface,
  ProviderConfig,
} from "@mastra/core/llm";
import { wrapLanguageModel } from "ai";
import { ModelsDevGateway } from "@mastra/core/llm";
import type { AuthStore } from "@cube/workspace";
import { ApiKeyProviderSchema } from "@cube/workspace";

type ModelsDevDelegate = Pick<
  ModelsDevGateway,
  "fetchProviders" | "buildUrl" | "resolveLanguageModel"
>;

type ApiKeyReader = Pick<AuthStore, "getApiKey">;

export class CubeApiKeyGateway implements MastraModelGatewayInterface {
  readonly id = "cube-api";
  readonly name = "Cube API key";

  constructor(
    private readonly auth: ApiKeyReader,
    private readonly delegate: ModelsDevDelegate = new ModelsDevGateway(),
  ) {}

  handlesModel(modelId: string): boolean {
    return ApiKeyProviderSchema.safeParse(modelId.split("/")[0]).success;
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    const providers = await this.delegate.fetchProviders();
    return Object.fromEntries(
      ApiKeyProviderSchema.options.flatMap((id) =>
        providers[id] ? [[id, { ...providers[id], gateway: this.id }]] : [],
      ),
    );
  }

  buildUrl(
    routerId: string,
    envVars: Record<string, string>,
  ): string | undefined | Promise<string | undefined> {
    return this.delegate.buildUrl(
      routerId.startsWith(`${this.id}/`) ? routerId.slice(this.id.length + 1) : routerId,
      envVars,
    );
  }

  async resolveAuth(request: GatewayAuthRequest): Promise<GatewayAuthResult> {
    return {
      apiKey: await this.getApiKey(`${request.providerId}/${request.modelId}`),
      source: "gateway",
    };
  }

  async getApiKey(modelId: string): Promise<string> {
    const canonical = modelId.startsWith(`${this.id}/`)
      ? modelId.slice(this.id.length + 1)
      : modelId;
    const provider = ApiKeyProviderSchema.parse(canonical.split("/")[0]);
    const apiKey = await this.auth.getApiKey(provider);
    if (!apiKey) {
      throw new Error(`Missing API key for api_key/${provider}. Run /gateway to configure it.`);
    }
    return apiKey;
  }

  async resolveLanguageModel(args: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const model = await this.delegate.resolveLanguageModel(args);
    if (model.specificationVersion !== "v3") throw new Error("Unsupported API model adapter.");
    const fresh = async () => {
      const apiKey = await this.getApiKey(`${args.providerId}/${args.modelId}`);
      const resolved = await this.delegate.resolveLanguageModel({ ...args, apiKey });
      if (resolved.specificationVersion !== "v3") throw new Error("Unsupported API model adapter.");
      return resolved;
    };
    // Let each native provider format its own auth, including Google and Anthropic.
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        wrapGenerate: async ({ params }) => (await fresh()).doGenerate(params),
        wrapStream: async ({ params }) => (await fresh()).doStream(params),
      },
    });
  }

  serializeForSpan(): { id: string; name: string } {
    return { id: this.id, name: this.name };
  }
}
