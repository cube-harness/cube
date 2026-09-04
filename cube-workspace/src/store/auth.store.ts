import { readFile } from "node:fs/promises";
import type { HomeManager } from "../home-manager.js";
import {
  CubeAuthSchema,
  type ApiKeyProvider,
  type CubeAuth,
  type OpenAISubscriptionCredential,
} from "../schemas/auth.schema.js";
import { atomicWriteFile } from "./atomic-write.js";

type AuthWriter = typeof atomicWriteFile;

export class AuthStore {
  constructor(
    private readonly home: HomeManager,
    private readonly writeFile: AuthWriter = atomicWriteFile,
  ) {}

  async read(): Promise<CubeAuth> {
    try {
      const raw = await readFile(this.home.getAuthPath(), "utf8");
      return CubeAuthSchema.parse(JSON.parse(raw));
    } catch {
      throw new Error("Invalid Cube authentication file.");
    }
  }

  async update(mutator: (current: CubeAuth) => CubeAuth): Promise<CubeAuth> {
    const next = CubeAuthSchema.parse(mutator(await this.read()));
    await this.writeFile(
      this.home.getAuthPath(),
      `${JSON.stringify(next, null, 2)}\n`,
      { mode: 0o600 },
    );
    return next;
  }

  async getApiKey(provider: ApiKeyProvider): Promise<string | undefined> {
    return (await this.read()).api_keys[provider]?.api_key;
  }

  async replaceApiKey(provider: ApiKeyProvider, apiKey: string): Promise<void> {
    await this.update((current) => ({
      ...current,
      api_keys: {
        ...current.api_keys,
        [provider]: { api_key: apiKey },
      },
    }));
  }

  async getOpenAISubscription(): Promise<OpenAISubscriptionCredential | undefined> {
    return (await this.read()).subscriptions.openai;
  }

  async replaceOpenAISubscription(
    credential: OpenAISubscriptionCredential,
  ): Promise<void> {
    await this.update((current) => ({
      ...current,
      subscriptions: {
        ...current.subscriptions,
        openai: credential,
      },
    }));
  }
}
