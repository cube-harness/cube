import {
  OpenAISubscriptionCredentialSchema,
  type AuthStore,
  type OpenAISubscriptionCredential,
} from "@cube/workspace";
import type { OpenAISubscriptionCredentialProvider } from "@cube/agent";
import {
  beginOpenAILogin,
  refreshOpenAICredential,
  type OpenAILoginHandle,
  type OpenAIOAuthOptions,
} from "./openai.js";

type OpenAIAuthStore = Pick<
  AuthStore,
  "getOpenAISubscription" | "replaceOpenAISubscription"
>;

export class OpenAIAuthManager implements OpenAISubscriptionCredentialProvider {
  constructor(
    private readonly store: OpenAIAuthStore,
    private readonly options: OpenAIOAuthOptions = {},
  ) {}

  beginLogin(signal?: AbortSignal): Promise<OpenAILoginHandle> {
    return beginOpenAILogin(this.options, signal);
  }

  async commitOpenAISubscription(
    credential: OpenAISubscriptionCredential,
  ): Promise<void> {
    await this.store.replaceOpenAISubscription(
      OpenAISubscriptionCredentialSchema.parse(credential),
    );
  }

  async getValidCredential(): Promise<OpenAISubscriptionCredential> {
    const current = await this.store.getOpenAISubscription();
    if (!current) {
      throw new Error("OpenAI subscription is not configured. Run /gateway to sign in.");
    }

    const now = (this.options.now ?? Date.now)();
    if (current.expires_at > now + 5 * 60_000) return current;

    const refreshed = await refreshOpenAICredential(
      current,
      this.options.fetch,
      this.options.now,
    );
    await this.store.replaceOpenAISubscription(refreshed);
    return refreshed;
  }
}

export { OpenAIAuthManager as AuthManager };
